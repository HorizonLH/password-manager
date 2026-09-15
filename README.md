# SapVault

本地化的 Windows 密码管理工具，面向日常使用（尤其是 SAP 系统）的账号密码管理。
完全离线：没有账号体系、没有遥测、没有任何网络请求。

- 桌面框架：**Tauri 2**（Rust 后端 + WebView2 前端）
- 前端：**零依赖的原生 ES Module + CSS**（无 npm、无打包器），安装体积小、启动快
- 加密：**AES-256-GCM**；主密码模式使用 **Argon2id** 派生密钥，或使用 **Windows DPAPI** 封装随机密钥

---

## 1. 功能对照

| 需求 | 实现 |
| --- | --- |
| 1. Windows 桌面端、完全本地、Tauri 构建、轻量 UI | Tauri 2 + 原生前端（无 npm 依赖），数据只写在 `%APPDATA%\SapVault` |
| 2. 复制密码；SAP 账号可一次复制用户名 + 密码（换行） | 列表行、详情面板均提供复制按钮；SAP 条目额外提供「复制用户名 + 密码」，按 `CRLF` 拼成两行，可直接粘贴进 SAP GUI 登录界面 |
| 3. SAP 密码维护系统 ID | 条目表单中的系统信息区：系统 ID（必填，自动大写）、客户端、登录语言、系统名称 |
| 4. 全局 Knox ID，可在维护用户名时指定使用 | 侧边栏常驻 Knox ID 卡片；条目内勾选「使用全局 Knox ID」，用户名、复制与同步输出都会改用该值 |
| 5. 分类 + SAP 固定分类 + 全局配置同步 + 扫描 | 见下节 |
| 6. 暗色 / 亮色 / 跟随系统 | 标题栏主题按钮循环切换，设置页可选；`system` 模式实时跟随 Windows 主题 |

---

## 2. SAP 分类与同步（需求 5）

### 5.1 添加「需要同步的内容」文件

SAP 分类是固定分类（不可重命名 / 删除）。每个 SAP 账号下都有一组**关联内容文件**：

- 在账号详情面板点击「添加文件」手动选择；
- 或由扫描结果自动写入。

这些文件清单与账号信息一起参与同步，是「需要同步的内容」的载体。

### 5.2 按系统 ID 扫描 C 盘当前用户目录

流程与 `rust` 实现一致（`src-tauri/src/sap.rs`、`src-tauri/src/scanner.rs`）：

1. 读取 SAP GUI 登录配置 **`SAPUILandscape.xml`**（默认 `%APPDATA%\SAP\Common\`，
   并递归解析其中的 `<Includes>` 指向的 `SAPUILandscapeGlobal.xml`）；
2. 按系统 ID 找到对应连接，解析出**域名或 IP**；
3. 用这些主机/域名在**当前用户目录**（默认 `%USERPROFILE%`，可改）中扫描；
4. 文件必须**同时命中 系统 ID + 用户名 + 主机名/域名**（可在扫描页关闭严格模式，退化为「命中任意两项」）。

关于 `SAPUILandscape.xml` 需要特别注意的两点（实现中已处理）：

- **系统 ID 不唯一**。同一个 `systemid` 常出现多次（生产、沙箱、负载均衡入口、不同客户端），
  因此找到的所有连接都会参与扫描，主机名/域名会被合并。
- **主机名有三种来源**，按顺序全部解析：
  | 来源 | 示例 | 说明 |
  | --- | --- | --- |
  | `Service@server` | `prd.sap.corp.example:3200` | 直连应用服务器 |
  | `Service@msid` → `Messageserver@host` | `host="sapp20ms.corp.example"` | `server="SPACE"` 时的消息服务器登录 |
  | `Service@routerid` → `Router@router` | `/H/router.corp.example/S/3299` | 经 SAProuter 连接 |
  | `Service@url`（NWBC / FIORI） | `https://fiori.corp.example:8443/...` | Web 入口 |

除完整主机名外，还会生成父级域名（`de1saps331.euip.devcorp.net` → `euip.devcorp.net` → `devcorp.net`），
这样只写了公司域名的配置文件也能被找到。

扫描器默认只读取文本文件（自动跳过二进制、办公文档、缓存目录、`node_modules`、`.git` 等），
支持最大文件大小、最大文件数、最大目录深度限制，并可随时中止；结果里会给出命中位置与脱敏后的代码片段
（连续 24 字符以上的长串会被折叠成 `••••••`，避免把密码直接显示在屏幕上）。

### 5.3 关联关系的画面呈现

「关联关系」页面同时提供**卡片**与**表格**两种视图，逐一列出每个 SAP 账号与它关联的文件：

- 来源徽标：`手动` / `扫描`；
- 扫描命中的账号会展开**匹配证据**：命中的主机名、系统 ID、用户名，以及首次出现的行号；
- 统计条：账号总数、关联文件总数、其中来自扫描的数量、已失效（文件被删除）的数量。

### 5.4 写入全局配置（例如 MCP）

「同步配置」页面支持多个同步目标，每个目标 = 一个输出文件 + 一套模板：

- 内置模板：**MCP / JSON**、`.env`、TOML、YAML、CSV、纯文本；
- 写入前自动备份原文件（可关闭）；
- 内容未变化时跳过写入；
- 支持「预览」「写入文件」「全部写入」。

模板变量（可在界面点击插入）：

| 变量 | 说明 |
| --- | --- |
| `{{knoxId}}` | 全局 Knox ID |
| `{{accountCount}}` / `{{fileCount}}` | 账号数 / 关联文件数 |
| `{{accountsJson}}` / `{{filesJson}}` | 预渲染好的 JSON 数组（推荐用于 JSON 模板） |
| `{{#accounts}}…{{/accounts}}` | 逐个账号渲染；循环内可用 `{{systemId}} {{client}} {{language}} {{username}} {{password}} {{usernamePassword}} {{hosts}} {{title}} {{linkCount}} {{number}} {{isFirst}} {{isLast}}` |
| `{{^accounts}}…{{/accounts}}` | 账号为空时渲染 |
| `{{x|json}}` | 输出带引号的 JSON 字符串（写 JSON/TOML/YAML 时用它避免转义问题） |

---

## 3. 安全模型

- 保险库 = 单个加密文件 `%APPDATA%\SapVault\vault.sapvault`，
  内容为 `AES-256-GCM(KDF(master password) 或 DPAPI 封装密钥)`。
- **主密码模式**：Argon2id（m=19456 KiB, t=2, p=1）派生 32 字节密钥，盐值随机 16 字节。
- **仅本机账户模式**：随机 32 字节密钥由 Windows DPAPI 以当前用户身份封装，无需记忆密码。
- 主密码只在内存中用于派生密钥，派生结果用 `zeroize` 擦除；锁定或退出时会擦除内存中的密钥与密码。
- 空闲自动锁定（默认 10 分钟）由**后端线程**执行，即使窗口被隐藏或 WebView 暂停也不会失效。
- 剪贴板在复制后 N 秒自动清空（默认 30 秒，可关闭）；只有在剪贴板内容仍是本次写入的内容时才会清空。
- 保险库写入使用「先写临时文件再改名」，避免写入中断导致文件损坏；同时保留最近 10 个备份。
- 保险库文件损坏时会**明确报错**，不会伪装成「尚未创建」，以免误操作覆盖数据。

> 明文风险提示：保险库解密后的内容会经过 WebView 渲染。SapVault 不做进程级内存加密，
> 也无法防御已经取得你 Windows 账户权限的恶意软件——这是所有本地密码管理器的共同边界。

---

## 4. 数据与路径

| 内容 | 路径 |
| --- | --- |
| 保险库 | `%APPDATA%\SapVault\vault.sapvault` |
| 设置 | `%APPDATA%\SapVault\settings.json`（不含任何密钥） |
| 自动备份 | `%APPDATA%\SapVault\backups\vault-*.sapvault` |
| SAP 登录配置（读取） | `%APPDATA%\SAP\Common\SAPUILandscape.xml`、`…\SAPUILandscapeGlobal.xml` |

设置页可以查看这些路径、立即备份、导出/导入保险库。

---

## 5. 构建与运行

前置条件：Windows 10/11、[Rust](https://rustup.rs)（MSVC 工具链）、
[WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 已内置）。
前端不需要 Node.js。

```powershell
cd src-tauri
cargo test          # 运行后端单元测试（加密、XML 解析、扫描、模板渲染）
cargo build         # 构建调试版
cargo build --release
```

安装 Tauri CLI 后即可打包为安装程序：

```powershell
cargo install tauri-cli --version "^2"
cargo tauri dev
cargo tauri build    # 产出 NSIS 安装包
```

应用图标由 `src-tauri/build.rs` 在构建时**程序化生成**（纯 Rust，无第三方依赖，不使用压缩库），
因此仓库中不需要提交任何二进制图标文件。

---

## 6. 使用速览

1. 首次启动 → 选择解锁方式：
   - 「主密码」：设置 ≥8 位主密码（推荐，便于将来导出/迁移）；
   - 「仅本机账户」：不设密码，密钥由 Windows DPAPI 保管。
2. 侧边栏「SAP 系统」→ 重新解析 → 确认列出了你的系统与主机名。
3. 「新建条目」→ 分类选 SAP 账号 → 填写系统 ID，主机名会自动解析出来。
4. 需要以 Knox ID 登录的账号，勾选「使用全局 Knox ID」。
5. 「扫描文件」→ 选择账号（自动填入系统 ID / 用户名 / 主机名）→ 开始扫描 → 勾选结果 → 关联到账号。
6. 「关联关系」核对账号与文件的对应关系。
7. 「同步配置」→ 新建目标（例如 MCP / JSON）→ 设置输出路径 → 写入文件。

快捷键：`Ctrl+K` 聚焦搜索、`Ctrl+N` 新建条目、`Ctrl+L` 立即锁定。

---

## 7. 代码结构

```
src-tauri/src/
  lib.rs         Tauri 启动、命令注册、空闲自动锁定线程
  commands.rs    全部 IPC 命令（前端唯一入口）
  crypto.rs      Argon2id / AES-256-GCM / DPAPI / 口令生成与强度评估
  store.rs       保险库信封、设置文件、备份轮转、数据归一化
  model.rs       Vault / Entry / ContentLink / SyncTarget 等数据模型
  sap.rs         SAPUILandscape.xml 解析、主机名与域名解析
  scanner.rs     用户目录扫描（严格三条件匹配、脱敏摘要、可中止）
  sync.rs        同步上下文、模板引擎、内置模板、写盘与备份
ui/
  index.html
  styles/        tokens.css（设计变量）、app.css
  js/            app.js（外壳与路由）、state.js（状态与动作）、api.js、
                 views/（lock、accounts、editor、sap、scan、sync、
                 associations、settings）、icons.js、dom.js 等
```

UI 细节遵循一套统一的设计约束：同心圆角（内层圆角 = 外层圆角 − 间距）、
用分层半透明阴影表达层级而非画假边框、按压缩放固定 `0.96`、
只用 `currentColor` 着色图标（激活态才改用填充变体）、避免 `transition: all`，
并尊重系统的「减少动态效果」设置。

---

## 8. 已知边界

- 仅支持 Windows（DPAPI 与资源管理器集成依赖 Windows API）。
- 只解析 `SAPUILandscape.xml`（SAP GUI 7.40+ 及 Business Client）。
  仍在用旧版 `saplogon.ini` 的环境需要在设置中手动指定配置文件，或先迁移到 XML。
- 扫描基于文本内容匹配，不解析加密/压缩文件，也不扫描浏览器凭据数据库（SQLite，二进制）。
- 同步是「渲染后写入」，不会合并已有的 JSON；因此建议开启备份，或把目标指向 SapVault 专属文件。
