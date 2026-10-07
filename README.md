<div align="center">

# VisualSSH

**让远程文件操作，像本地一样优雅。**

Tauri 2 + Vue 3 + 纯 Rust SSH 协议栈打造的 Windows 桌面 SSH 文件管理器

[功能特性](#功能特性) · [快速开始](#快速开始) · [技术栈](#技术栈) · [项目结构](#项目结构) · [设计语言](#设计语言) · [路线图](#路线图)

[![License](https://img.shields.io/badge/license-MIT-0078D4)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-FFC131)](https://v2.tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-%E2%89%A5%201.82-DEA584)](https://www.rust-lang.org)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)](https://github.com/ItzAoneHax/VisualSSH)

</div>

---

## 定位

远程文件工具很多，但要么界面停留在上个时代，要么把文件管理当作附属功能。VisualSSH 的目标只有一个：**把远程文件当作本地文件对待** —— 浏览、编辑、传输、复制粘贴，一个窗口完成。

## 功能特性

### 连接管理
- 密码 / 私钥（含口令）两种认证方式，保存前可一键测试连通性
- 多连接档案统一管理；密码与私钥口令加密存储（见「安全」）

### 文件浏览
- SFTP 目录列表：列头排序、隐藏文件显隐、内联过滤搜索
- Windows 资源管理器式地址栏：面包屑、手填路径、提示列表、后退 / 前进（Alt+←/→）与刷新
- 多选体系与资源管理器语义一致：单击单选、Ctrl 反选、Shift 范围、橡皮筋框选、批量删除

### 文件操作
- 空白处右键就地新建文件夹 / 文件，F2 就地重命名，删除前确认对话框
- chmod 权限修改对话框；可选「单击打开」「双击空白处返回上级」

### 传输中心
- 拖拽系统文件直接上传，悬停时强调色虚线覆盖层提示目标目录
- 右键「下载到…」弹出系统保存对话框
- 64 KB 分块流式传输，实时进度、可取消、历史记录；Fluent 浮层面板，状态栏常驻入口

### 内置编辑器
- CodeMirror 6 语法高亮（JSON / YAML / Markdown / Python 等）
- 保存走临时文件 + rename 原子写回；Markdown 双击默认预览，「预览 / 源码」分段切换

### 内置终端
- 复用当前 SSH 会话的 PTY 通道（xterm-256color），xterm.js 渲染、自适应尺寸
- 悬浮全页模糊窗体，字号可调，主题跟随应用

### 跨端文件剪贴板
- 远端 `Ctrl+C` → 本地 `Ctrl+V`：OLE 虚拟文件（FILEDESCRIPTORW / FILECONTENTS），**粘贴时才真正下载**
- 本地 `Ctrl+C` → 远端 `Ctrl+V`：读取系统剪贴板文件列表（CF_HDROP）直接上传

### 安全
- known_hosts TOFU 策略：首次连接自动记录指纹，指纹变更拒绝连接并要求人工确认
- 密码 / 私钥口令存入 Windows 凭据管理器（DPAPI 加密），不落明文
- 设置中心可查看与移除已知主机、已存凭据

### 设置中心
- 外观：深色 / 浅色 / 跟随系统；应用背景色与背景图（不透明度、契合方式、对齐）
- 偏好：默认排序列与方向、排序优先级、大小进制（1024 / 1000）、删除确认、状态栏显隐、终端字号

## 快速开始

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（需 WebView2 运行时） |
| Node.js | ≥ 20.19 |
| Rust | stable 工具链 ≥ 1.82 |

```bash
git clone https://github.com/ItzAoneHax/VisualSSH.git
cd VisualSSH
npm install

npm run tauri dev    # 开发调试（前端热重载）
```

生产构建：

```bash
npm run build        # 前端类型检查（vue-tsc）+ 构建
npm run exe          # 一键 release 构建并把单文件 VisualSSH.exe 复制到根目录（约 7 MB）
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3 · TypeScript · Pinia · Tailwind CSS 4 · Vite 8 |
| 终端 | xterm.js 6（+ fit addon） |
| 编辑器 | CodeMirror 6 · markdown-it |
| 桌面壳 | Tauri 2 · Rust（edition 2021）· tokio |
| SSH 协议 | russh + russh-sftp —— 纯 Rust 实现，无 OpenSSL 依赖 |
| 系统集成 | keyring（Windows 凭据管理器）· windows crate（OLE 虚拟文件）· tauri-plugin-dialog |

## 项目结构

```
src/                      前端（Vue 3 + Pinia）
├── api/                  Tauri 命令薄封装，与 Rust 端一一对应
├── components/
│   ├── common/           菜单、模态框、标题栏等基础件
│   ├── connection/       连接卡片与连接表单
│   ├── explorer/         文件表、面包屑、权限对话框
│   ├── settings/         设置分区与通用控件
│   └── workspace/        编辑器、终端、传输中心
├── stores/               连接 / 文件 / 传输 / 编辑器 / 终端 / 设置
└── views/                连接管理器 · 工作区 · 设置

src-tauri/src/            Rust 核心
├── ssh/                  会话管理、SFTP 文件系统、known_hosts（TOFU）
├── terminal.rs           PTY 通道管理
├── transfer.rs           分块流式传输引擎
├── clipboard_vfile.rs    OLE 虚拟文件 DataObject
└── commands/             Tauri 命令层（ssh / transfer / terminal / clipboard / credentials）
```

## 设计语言

界面深度对齐 Windows 11 Fluent / WinUI 设计，交互与视觉大量参考开源文件管理器 [Files](https://github.com/files-community/Files)：

- 无系统边框的自绘标题栏；主题首帧注入，暗色模式无闪白
- 编辑器与终端采用悬浮全页模糊窗体，与主界面分层
- 状态栏常驻连接状态与传输指示
- 明暗主题跟随系统，背景色 / 背景图可自定义

## 路线图

- [x] 连接管理 + SFTP 文件浏览（TOFU、凭据加密）
- [x] 文件操作（新建 / 重命名 / 删除 / chmod）
- [x] 传输中心（拖拽上传、下载、进度、取消）
- [x] 内置编辑器（CodeMirror 6 + Markdown 预览）
- [x] 内置终端（PTY + xterm.js）
- [x] 多选体系 + 跨端文件剪贴板（虚拟文件）+ 地址栏搜索
- [x] 设置中心（外观 / 偏好 / 安全 / 关于）
- [ ] macOS / Linux 适配（虚拟文件剪贴板目前依赖 Windows OLE）
- [ ] 多标签页 / 双栏布局
- [ ] 远端文件内容搜索
- [ ] 传输断点续传
- [ ] SSH 端口转发

## 贡献

欢迎 Issue 与 PR。提交信息遵循中文 Conventional Commits（`feat(scope): 描述`）。

## 许可证

[MIT](LICENSE) © VisualSSH Contributors
