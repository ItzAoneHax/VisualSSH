<div align="center">

<img src="public/favicon.svg" width="72" alt="VisualSSH" />

# VisualSSH

**远程文件，本地体验。**

一个现代化的开源跨平台远程文件管理工具 —— 把 SSH/SFTP 服务器上的文件系统，
变成像 Finder / Windows 11 资源管理器一样优雅流畅的可视化界面。

[![License: MIT](https://img.shields.io/badge/License-MIT-5B8CFF.svg)](LICENSE)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-9B8BFF.svg)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org)

</div>

---

## 为什么做 VisualSSH

- **命令行不直观**：`scp` / `sftp` 对非专家门槛高，误操作风险大；
- **传统 GUI 陈旧**：FileZilla、WinSCP 界面老派、交互割裂，缺少本地文件管理器的流畅感；
- **VisualSSH 的答案**：暗黑/明亮双主题的现代化 UI、类本地文件浏览体验、传输中心、
  就地编辑器与一键终端 —— 打破远程与本地的界限。

## 当前能力（M2 · 文件操作与安全基座）

- ✅ 现代化连接管理器：卡片式布局、一键「测试连接」（含延迟）、快速登入，支持密码 / 私钥认证
- ✅ 可视化文件浏览器：面包屑路径、快速跳转、目录列表（大小 / 权限 / 修改时间）、显示/隐藏点文件
- ✅ 完整文件操作：新建文件夹/文件（就地命名）、重命名（F2）、删除（Delete，二次确认）、修改权限（3×3 勾选 + rwx/八进制实时预览）
- ✅ 安全基座：known_hosts TOFU（首次信任自动记录，指纹变更弹确认）、密码/私钥口令加密存于系统凭据存储（Windows 凭据管理器）
- ✅ 暗黑 / 明亮主题一键切换，中文界面

## 路线图

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 连接管理器 + 根目录浏览 | ✅ |
| M2 | 文件操作（新建/重命名/删除/权限）、known_hosts 校验（TOFU）、凭据加密存储 | ✅ |
| M3 | 拖拽上传下载 + 常驻传输中心（进度/速度/队列） | 🔜 |
| M4 | 内置轻量编辑器（文本/JSON/YAML/Log 就地预览与安全回写） | 🔜 |
| M5 | 一键唤醒内置 SSH 终端（xterm.js，自动 cd 到当前目录） | 🔜 |

## 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面外壳 | **Tauri 2** | 极致性能与小体积，跨 Windows / macOS / Linux |
| 前端 UI | **Vue 3 + TypeScript + Vite** | 组合式 API，类型安全 |
| 样式 | **Tailwind CSS 4** | 语义化 token，暗黑/明亮双主题 |
| SSH/SFTP | **russh + russh-sftp**（Rust，纯 Rust 实现） | 无 OpenSSL 依赖，天然跨平台，async 高并发 |
| 状态 | **Pinia** | 连接池与浏览器的响应式状态 |

## 目录结构

```
VisualSSH/
├── index.html                  # Vite 入口（含防主题闪白的内联脚本）
├── package.json / vite.config.ts / tsconfig.json
├── public/favicon.svg          # 应用标识（❯ 渐变折角箭头）
├── scripts/generate-icons.mjs  # 应用图标生成器（纯 Node，无依赖）
├── src/                        # ── 前端（Vue 3）──
│   ├── main.ts                 # 应用入口
│   ├── App.vue                 # 连接管理器 ⇄ 工作区 视图切换
│   ├── assets/styles/main.css  # Tailwind 4 + 语义色板 + 组件类
│   ├── types/index.ts          # 与 Rust 端一一对应的共享类型
│   ├── api/ssh.ts              # Tauri invoke 薄封装（唯一 IPC 通道）
│   ├── stores/
│   │   ├── connections.ts      # 连接配置 CRUD、测试、登入状态
│   │   └── explorer.ts         # 当前目录、条目、加载/错误状态
│   ├── views/
│   │   ├── ConnectionManager.vue   # 连接管理器（卡片墙）
│   │   └── Workspace.vue           # 工作区（顶栏/侧栏/列表/状态栏）
│   └── components/
│       ├── connection/         # ConnectionCard / ConnectionForm
│       ├── explorer/           # Breadcrumbs / FileTable
│       └── common/             # Modal / ThemeToggle
└── src-tauri/                  # ── 桌面外壳 + Rust 核心 ──
    ├── Cargo.toml / build.rs / tauri.conf.json
    ├── capabilities/default.json   # 最小权限声明
    ├── icons/                      # 应用图标（脚本生成）
    └── src/
        ├── main.rs / lib.rs        # 入口 & 命令注册
        ├── error.rs                # 可序列化到前端的统一错误
        ├── state.rs                # 全局会话池（connection_id → SSH 会话）
        ├── ssh/
        │   ├── session.rs          # russh 连接/认证/SFTP 通道封装
        │   └── fs.rs               # 目录读取 → FileEntry 映射与排序
        └── commands/ssh.rs         # ssh_connect / ssh_test / ssh_list_dir / ssh_disconnect
```

## 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 含 npm |
| Rust | stable（≥ 1.82） | 经 [rustup](https://rustup.rs) 安装；Windows 需选 MSVC 工具链（需 VS Build Tools + Windows SDK） |
| WebView2 | — | Windows 10/11 一般已内置 |

### 运行

```bash
npm install        # 安装前端依赖
npm run tauri dev  # 启动开发模式（自动拉起 Vite 与 Rust 核心）
```

### 构建发布包

```bash
npm run tauri build   # 产物在 src-tauri/target/release/bundle/（含安装器）
```

### 打包单文件 exe（推荐日常使用方式）

```bash
npm run exe
```

该命令完成「前端构建 → Rust release 编译」后，把可独立运行的
**`VisualSSH.exe`（项目根目录）** 复制出来 —— 双击即可使用，无需安装；
连接配置保存在本机，与开发模式共用同一份数据。

> 运行要求：Windows 10/11 自带的 WebView2 运行时（系统默认已有）。

### 第一阶段验收路径

1. 打开应用 → 「新建连接」填入主机 / 端口 / 用户名 / 密码（或私钥路径）→ 保存；
2. 点卡片上的「测试连接」，看到绿色延迟（如 `42 ms`）即链路健康；
3. 点「连接」进入工作区，根目录 `/` 的文件列表加载完成 —— M1 核心链路跑通。

## 安全说明

- 密码与私钥口令存于操作系统加密凭据存储（Windows 凭据管理器 / DPAPI；
  macOS Keychain、Linux libsecret 随平台支持跟进），`localStorage` 只保留非敏感配置。
  旧版本遗留的明文凭据会在启动时自动迁移进加密存储并清除。
- 主机密钥采用 TOFU（Trust On First Use）：首次连接自动记录公钥指纹
  （SHA256，存于 `%APPDATA%/visualssh/known_hosts`）；指纹变更时拒绝连接，
  弹出对比确认框，由用户决定是否信任新密钥。
- 所有通信经标准 SSH2/SFTP 加密通道，VisualSSH 不经手任何第三方服务器。

## License

[MIT](LICENSE) © VisualSSH Contributors
