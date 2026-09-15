# SapVault

本地化的 Windows 密码管理工具，面向日常使用（尤其是 SAP 系统）的账号密码管理。
完全离线：没有账号体系、没有遥测、没有任何网络请求。

- 桌面框架：**Tauri 2**（Rust 后端 + WebView2 前端）
- 前端：**零依赖的原生 ES Module + CSS**（无 npm、无打包器）
- 加密：**AES-256-GCM**；主密码模式使用 **Argon2id** 派生密钥，或使用 **Windows DPAPI** 封装随机密钥

---

## 1. 功能对照

| 需求 | 实现 |
| --- | --- |
| 1. Windows 桌面端、完全本地、Tauri 构建、轻量 UI | Tauri 2 + 原生前端（无 npm 依赖），数据只写在 `%APPDATA%\SapVault` 或便携目录 |
| 2. 复制密码；SAP 账号可一次复制用户名 + 密码（换行） | 列表行、详情面板均提供复制按钮；SAP 条目额外提供「复制用户名 + 密码」，按 `CRLF` 拼成两行，可直接粘贴进 SAP GUI 登录界面 |
| 3. SAP 密码维护系统 ID | 条目表单中的系统信息区：系统 ID（必填，自动大写）、客户端、登录语言，并从登录配置解析系统名称与主机名 |
| 4. 全局 Knox ID，可在维护用户名时指定使用 | 侧边栏常驻 Knox ID 卡片；条目内勾选「使用全局 Knox ID」，用户名、复制与同步输出都会改用该值 |
| 5. 分类 + SAP 固定分类 + 全局配置同步 + 关联文件 | 见第 2 节 |
| 6. 暗色 / 亮色 / 跟随系统 | 标题栏主题按钮循环切换，设置页可选；`system` 模式实时跟随 Windows 主题 |
| 额外：密码规则 | 每个条目可单独设置规则，或不设置；设置页可配置「默认规则」 |
| 额外：密码循环与历史 | 每个条目可设置循环周期（例如 5），自动记录历史密码并在保存时拦截重复 |
| 额外：锁屏 / 重启后重新解锁 | 保险库启动即锁定；`Win+L` 锁屏后立即锁定（可关闭） |

---

## 2. SAP 分类、关联内容与同步（需求 5）

### 2.1 添加「需要同步的内容」文件

SAP 分类是固定分类（不可重命名 / 删除）。每个 SAP 账号下都有一组**关联内容文件**，
由你手动选择（没有磁盘扫描），文件就是「需要同步的内容」。

### 2.2 支持的格式与字段解析

支持 6 种格式，其余一律按纯文本处理：

| 格式 | 识别方式 | 说明 |
| --- | --- | --- |
| JSON | `.json` / `.jsonc` | 递归展开嵌套对象与数组，路径形如 `sap.production.url` |
| .env | `.env`、`.env.*`、`*.env` | `KEY=VALUE`，支持 `export` 前缀、单双引号、`#` 注释 |
| TOML | `.toml` `.ini` `.conf` `.cfg` `.properties` | 支持 `[section]` 与 `key = value`，路径形如 `sap.auth.password` |
| YAML | `.yaml` / `.yml` | 按缩进构建路径，忽略列表项与注释 |
| XML | `.xml` `.plist` `.config` `.resx` | 同时读取元素文本与属性（属性路径形如 `connection@host`） |
| 纯文本 | 其它扩展名 | 识别 `key=value`、`key: value`，并识别裸写的 `http(s)://` 链接 |

解析后会给出 **URL / 用户名 / 密码** 三个字段（命中的键名与行号）。

### 2.3 上传时检查字段，缺失可指定关键词

添加文件时会先「试解析」，弹窗里逐文件显示识别结果：

- 已识别：显示值（密码打点）、命中的键名、所在行号；
- 未识别：提示缺失，并在下方给出**关键词输入框**，可填写该字段在文件中的键名，
  点「重新检测」立即生效；也可以「恢复默认关键词」或「套用其它文件的关键词」。

确认后才会写入保险库。之后随时可以在详情面板重新编辑关键词或重新检测。

关键词匹配规则：默认忽略大小写、允许包含匹配（`sap_password` 能匹配 `password`，
但会优先选择更精确的键名，例如 `username` 优先于 `user`）；设置页可改为「必须完全一致」，
并可修改全局默认关键词。

### 2.4 关联关系的画面呈现

「关联关系」页面提供**卡片**与**表格**两种视图，逐一列出每个 SAP 账号与它关联的文件，
并把每个文件解析出的 URL / 用户名 / 密码一并展示（可复制、可查看命中键名）；
顶部统计账号数、文件数、字段不完整的文件数、已失效（文件被删除）的文件数。

### 2.5 写入全局配置（例如 MCP）

「同步配置」页面支持多个同步目标，每个目标 = 一个输出文件 + 一套模板：

- 内置模板：**MCP / JSON**、**凭据清单 (JSON)**、`.env`、TOML、YAML、CSV、纯文本；
- 写入前自动备份原文件（可关闭）；内容未变化时跳过写入；
- 支持「预览」「写入文件」「全部写入」。

账号字段为空时，同步会自动使用关联文件中解析到的值（`effectiveUrl` /
`effectiveUsername` / `effectivePassword`），因此只要文件里有凭据，账号记录可以很简洁。

模板变量（可在界面点击插入）：

| 变量 | 说明 |
| --- | --- |
| `{{knoxId}}` | 全局 Knox ID |
| `{{accountCount}}` / `{{fileCount}}` | 账号数 / 关联文件数 |
| `{{accountsJson}}` / `{{filesJson}}` | 预渲染好的 JSON 数组（推荐用于 JSON 模板） |
| `{{#accounts}}…{{/accounts}}` | 逐个账号渲染；可用 `{{systemId}} {{client}} {{language}} {{username}} {{effectiveUrl}} {{effectiveUsername}} {{effectivePassword}} {{usernamePassword}} {{hosts}} {{title}} {{linkCount}} {{ruleSummary}}` |
| `{{#sources}}…{{/sources}}` | 账号内逐个关联文件渲染；可用 `{{path}} {{label}} {{format}} {{url}} {{username}} {{password}}` |
| `{{^accounts}}…{{/accounts}}` | 账号为空时渲染 |
| `{{x\|json}}` | 输出带引号的 JSON 字符串（写 JSON/TOML/YAML 时用它避免转义问题） |

---

## 3. 密码规则与密码循环

### 3.1 密码规则（可加，也可以不加）

每个条目都可以选择「使用规则」或「不设置规则」：

- 规则参数：最小 / 最大长度、大小写字母、数字、符号、可用符号集合、禁用字符、
  是否必须首字符为字母、是否排除易混淆字符，以及规则名称（备注）；
- 「按规则生成密码」一键生成合规密码，生成的密码保证每个启用的字符类至少出现一次；
- 保存时会校验密码并列出**具体**违规原因（例如「缺少数字」「包含禁用字符：@」）；
- 如果确实要保存不合规的密码（例如记录历史遗留口令），弹窗会提供「仍然保存」。

设置页可以配置**默认规则**：新建条目时自动带上，仍可在条目里单独修改或取消。

### 3.2 密码循环与历史密码

SAP 系统通常会记住最近若干个密码并拒绝重复，因此：

- 每个条目可设置**循环周期 N**（0 = 不校验）。保存时会检查新密码是否与
  「当前密码 + 最近 N-1 个历史密码」重复，命中则提示并允许「仍然保存」；
- 修改密码时**自动记录**旧密码（含时间与「密码变更时自动记录」备注）；
- 可以**手动补录**以前用过的密码并写备注；
- 详情面板与编辑弹窗都能列出历史密码，逐条显示 / 隐藏、复制、删除，或整体清空；
  列表会标注哪些属于「循环内」（系统仍会拒绝），哪些是「更早」的。

---

## 4. 锁定策略

| 触发 | 行为 |
| --- | --- |
| 启动 / 重启 / 关机再打开 | 保险库一定是锁定状态，必须重新解锁（密钥从不明文落盘） |
| `Win+L` 锁屏 / 屏保锁定 / UAC 安全桌面 | 后端每 5 秒检测一次输入桌面，检测到锁定立即锁定保险库（可在设置中关闭） |
| 空闲 | 默认 10 分钟无操作自动锁定（可关闭或调整） |
| 手动 | 侧边栏「锁定保险库」、快捷键 `Ctrl+L`、设置页「立即锁定」 |

锁定时会清除内存中的密钥与明文密码（`zeroize`）。

> 注意：**「仅本机账户」模式没有密码可输入**——它的密钥由 Windows DPAPI 保管，
> 解锁时点击一次按钮即可。若你要求「锁屏 / 重启后必须输入主密码」，
> 请使用**主密码模式**，或在设置 → 安全里为现有保险库「设置主密码」。

---

## 5. 安全模型

- 保险库 = 单个加密文件 `vault.sapvault`，内容为
  `AES-256-GCM(KDF(master password) 或 DPAPI 封装密钥)`。
- **主密码模式**：Argon2id（m=19456 KiB, t=2, p=1）派生 32 字节密钥，盐值随机 16 字节。
- **仅本机账户模式**：随机 32 字节密钥由 Windows DPAPI 以当前用户身份封装，无需记忆密码。
- 主密码只在内存中用于派生密钥，派生结果用 `zeroize` 擦除；锁定或退出时擦除内存中的密钥与密码。
- 空闲与锁屏检测由**后端线程**执行，即使窗口被隐藏或 WebView 暂停也不会失效。
- 剪贴板在复制后 N 秒自动清空（默认 30 秒，可关闭）；只有内容仍是本次写入的才清空。
- 保险库写入使用「先写临时文件再改名」，避免写入中断导致文件损坏；同时保留最近 10 个备份。
- 保险库文件损坏时会**明确报错**，不会伪装成「尚未创建」，以免误操作覆盖数据。

> 明文风险提示：保险库解密后的内容会经过 WebView 渲染。SapVault 不做进程级内存加密，
> 也无法防御已经取得你 Windows 账户权限的恶意软件——这是所有本地密码管理器的共同边界。

---

## 6. 数据位置与便携模式

| 内容 | 默认路径 |
| --- | --- |
| 保险库 | `%APPDATA%\SapVault\vault.sapvault` |
| 设置 | `%APPDATA%\SapVault\settings.json`（不含任何密钥） |
| 自动备份 | `%APPDATA%\SapVault\backups\vault-*.sapvault` |
| SAP 登录配置（只读） | `%APPDATA%\SAP\Common\SAPUILandscape.xml`、`…\SAPUILandscapeGlobal.xml` |

### 便携（绿色）模式

在 `sapvault.exe` 旁边放一个 `portable.txt` 文件（或者直接建一个 `SapVaultData` 文件夹），
程序就会把所有数据写进同目录的 `SapVaultData\`，不再接触用户目录 —— 适合放 U 盘随身携带。

---

## 7. 构建与运行

前置条件：Windows 10/11、[Rust](https://rustup.rs)（MSVC 工具链）、
[WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 已内置，
Win10 一般随 Edge 安装；缺失时可装 Evergreen 引导程序）。
前端不需要 Node.js。

```powershell
cd src-tauri
cargo test           # 64 个后端单元测试：加密、DPAPI、解析、规则、历史、模板
cargo build --release
```

产物 `src-tauri\target\release\sapvault.exe` 是**单文件、免安装**的：MSVC 运行库已静态链接
（见 `src-tauri/.cargo/config.toml`），除系统 DLL 外只依赖 WebView2。

需要安装包时：

```powershell
cargo install tauri-cli --version "^2"
cargo tauri build     # 产出 NSIS 安装包
```

前端自检（不需要浏览器，用 Node 执行所有视图）：

```powershell
node tools/check-ui.mjs
```

应用图标由 `src-tauri/build.rs` 在构建时**程序化生成**（纯 Rust，自带 PNG/ICO 编码器），
因此仓库中不需要任何图标工具链。

---

## 8. 使用速览

1. 首次启动 → 选择解锁方式：
   - 「主密码」：设置 ≥8 位主密码（推荐：锁屏 / 重启后都要输入密码）；
   - 「仅本机账户」：不设密码，密钥由 Windows DPAPI 保管，解锁时点一下按钮。
2. 侧边栏「SAP 系统」→ 重新解析 → 确认列出了你的系统与主机名。
3. 「新建条目」→ 分类选 SAP 账号 → 填系统 ID → 需要时开启密码规则、设置循环周期。
4. 需要以 Knox ID 登录的账号，勾选「使用全局 Knox ID」。
5. 在账号详情里「添加文件」，选择要同步的配置文件 → 在弹窗里确认解析结果，
   缺字段时填关键词重新检测 → 关联到账号。
6. 「关联关系」核对账号、文件与解析出的凭据。
7. 「同步配置」→ 新建目标（例如 MCP / JSON）→ 设置输出路径 → 预览 → 写入文件。

快捷键：`Ctrl+K` 聚焦搜索、`Ctrl+N` 新建条目、`Ctrl+L` 立即锁定。

---

## 9. 代码结构

```
src-tauri/src/
  lib.rs         Tauri 启动、命令注册、空闲 / 锁屏守护线程
  commands.rs    全部 IPC 命令（前端唯一入口）
  crypto.rs      Argon2id / AES-256-GCM / DPAPI / 口令强度
  rules.rs       密码规则：合规生成与违规检查
  keys.rs        内容文件解析：JSON / .env / TOML / YAML / XML / 文本 → URL/用户名/密码
  store.rs       保险库信封、设置文件、备份轮转、便携模式、数据归一化
  model.rs       Vault / Entry / PasswordRule / HistoryEntry / ContentLink / KeyMapping
  sap.rs         SAPUILandscape.xml 解析（含 Includes 递归与重复系统 ID 合并）
  sync.rs        同步上下文、模板引擎、内置模板、写盘与备份
ui/
  index.html
  styles/        tokens.css（设计变量）、app.css
  js/            app.js（外壳与路由）、state.js（状态与动作）、api.js、theme.js …
  js/views/      lock / accounts / editor / linkkeys / sap / sync / associations / settings
tools/
  check-ui.mjs   在 Node 中执行全部视图的冒烟测试
```

UI 细节遵循一套统一约束：同心圆角（内层圆角 = 外层圆角 − 间距）、
用分层半透明阴影表达层级而非画假边框、按压缩放固定 `0.96`、
只用 `currentColor` 着色图标（激活态才改用填充变体）、避免 `transition: all`，
并尊重系统的「减少动态效果」设置。

---

## 10. 已知边界

- 仅支持 Windows（DPAPI、锁屏检测与资源管理器集成依赖 Windows API）。
- 只解析 `SAPUILandscape.xml`（SAP GUI 7.40+ 及 Business Client）；
  仍在使用旧版 `saplogon.ini` 的环境需要在设置中手动指定配置文件。
- 字段解析基于键名匹配与格式遍历，不解析加密 / 压缩文件；
  复杂格式（例如多行 YAML 块标量）建议直接在界面上指定关键词。
- 同步是「渲染后写入」，不会合并已有 JSON；请保留备份，或把目标指向 SapVault 专属文件。
- 便携模式依赖打包时的 `portable.txt` 标记，不会自动把已有数据从 `%APPDATA%` 迁移过来。
