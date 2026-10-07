use russh_sftp::client::fs::ReadDir;
use russh_sftp::protocol::FileType;
use serde::Serialize;

/// 传给前端的文件条目，字段与 src/types/index.ts 的 FileEntry 对应。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// dir | file | symlink | other
    pub kind: &'static str,
    pub size: u64,
    /// 形如 drwxr-xr-x
    pub permissions: String,
    /// Unix 秒级时间戳
    pub mtime: Option<i64>,
    /// 属主名；服务器未返回名字时回退 uid 数字，两者皆无则 null
    pub owner: Option<String>,
    /// 组名；回退规则同 owner
    pub group: Option<String>,
    /// 访问时间（Unix 秒级）；SFTP v3 无创建时间
    pub atime: Option<i64>,
}

pub(crate) fn to_file_entries(read_dir: ReadDir) -> Vec<FileEntry> {
    let mut entries: Vec<FileEntry> = read_dir
        .map(|entry| {
            let kind = match entry.file_type() {
                FileType::Dir => "dir",
                FileType::File => "file",
                FileType::Symlink => "symlink",
                _ => "other",
            };
            let metadata = entry.metadata();
            FileEntry {
                name: entry.file_name(),
                kind,
                size: metadata.size.unwrap_or(0),
                permissions: mode_string(metadata.permissions, kind),
                mtime: metadata.mtime.map(|t| t as i64),
                owner: metadata
                    .user
                    .clone()
                    .or_else(|| metadata.uid.map(|u| u.to_string())),
                group: metadata
                    .group
                    .clone()
                    .or_else(|| metadata.gid.map(|g| g.to_string())),
                atime: metadata.atime.map(|t| t as i64),
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();

    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// 把 SFTP 返回的八进制权限位渲染为 rwx 字符串。
fn mode_string(permissions: Option<u32>, kind: &str) -> String {
    const RWX: [char; 3] = ['r', 'w', 'x'];
    let type_char = match kind {
        "dir" => 'd',
        "symlink" => 'l',
        "file" => '-',
        _ => '?',
    };
    let mode = permissions.unwrap_or(0);
    let mut out = String::with_capacity(10);
    out.push(type_char);
    for shift in [6u32, 3, 0] {
        for (i, c) in RWX.iter().enumerate() {
            let bit = shift * 3 + (2 - i as u32);
            out.push(if mode & (1 << bit) != 0 {
                *c
            } else {
                '-'
            });
        }
    }
    out
}
