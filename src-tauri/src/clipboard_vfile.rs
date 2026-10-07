//! 远端 → 本地「粘贴时才下载」虚拟文件剪贴板（FileZilla 式）。
//!
//! 复制瞬间只做 OleSetClipboard(自实现 IDataObject)，零下载、零暂存目录；
//! 资源管理器 Ctrl+V 时才经 GetData(CFSTR_FILECONTENTSW) 取回 IStream，
//! Read 惰性打开 SFTP 只读句柄、按调用方请求的尺寸流式拉取。
//!
//! 线程模型：OLE STA。Explorer 的跨套间调用被列集到调用 OleSetClipboard 的
//! 线程，因此该线程必须常驻并泵消息 —— 这里是一条专线程 + GetMessage 泵，
//! 命令经 PostThreadMessageW(WM_APP) 唤醒后从通道取走。

use std::cell::{Cell, RefCell};
use std::mem::{size_of, ManuallyDrop};
use std::ptr;
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::runtime::Handle as RtHandle;
use tokio::sync::oneshot;
use windows::core::{implement, Error as WinError, Result as WinResult};
use windows::Win32::Foundation::{
    DV_E_FORMATETC, E_NOTIMPL, E_OUTOFMEMORY, E_POINTER, FILETIME, GlobalFree, LPARAM, S_FALSE,
    S_OK, STG_E_INVALIDPARAMETER, STG_E_READFAULT, WPARAM,
};
use windows::Win32::System::Com::{
    CoTaskMemAlloc, DVASPECT_CONTENT, FORMATETC, IEnumFORMATETC, IEnumFORMATETC_Impl,
    ISequentialStream_Impl, IStream, IStream_Impl, IDataObject, IDataObject_Impl, STATFLAG_DEFAULT,
    STGMEDIUM, STGMEDIUM_0, STATSTG, STREAM_SEEK, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
    DATADIR_GET, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::OleSetClipboard;
use windows::Win32::UI::Shell::{
    CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FILEDESCRIPTORW, FILEGROUPDESCRIPTORW,
    FD_ATTRIBUTES, FD_FILESIZE, FD_PROGRESSUI, FD_WRITESTIME,
};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG,
    TranslateMessage, WM_APP};

use russh_sftp::client::fs::File as RemoteFile;
use std::io::SeekFrom;

use crate::error::{Error, Result};
use crate::state::SessionHandle;

/// 虚拟文件清单条目（前端 FileEntry 直传：复制瞬间无需访问网络）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualFileEntry {
    pub name: String,
    pub size: u64,
    /// Unix 秒；None 则描述符不带时间戳（Explorer 落盘用当前时间）
    pub mtime: Option<i64>,
}

/// FILEDESCRIPTORW.cFileName 的容量（宽字符，含结尾 NUL）。
const MAX_NAME_UNITS: usize = 260;
/// FD_* 未覆盖的零散字面量：普通文件属性（win32 FILE_ATTRIBUTE_ARCHIVE）。
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
/// STGTY_STREAM（STATSTG.type）：流对象。
const STGTY_STREAM: u32 = 2;

// ---------------------------------------------------------------------------
// 常驻 OLE STA 线程
// ---------------------------------------------------------------------------

enum OleCommand {
    /// 构造虚拟文件 DataObject 并 OleSetClipboard；结果经 oneshot 回传
    Set {
        session: SessionHandle,
        remote_dir: String,
        entries: Vec<VirtualFileEntry>,
        rt: RtHandle,
        reply: oneshot::Sender<Result<()>>,
    },
}

struct OleThread {
    tx: Sender<OleCommand>,
    /// Win32 线程 ID：命令入队后 PostThreadMessageW(WM_APP) 唤醒消息泵
    tid: u32,
}

static OLE_THREAD: OnceLock<OleThread> = OnceLock::new();

/// 取常驻 OLE 线程句柄；首次调用时完成 OleInitialize 与格式注册。
fn ole_thread() -> &'static OleThread {
    OLE_THREAD.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<OleCommand>();
        let (init_tx, init_rx) = mpsc::channel::<Result<u32>>();
        std::thread::Builder::new()
            .name("visualssh-ole-clipboard".into())
            .spawn(move || run_ole_thread(rx, init_tx))
            .expect("启动 OLE 剪贴板线程失败");
        match init_rx.recv() {
            Ok(Ok(tid)) => OleThread { tx, tid },
            Ok(Err(e)) => panic!("OLE 剪贴板不可用: {e}"),
            Err(_) => panic!("OLE 剪贴板线程启动即退出"),
        }
    })
}

/// STA 线程主体：OleInitialize → 注册格式 → 消息泵（阻塞在 GetMessage，
/// COM 发送消息在等待期间即被分发；WM_APP 唤醒后清空命令通道）。
fn run_ole_thread(rx: mpsc::Receiver<OleCommand>, init: mpsc::Sender<Result<u32>>) {
    // OleInitialize 把本线程定为 STA（剪贴板对象跨套间调用的必要条件）
    if let Err(e) = unsafe { windows::Win32::System::Ole::OleInitialize(None) } {
        let _ = init.send(Err(Error::Clipboard(format!("OleInitialize 失败: {e}"))));
        return;
    }
    let tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    let (fmt_descriptor, fmt_contents) = unsafe {
        let d = windows::Win32::System::DataExchange::RegisterClipboardFormatW(
            CFSTR_FILEDESCRIPTORW,
        );
        let c =
            windows::Win32::System::DataExchange::RegisterClipboardFormatW(CFSTR_FILECONTENTS);
        (d, c)
    };
    if fmt_descriptor == 0 || fmt_contents == 0 {
        let _ = init.send(Err(Error::Clipboard("注册虚拟文件剪贴板格式失败".into())));
        return;
    }
    if init.send(Ok(tid)).is_err() {
        return;
    }

    let mut msg = MSG::default();
    'pump: loop {
        let r = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        match r.0 {
            // 0 = WM_QUIT（进程退出路径）；-1 = GetMessage 出错
            0 | -1 => break 'pump,
            _ => {}
        }
        // WM_APP 是线程消息（hwnd 为空）：仅作唤醒 ping，不派发
        if !msg.hwnd.is_invalid() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                OleCommand::Set {
                    session,
                    remote_dir,
                    entries,
                    rt,
                    reply,
                } => {
                    let result = set_clipboard(
                        session,
                        remote_dir,
                        entries,
                        rt,
                        fmt_descriptor,
                        fmt_contents,
                    );
                    let _ = reply.send(result);
                }
            }
        }
    }
}

/// 命令入口（异步）：把虚拟文件清单送上 OLE 剪贴板。复制瞬间零网络流量。
pub async fn set_virtual_files(
    session: SessionHandle,
    remote_dir: String,
    entries: Vec<VirtualFileEntry>,
) -> Result<()> {
    if entries.is_empty() {
        return Err(Error::Clipboard("剪贴板至少需要一个文件".into()));
    }
    for e in &entries {
        if e.name.is_empty() || e.name.contains('/') || e.name.contains('\\') {
            return Err(Error::Clipboard(format!("文件名不合法: {}", e.name)));
        }
        // cFileName 容量 260 宽字符（含 NUL）；超长名 Explorer 也无法落盘
        if e.name.encode_utf16().count() >= MAX_NAME_UNITS {
            return Err(Error::Clipboard(format!("文件名过长: {}", e.name)));
        }
    }

    let t = ole_thread();
    let (reply_tx, reply_rx) = oneshot::channel();
    t.tx
        .send(OleCommand::Set {
            session,
            remote_dir,
            entries,
            rt: RtHandle::current(),
            reply: reply_tx,
        })
        .map_err(|_| Error::Clipboard("OLE 剪贴板线程已退出".into()))?;
    // 唤醒消息泵；发送失败说明线程已亡，由 oneshot 回收错误
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
            t.tid,
            WM_APP,
            WPARAM(0),
            LPARAM(0),
        );
    }
    reply_rx
        .await
        .map_err(|_| Error::Clipboard("OLE 剪贴板线程无响应".into()))?
}

/// 在 STA 线程上执行：构造 DataObject → OleSetClipboard。
/// 剪贴板持有对象引用；被替换/清空时 Release 归零、对象析构，SFTP 资源随流对象各自回收。
fn set_clipboard(
    session: SessionHandle,
    remote_dir: String,
    entries: Vec<VirtualFileEntry>,
    rt: RtHandle,
    fmt_descriptor: u32,
    fmt_contents: u32,
) -> Result<()> {
    let obj: IDataObject = VirtualFileDataObject {
        session,
        remote_dir,
        entries,
        rt,
        fmt_descriptor,
        fmt_contents,
    }
    .into();
    unsafe { OleSetClipboard(&obj) }
        .map_err(|e| Error::Clipboard(format!("写入 OLE 剪贴板失败: {e}")))
}

// ---------------------------------------------------------------------------
// IDataObject：FILEDESCRIPTORW（HGLOBAL 清单）+ FILECONTENTS（按 lindex 出 IStream）
// ---------------------------------------------------------------------------

#[implement(IDataObject)]
struct VirtualFileDataObject {
    session: SessionHandle,
    remote_dir: String,
    entries: Vec<VirtualFileEntry>,
    rt: RtHandle,
    fmt_descriptor: u32,
    fmt_contents: u32,
}

impl IDataObject_Impl for VirtualFileDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
        let fe = unsafe { &*pformatetcin };
        if self.matches(fe) {
            if fe.cfFormat as u32 == self.fmt_descriptor {
                return self.descriptor_medium();
            }
            let idx = fe.lindex as usize;
            let entry = &self.entries[idx];
            // IStream 的所有权移交调用方（ReleaseStgMedium 负责 Release）
            let stream: IStream = SftpReadStream {
                session: self.session.clone(),
                remote_path: join_remote(&self.remote_dir, &entry.name),
                name: entry.name.clone(),
                total: entry.size,
                rt: self.rt.clone(),
                pos: Cell::new(0),
                file: RefCell::new(StreamFile::Unopened),
            }
            .into();
            let mut medium = zeroed_medium();
            medium.tymed = TYMED_ISTREAM.0 as u32;
            medium.u = STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            };
            return Ok(medium);
        }
        Err(WinError::from(DV_E_FORMATETC))
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> WinResult<()> {
        // 调用方自备缓冲的形式不支持：请走 GetData
        Err(WinError::from(E_NOTIMPL))
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> windows::core::HRESULT {
        // 探测语义比 GetData 宽：FILECONTENTS 的 lindex=-1（"任一文件"）也放行
        let fe = unsafe { &*pformatetc };
        let probe = |lindex_ok: bool| {
            fe.dwAspect == DVASPECT_CONTENT.0
                && (lindex_ok
                    || (fe.lindex >= 0 && (fe.lindex as usize) < self.entries.len()))
        };
        if fe.cfFormat as u32 == self.fmt_descriptor
            && (fe.tymed & TYMED_HGLOBAL.0 as u32) != 0
            && probe(false)
        {
            return S_OK;
        }
        if fe.cfFormat as u32 == self.fmt_contents
            && (fe.tymed & TYMED_ISTREAM.0 as u32) != 0
            && probe(true)
        {
            return S_OK;
        }
        DV_E_FORMATETC
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> windows::core::HRESULT {
        // 无规范化形式：零值回填并报 DV_E_FORMATETC（DATA_E_FORMATETC 同值）
        unsafe { *pformatetcout = FORMATETC::default() };
        DV_E_FORMATETC
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: windows::core::BOOL,
    ) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(WinError::from(E_NOTIMPL));
        }
        let descriptor = FORMATETC {
            cfFormat: self.fmt_descriptor as u16,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let contents = FORMATETC {
            cfFormat: self.fmt_contents as u16,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_ISTREAM.0 as u32,
        };
        Ok(FormatEnum {
            items: [descriptor, contents],
            pos: Cell::new(0),
        }
        .into())
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: windows::core::Ref<'_, windows::Win32::System::Com::IAdviseSink>,
    ) -> WinResult<u32> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn DUnadvise(&self, _dwconnection: u32) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn EnumDAdvise(&self) -> WinResult<windows::Win32::System::Com::IEnumSTATDATA> {
        Err(WinError::from(E_NOTIMPL))
    }
}

impl VirtualFileDataObject_Impl {
    /// FORMATETC 匹配：格式 + 纵横比 + 传输介质（lindex 仅对 FILECONTENTS 有意义）
    fn matches(&self, fe: &FORMATETC) -> bool {
        if fe.dwAspect != DVASPECT_CONTENT.0 {
            return false;
        }
        if fe.cfFormat as u32 == self.fmt_descriptor && (fe.tymed & TYMED_HGLOBAL.0 as u32) != 0 {
            return true;
        }
        fe.cfFormat as u32 == self.fmt_contents
            && (fe.tymed & TYMED_ISTREAM.0 as u32) != 0
            && fe.lindex >= 0
            && (fe.lindex as usize) < self.entries.len()
    }

    /// FILEGROUPDESCRIPTORW → HGLOBAL（所有权移交调用方，由 ReleaseStgMedium 释放）。
    /// FILEGROUPDESCRIPTORW 是 packed(1)，任何字段都只能经裸指针写，禁止取引用。
    fn descriptor_medium(&self) -> WinResult<STGMEDIUM> {
        let n = self.entries.len();
        let bytes = size_of::<FILEGROUPDESCRIPTORW>() + (n - 1) * size_of::<FILEDESCRIPTORW>();
        let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }
            .map_err(|_| WinError::from(E_OUTOFMEMORY))?;
        let base = unsafe { GlobalLock(hglobal) } as *mut u8;
        if base.is_null() {
            unsafe {
                let _ = GlobalFree(Some(hglobal));
            }
            return Err(WinError::from(E_OUTOFMEMORY));
        }
        unsafe {
            ptr::write_bytes(base, 0, bytes);
            ptr::write(base as *mut u32, n as u32);
            // fgd 紧随 cItems（偏移 4）
            let fgd = base.add(size_of::<u32>()) as *mut FILEDESCRIPTORW;
            for (i, e) in self.entries.iter().enumerate() {
                let d = fgd.add(i);
                // FD_FLAGS 未实现位运算，按内部 u32 组合
                let mut flags =
                    (FD_ATTRIBUTES.0 | FD_FILESIZE.0 | FD_PROGRESSUI.0) as u32;
                if let Some(unix) = e.mtime {
                    flags |= FD_WRITESTIME.0 as u32;
                    (*d).ftLastWriteTime = unix_to_filetime(unix);
                }
                (*d).dwFlags = flags;
                (*d).dwFileAttributes = FILE_ATTRIBUTE_ARCHIVE;
                (*d).nFileSizeHigh = (e.size >> 32) as u32;
                (*d).nFileSizeLow = (e.size as u32) & 0xffff_ffff;
                let units: Vec<u16> = e.name.encode_utf16().chain(std::iter::once(0)).collect();
                ptr::copy_nonoverlapping(
                    units.as_ptr(),
                    ptr::addr_of_mut!((*d).cFileName) as *mut u16,
                    units.len(),
                );
            }
            let _ = GlobalUnlock(hglobal);
        }
        let mut medium = zeroed_medium();
        medium.tymed = TYMED_HGLOBAL.0 as u32;
        medium.u = STGMEDIUM_0 { hGlobal: hglobal };
        Ok(medium)
    }
}

/// STGMEDIUM 的 Default 实现被额外 feature 门控；这里统一零值起手再覆写字段。
/// pUnkForRelease 保持 None：HGLOBAL/IStream 的释放责任交还调用方（ReleaseStgMedium）。
fn zeroed_medium() -> STGMEDIUM {
    STGMEDIUM {
        tymed: 0,
        u: STGMEDIUM_0 {
            hGlobal: windows::Win32::Foundation::HGLOBAL::default(),
        },
        pUnkForRelease: ManuallyDrop::new(None),
    }
}

/// Unix 秒 → FILETIME（100ns 单位，1601 纪元）。
fn unix_to_filetime(unix_secs: i64) -> FILETIME {
    const UNIX_TO_WIN_EPOCH_SECS: i64 = 11_644_473_600;
    let ticks = (unix_secs.max(0) + UNIX_TO_WIN_EPOCH_SECS) as u64 * 10_000_000;
    FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    }
}

// ---------------------------------------------------------------------------
// IEnumFORMATETC：两个静态格式的前向枚举
// ---------------------------------------------------------------------------

#[implement(IEnumFORMATETC)]
struct FormatEnum {
    items: [FORMATETC; 2],
    pos: Cell<usize>,
}

impl IEnumFORMATETC_Impl for FormatEnum_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> windows::core::HRESULT {
        if rgelt.is_null() {
            return E_POINTER;
        }
        let want = celt as usize;
        let mut got = 0usize;
        while got < want && self.pos.get() < self.items.len() {
            unsafe { *rgelt.add(got) = self.items[self.pos.get()] };
            self.pos.set(self.pos.get() + 1);
            got += 1;
        }
        if !pceltfetched.is_null() {
            unsafe { *pceltfetched = got as u32 };
        }
        if got == want {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Skip(&self, celt: u32) -> WinResult<()> {
        self.pos.set((self.pos.get() + celt as usize).min(self.items.len()));
        Ok(())
    }

    fn Reset(&self) -> WinResult<()> {
        self.pos.set(0);
        Ok(())
    }

    fn Clone(&self) -> WinResult<IEnumFORMATETC> {
        Ok(FormatEnum {
            items: self.items,
            pos: Cell::new(self.pos.get()),
        }
        .into())
    }
}

// ---------------------------------------------------------------------------
// IStream：SFTP 只读句柄的流式桥（惰性打开、粘滞失败）
// ---------------------------------------------------------------------------

enum StreamFile {
    Unopened,
    Open(RemoteFile),
    /// 打开/读取已失败（连接断开等）：后续 Read 一律报错，Explorer 中止复制
    Failed,
}

#[implement(IStream)]
struct SftpReadStream {
    session: SessionHandle,
    remote_path: String,
    name: String,
    total: u64,
    rt: RtHandle,
    pos: Cell<u64>,
    file: RefCell<StreamFile>,
}

impl SftpReadStream_Impl {
    /// 惰性打开远端句柄。会话锁只在打开的一瞬持有（与 transfer.rs 同一纪律），
    /// 之后裸读不占锁，浏览/其他传输不受影响。
    fn ensure_open(&self) -> bool {
        let mut st = self.file.borrow_mut();
        match &*st {
            StreamFile::Open(_) => true,
            StreamFile::Failed => false,
            StreamFile::Unopened => {
                let opened = self.rt.block_on(async {
                    let s = self.session.session.lock().await;
                    s.open_read(&self.remote_path).await
                });
                match opened {
                    Ok(f) => {
                        *st = StreamFile::Open(f);
                        true
                    }
                    Err(_) => {
                        *st = StreamFile::Failed;
                        false
                    }
                }
            }
        }
    }
}

impl ISequentialStream_Impl for SftpReadStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> windows::core::HRESULT {
        if pv.is_null() || pcbread.is_null() {
            return E_POINTER;
        }
        unsafe { *pcbread = 0 };
        if cb == 0 {
            return S_OK;
        }
        let remaining = self.total.saturating_sub(self.pos.get());
        if remaining == 0 {
            // 描述符宣称的大小已读满（含空文件）→ EOF，无需触碰网络
            return S_OK;
        }
        let want = (cb as u64).min(remaining) as usize;
        let dst = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, want) };
        if !self.ensure_open() {
            return STG_E_READFAULT;
        }
        let result = {
            let mut st = self.file.borrow_mut();
            match &mut *st {
                StreamFile::Open(f) => self.rt.block_on(f.read(dst)),
                _ => unreachable!("ensure_open 后必为 Open"),
            }
        };
        match result {
            Ok(0) => S_OK,
            Ok(n) => {
                self.pos.set(self.pos.get() + n as u64);
                unsafe { *pcbread = n as u32 };
                S_OK
            }
            Err(_) => {
                *self.file.borrow_mut() = StreamFile::Failed;
                STG_E_READFAULT
            }
        }
    }

    fn Write(
        &self,
        _pv: *const core::ffi::c_void,
        _cb: u32,
        _pcbwritten: *mut u32,
    ) -> windows::core::HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for SftpReadStream_Impl {
    fn Seek(
        &self,
        dlibmove: i64,
        dworigin: STREAM_SEEK,
        plibnewposition: *mut u64,
    ) -> WinResult<()> {
        let origin = dworigin.0;
        let base = if origin == STREAM_SEEK_SET.0 {
            0i128
        } else if origin == STREAM_SEEK_CUR.0 {
            self.pos.get() as i128
        } else if origin == STREAM_SEEK_END.0 {
            self.total as i128
        } else {
            return Err(WinError::from(STG_E_INVALIDPARAMETER));
        };
        let new = base + dlibmove as i128;
        if new < 0 || new > u64::MAX as i128 {
            return Err(WinError::from(STG_E_INVALIDPARAMETER));
        }
        let new = new as u64;
        // 已打开的句柄走 SFTP positioned seek；未打开时仅记账（首读即从该偏移起）
        let mut st = self.file.borrow_mut();
        if let StreamFile::Open(f) = &mut *st {
            if self.rt.block_on(f.seek(SeekFrom::Start(new))).is_err() {
                drop(st);
                *self.file.borrow_mut() = StreamFile::Failed;
                return Err(WinError::from(STG_E_READFAULT));
            }
        }
        drop(st);
        self.pos.set(new);
        if !plibnewposition.is_null() {
            unsafe { *plibnewposition = new };
        }
        Ok(())
    }

    fn SetSize(&self, _libnewsize: u64) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn CopyTo(
        &self,
        _pstm: windows::core::Ref<'_, IStream>,
        _cb: u64,
        _pcbread: *mut u64,
        _pcbwritten: *mut u64,
    ) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn Commit(&self, _grfcommitflags: &windows::Win32::System::Com::STGC) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn Revert(&self) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn LockRegion(
        &self,
        _liboffset: u64,
        _cb: u64,
        _dwlocktype: &windows::Win32::System::Com::LOCKTYPE,
    ) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> WinResult<()> {
        Err(WinError::from(E_NOTIMPL))
    }

    fn Stat(
        &self,
        pstatstg: *mut STATSTG,
        grfstatflag: &windows::Win32::System::Com::STATFLAG,
    ) -> WinResult<()> {
        if pstatstg.is_null() {
            return Err(WinError::from(E_POINTER));
        }
        unsafe { ptr::write_bytes(pstatstg as *mut u8, 0, size_of::<STATSTG>()) };
        let s = unsafe { &mut *pstatstg };
        // STATFLAG_DEFAULT（=0）时要名字：CoTaskMemAlloc 分配、由调用方释放；
        // STATFLAG_NO_NAME（=1）则跳过（crate 未导出该常量，按 DEFAULT 判定）
        if grfstatflag.0 == STATFLAG_DEFAULT.0 {
            let units: Vec<u16> = self.name.encode_utf16().chain(std::iter::once(0)).collect();
            let p = unsafe { CoTaskMemAlloc(units.len() * 2) } as *mut u16;
            if !p.is_null() {
                unsafe { ptr::copy_nonoverlapping(units.as_ptr(), p, units.len()) };
                s.pwcsName = windows::core::PWSTR(p);
            }
        }
        s.r#type = STGTY_STREAM;
        s.cbSize = self.total;
        Ok(())
    }

    fn Clone(&self) -> WinResult<IStream> {
        Err(WinError::from(E_NOTIMPL))
    }
}

/// 拼接远程路径（根目录单独处理，避免 //x）。
fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}
