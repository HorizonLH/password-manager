# SapVault

本地化的 Windows 密码管理工具，面向日常使用（尤其是 SAP 系统）的账号密码管理。
完全离线：没有账号体系、没有遥测、没有任何网络请求。

- 桌面框架：**Tauri 2**（Rust 后端 + WebView2 前端）
- 前端：**零依赖的原生 ES Module + CSS**（无 npm、无打包器）
- 加密：**AES-256-GCM**；主密码模式使用 **Argon2id** 派生密钥，或使用 **Windows DPAPI** 封装随机密钥

---

## 1. 功能一览

| 能力 | 说明 |
| --- | --- |
| 账号与密码 | 任意分类下的账号；本地加密保存，详情面板可复制用户名/密码 |
| SAP 换行复制 | SAP 分类的账号提供「复制用户名 + 密码」，按 `CRLF` 拼成两行，可直接粘贴进 SAP GUI 登录界面 |
| 全局 Knox ID | 侧边栏常驻；条目勾选「使用全局 Knox ID」后，用户名、复制与同步输出都改用该值 |
| 分类 | SAP 为固定分类（不可重命名/删除），另有通用分类与自定义分类 |
| 同步内容文件 | 账号下挂载 JSON、`.env`、TOML、YAML、XML 或纯文本文件，自动解析出 URL / 用户名 / 密码 |
| 关键词可指定 | 解析不到的字段可以让用户指定关键词，逐文件覆盖，可随时重新检测 |
| 全局配置同步 | 把账号与解析结果按模板写入 MCP/JSON、`.env`、TOML、YAML、CSV 或纯文本文件 |
| 密码规则 | 每个条目可加规则，也可以完全不加；支持按规则生成与校验 |
| 密码循环与历史 | 设置循环周期（例如 5），自动记录历史密码并拦截重复 |
| 主题 | 暗色 / 亮色 / 跟随系统 |
| 锁定 | 启动、锁屏（Win+L）、空闲、手动都会锁定；解锁前内存中没有明文 |
| 便携模式 | exe 旁放 `portable.txt` 即把所有数据写在同目录，适合 U 盘携带 |

> 关于最初的「维护 SAP 系统 ID + 读取 SAPUILandscape.xml + 扫描磁盘」需求：
> 按后续确认，这三项**已全部移除**。账号身份改由同步文件里的 URL 表达，
> 关联关系由用户在界面上的选择确定。

---

## 2. 同步流程（当前设计）

### 2.1 先选账号，再添加文件

1. 打开要同步的 SAP 账号；
2. 在详情面板点击「添加文件」，选择该账号对应的配置文件
   （JSON、`.env`、TOML、YAML、XML 或纯文本）；
3. SapVault 按固定规则解析文件，弹出确认窗口显示每个文件里识别到的
   **URL / 用户名 / 密码**（含命中的键名与行号）；
4. 若某个字段没找到，可直接在弹窗里为它填写关键词并「重新检测」，
   也可以套用其它文件的关键词或恢复默认；
5. 确认后写入保险库，之后随时可以调整关键词或重新检测。

### 2.2 解析规则

| 格式 | 识别方式 | 说明 |
| --- | --- | --- |
| JSON | `.json` / `.jsonc` | 递归展开嵌套对象与数组，路径形如 `sap.production.url` |
| .env | `.env`、`.env.*`、`*.env` | `KEY=VALUE`，支持 `export` 前缀、单双引号、`#` 注释 |
| TOML | `.toml` `.ini` `.conf` `.cfg` `.properties` | 支持 `[section]`，路径形如 `sap.auth.password` |
| YAML | `.yaml` / `.yml` | 按缩进构建路径 |
| XML | `.xml` `.plist` `.config` `.resx` | 元素文本与属性都会读取（属性形如 `connection@host`） |
| 纯文本 | 其它扩展名 | 识别 `key=value`、`key: value`，并识别裸写的 `http(s)://` 链接 |

关键词匹配：默认忽略大小写、允许包含匹配（`sap_password` 能匹配 `password`，
但优先选择更精确的键名，例如 `username` 优先于 `user`）；设置页可改为「必须完全一致」，
并可修改全局默认关键词（默认 URL：`url/uri/link/endpoint/host/server/address`；
用户名：`username/user/login/account/sap_user`；密码：`password/passwd/pwd/secret`）。

### 2.3 关联关系的呈现

「关联关系」页面用**卡片**与**表格**两种视图列出每个 SAP 账号与它的同步文件，
并展示每个文件解析出的 URL / 用户名 / 密码（可复制、可见命中键名）；
顶部统计账号数、文件数、字段不完整的文件数、已失效（文件被删除）的文件数。

### 2.4 写入全局配置（例如 MCP）

「同步配置」页面支持多个目标，每个目标 = 一个输出文件 + 一套模板：

- 内置模板：**MCP / JSON**、**凭据清单 (JSON)**、`.env`、TOML、YAML、CSV、纯文本；
- 写入前自动备份原文件（可关闭）；内容未变化时跳过写入；
- 支持「预览」「写入文件」「全部写入」，写入后弹出提示。

账号字段为空时，同步会自动使用关联文件中解析到的值（`effectiveUrl` /
`effectiveUsername` / `effectivePassword`），所以账号记录可以填得很简单。

模板变量（界面点击即可插入）：

| 变量 | 说明 |
| --- | --- |
| `{{knoxId}}` | 全局 Knox ID |
| `{{accountCount}}` / `{{fileCount}}` | 账号数 / 源文件数 |
| `{{accountsJson}}` / `{{filesJson}}` | 预渲染好的 JSON 数组 |
| `{{#accounts}}…{{/accounts}}` | 逐个账号渲染：`{{title}} {{slug}} {{number}} {{username}} {{password}} {{effectiveUrl}} {{effectiveUsername}} {{effectivePassword}} {{usernamePassword}} {{linkCount}} {{ruleSummary}}` |
| `{{#sources}}…{{/sources}}` | 账号内逐个文件渲染：`{{path}} {{label}} {{format}} {{url}} {{username}} {{password}} {{complete}}` |
| `{{^accounts}}…{{/accounts}}` | 账号为空时渲染 |
| `{{x\|json}}` | 输出带引号的 JSON 字符串（写 JSON/TOML/YAML 时用它避免转义问题） |

---

## 3. 密码规则与密码循环

**密码规则（可加，也可以不加）**：每个条目都可以选择「使用规则」或「不使用规则」。
规则包含长度上下限、大小写/数字/符号、可用符号集、禁用字符、首字符必须为字母、
排除易混淆字符，以及规则名称。可「按规则生成密码」（保证每个启用的字符类至少出现一次），
保存时校验并列出**具体**违规原因；确实要保存不合规密码时可以「仍然保存」。
设置页可配置**默认规则**，新建条目时自动带上。

**密码循环与历史**：SAP 系统通常会记住最近若干个密码并拒绝重复，因此：

- 每个条目可设置**循环周期 N**（0 = 不校验）；保存时检查新密码是否与
  「当前密码 + 最近 N-1 个历史密码」重复，命中则提示并允许「仍然保存」；
- 修改密码时**自动记录**旧密码；也可以**手动补录**以前用过的密码并写备注；
- 详情面板与编辑弹窗都能列出历史密码：显示/隐藏、复制、删除、清空，
  并标注哪些属于「循环内」（系统仍会拒绝），哪些「更早」。

---

## 4. 锁定策略

| 触发 | 行为 |
| --- | --- |
| 启动 / 重启 / 关机再打开 | 保险库一定是锁定状态（密钥从不明文落盘） |
| `Win+L` 锁屏 / 屏保锁定 / UAC 安全桌面 | 后端每 5 秒检测一次输入桌面，检测到锁定立即锁定（可关闭） |
| 空闲 | 默认 10 分钟无操作自动锁定（可关闭或调整） |
| 手动 | 侧边栏「锁定保险库」、`Ctrl+L`、设置页「立即锁定」 |

锁定时清除内存中的密钥、密码与历史密码（`zeroize`）。

> **「仅本机账户」模式没有密码可输入**：它的密钥由 Windows DPAPI 保管，解锁时点一下按钮即可。
> 若要求「锁屏 / 重启后必须输入主密码」，请使用**主密码模式**，
> 或在设置 → 锁定与剪贴板里为现有保险库「设置主密码」。

---

## 5. 安全模型

- 保险库 = 单个加密文件 `vault.sapvault`，内容为
  `AES-256-GCM(KDF(master password) 或 DPAPI 封装密钥)`。
- **主密码模式**：Argon2id（m=19456 KiB, t=2, p=1）派生 32 字节密钥，盐值随机 16 字节。
- **仅本机账户模式**：随机 32 字节密钥由 Windows DPAPI 以当前用户身份封装。
- 主密码只在内存中用于派生密钥；锁定或退出时擦除内存中的密钥与密码。
- 空闲与锁屏检测在**后端线程**执行，窗口隐藏或 WebView 暂停也不会失效。
- 剪贴板在复制后 N 秒自动清空（默认 30 秒，可关闭）；只有内容仍是本次写入的才清空。
- 保险库写入使用「先写临时文件再改名」；保留最近 10 个备份。
- 保险库文件损坏时**明确报错**，不会伪装成「尚未创建」。

> 明文风险提示：保险库解密后的内容会经过 WebView 渲染。SapVault 不做进程级内存加密，
> 也无法防御已经取得你 Windows 账户权限的恶意软件——这是所有本地密码管理器的共同边界。

---

## 6. 数据位置与便携模式

| 内容 | 默认路径 |
| --- | --- |
| 保险库 | `%APPDATA%\SapVault\vault.sapvault` |
| 设置 | `%APPDATA%\SapVault\settings.json`（不含任何密钥） |
| 自动备份 | `%APPDATA%\SapVault\backups\vault-*.sapvault` |

在 `sapvault.exe` 旁边放一个 `portable.txt`（或直接建一个 `SapVaultData` 文件夹），
程序就会把所有数据写进同目录的 `SapVaultData\`，不再接触用户目录。

---

## 7. 构建、运行与自检

前置条件：Windows 10/11、[Rust](https://rustup.rs)（MSVC 工具链）、
[WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)
（Win11 已内置，Win10 一般随 Edge 安装）。前端不需要 Node.js。

```powershell
cd src-tauri
cargo test           # 后端单元测试：加密、DPAPI、解析、关键词、规则、历史、模板
cargo build --release
```

产物 `src-tauri\target\release\sapvault.exe` 是**单文件、免安装**的：
MSVC 运行库已静态链接（见 `src-tauri/.cargo/config.toml`），
除系统 DLL 外只依赖 WebView2。需要安装包时用 `cargo install tauri-cli --version "^2"` +
`cargo tauri build` 生成 NSIS 安装程序。

应用图标由 `src-tauri/build.rs` 在构建时程序化生成（纯 Rust，自带 PNG/ICO 编码器）。

### UI 自检工具

布局不是靠肉眼猜的：`tools/` 下有一套可复现的 UI 审计工具。
它用一个静态服务器加载 `ui/`，注入桩 IPC（`tools/ui-fixtures.js`），
再通过 DevTools 协议驱动 Edge（与 WebView2 同一个引擎）逐页测量。

```powershell
pwsh tools/audit-ui.ps1 -WithModals                                     # 含弹窗的完整审计
pwsh tools/audit-ui.ps1 -Sizes 1000x660,1240x800,1600x900,1920x1080    # 多窗口尺寸
pwsh tools/audit-ui.ps1 -Sizes 1240x800 -ShotView 设置                  # 附带字符画截图
```

审计检查：外壳是否铺满窗口、每页是否有横向溢出、是否有元素超出窗口、
文字是否被裁切、容器里是否有大片空白、字号是否过小、页面是否意外产生滚动条、
页面是否有未捕获的运行时异常，以及每个页面/弹窗该出现的内容是否都在。
`tools/ascii-shot.ps1` 还能把截图渲染成字符画，便于在终端里粗略审阅版式。

---

## 8. 使用速览

1. 首次启动 → 选择解锁方式（主密码 / 仅本机账户）。
2. 「新建条目」→ 填标题、分类（SAP 账号）、用户名（可勾选全局 Knox ID）、密码；
   需要时打开密码规则与循环周期。
3. 在账号详情里「添加文件」，选择要同步的配置文件 → 在弹窗里核对解析结果，
   缺字段时填关键词重新检测 → 关联到账号。
4. 「关联关系」核对账号、文件与解析出的凭据。
5. 「同步配置」→ 新建目标（例如 MCP / JSON）→ 设置输出路径 → 预览 → 写入文件。

快捷键：`Ctrl+K` 聚焦搜索、`Ctrl+N` 新建条目、`Ctrl+L` 立即锁定。

---

## 9. 代码结构

```
src-tauri/src/
  lib.rs         Tauri 启动、命令注册、空闲 / 锁屏守护线程
  commands.rs    全部 IPC 命令（前端唯一入口）
  crypto.rs      Argon2id / AES-256-GCM / DPAPI / 口令强度
  rules.rs       密码规则：合规生成与违规检查
  keys.rs        内容文件解析：JSON / .env / TOML / YAML / XML / 文本
  store.rs       保险库信封、设置文件、备份轮转、便携模式、数据归一化
  model.rs       Vault / Entry / PasswordRule / HistoryEntry / ContentLink / KeyMapping
  sync.rs        同步上下文、模板引擎、内置模板、写盘与备份
  state.rs       解锁状态、设置快照、锁屏检测（OpenInputDesktop）
ui/
  index.html
  styles/        tokens.css（设计变量）、app.css（布局模型见文件头注释）
  js/            app.js（外壳与路由）、state.js（状态与动作）、api.js、theme.js …
  js/views/      lock / accounts / editor / linkkeys / sync / associations / settings
tools/
  serve-ui.mjs、ui-fixtures.js、inspect-ui.mjs、audit-ui.ps1、ascii-shot.ps1
```

**布局模型**：`html/body/#app` 固定 `height:100%` 且不滚动；`.shell` 铺满视口，
侧边栏是「品牌 + 可滚动中段 + 固定底部」的纵向 flex，主区是「标题栏 + 内容」的两行 grid，
只有内容区滚动。这样无论窗口多高，外壳都不会塌缩或溢出。

其它 UI 约束：同心圆角（内层圆角 = 外层圆角 − 间距）、用分层半透明阴影表达层级而非画假边框、
按压缩放固定 `0.96`、图标只用 `currentColor` 着色（激活态才用填充变体）、
避免 `transition: all`、尊重系统的「减少动态效果」设置。

---

## 10. 已知边界

- 仅支持 Windows（DPAPI、锁屏检测与资源管理器集成依赖 Windows API）。
- 字段解析基于键名匹配与格式遍历，不解析加密 / 压缩文件；
  复杂格式（例如多行 YAML 块标量）建议在界面上直接指定关键词。
- 同步是「渲染后写入」，不会合并已有 JSON；请保留备份，或把目标指向 SapVault 专属文件。
- 便携模式依赖 `portable.txt` 标记，不会自动迁移 `%APPDATA%` 里已有的数据。
- 账号不再记录系统 ID、客户端、登录语言等信息，也不读取 SAP 登录配置；
  如需按系统维度区分，请写在账号标题里。
