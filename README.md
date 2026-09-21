# SapVault

面向 SAP 与日常系统的本地密码管理器，Windows 桌面应用。
完全离线：没有账号体系、没有遥测、没有任何网络请求。

- 桌面框架：**Tauri 2**（Rust 后端 + 系统 WebView2 前端）
- 前端：**零依赖的原生 ES Module + CSS**（无 npm、无打包器）
- 加密：**AES-256-GCM**；主密码模式用 **Argon2id** 派生密钥，本机账户模式用 **Windows DPAPI** 封装随机密钥

当前版本：**1.2.1**

---

## 1. 使用方法

### 1.1 解锁与锁定

首次启动时选择解锁方式：**主密码**（Argon2id 派生密钥）或**仅本机账户**（Windows DPAPI，
点一下按钮即可解锁）。之后可以在「设置 → 锁定与剪贴板」里为主密码模式的保险库设置主密码。

启动、重启、`Win+L` 锁屏、空闲超时、手动点「锁定保险库」都会回到锁定状态；
解锁前内存中没有明文密码。快捷键 `Ctrl+L` 也可以立即锁定。

### 1.2 账号

左侧是分类：**SAP 账号**（固定分类）、**通用账号**，以及自建分类。
「新建条目」填写标题、分类、用户名（可勾选**使用全局 Knox ID**，勾选后用户名统一取自侧边栏的
Knox ID）、密码与备注；编辑时密码留空表示保留原密码。

复制密码有三个入口，效果一致：

- 账号列表每行右侧的图标按钮（复制密码 / 复制用户名 + 密码 / 收藏）；
- 右侧详情面板的按钮与凭据行内的小图标；
- **在列表行或详情面板上点右键**，弹出应用自己的菜单（复制密码、复制用户名 + 密码、收藏）。
  WebView 自带的浏览器菜单在整个应用里都是关闭的，右键不会出现「重新加载」「检查」之类的项目。

SAP 分类的账号额外提供「复制用户名 + 密码」：用户名与密码以换行分隔（分隔符可在设置里选择
`CRLF` 或 `LF`），粘贴到 SAP GUI 登录界面时会自动填进连续的输入框。

每个条目都可以选择**使用密码规则**或**不使用规则**。规则包含长度上下限、大小写 / 数字 / 符号、
可用符号集、禁用字符、首字符必须为字母、排除易混淆字符；可以按规则一键生成密码，保存时校验并列出
具体违规原因，确实要保存不合规密码时可以「仍然保存」。设置页可配置新建条目默认带上的规则。

**密码循环与历史**：条目可设置循环周期 N（SAP 系统会拒绝重复最近若干个密码）。修改密码时自动记录
旧密码，也可以手动补录；历史密码可以显示、复制、删除、清空，并标注哪些还在循环内。

**搜索**：账号页右上角的搜索框按**标题、用户名与备注**筛选当前分类下的条目（备注里写的系统名、
用途、轮换说明都能搜到）。

**备注里的链接**：详情面板中的备注如果包含 `http(s)://` 或 `mailto:` 链接，会显示成可点击的链接，
点一下用系统默认浏览器打开（不会把应用本身导航走）；链接之外的文字保持原样，换行也保留。

快捷键：`Ctrl+K` 聚焦搜索、`Ctrl+N` 新建条目、`Ctrl+L` 锁定。

### 1.3 同步文件

SapVault 可以把你上传的配置文件里**某一个键的值**替换成账号密码，其余内容一个字节都不动。
三步即可完成：

1. **上传文件**：在「同步文件」页点「上传文件」，或把文件**直接拖进窗口**（拖动过程中会出现
   深色投放层，松手即上传），也可以在账号详情里点「添加文件」。
   弹窗会立刻列出解析到的每个键、值、行号，以及哪些键命中了密码关键词。
2. **点选密码键并绑定账号**：文件内容以折叠树（JSON / YAML / XML）或扁平表格
   （`.env` / TOML / INI / properties / tfvars）呈现每个键，右侧下拉框选择账号即可。
   账号很多时下拉框不再难用：它是一个**可搜索的选择器** —— 点开后直接输入关键字
   （匹配账号标题与用户名）即可缩小范围，支持上下键 + 回车、`Esc` 关闭。
   关系的身份是 **(文件 + 键) → 账号**：一个文件可以绑定多个账号（各选不同的键），
   一个账号也可以绑定多个文件。
3. **同步**：文件顶部显示「将更新 N 处密码」，点「同步」；也可以在「同步文件」页或标题栏
   「全部同步」一次处理所有文件。文件里的值与账号密码一致时显示「已最新」，不会写盘；
   写入是「先写同目录临时文件、再改名覆盖」，所以同步后目录里不会多出 `.bak` 之类的副本。

**改密码后会自动提醒**：如果账号已经绑定了文件，保存新密码后会立刻弹窗列出仍有旧密码的文件与键，
可以直接点「现在同步」把新密码写回去，也可以稍后自己同步。

「关联关系」页用卡片或表格总览所有 账号 ↔（文件，键）绑定，展示文件路径、键路径、文件里的当前值
（默认打码，可在设置里关闭）与「疑似密码」标记。

### 1.4 支持的文件格式

| 格式 | 扩展名 | 画面呈现 | 解析规则 |
| --- | --- | --- | --- |
| JSON | `.json`、`.jsonc` | 折叠树 | 递归展开嵌套对象与数组，路径形如 `sap.production.password` |
| YAML | `.yaml`、`.yml` | 折叠树 | 按缩进层级构建路径 |
| XML | `.xml`、`.config`、`.plist`、`.resx`、`.xsd`、`.svg` | 折叠树 | 叶子元素文本与属性都会读取（属性形如 `connection@host`） |
| `.env` | `.env`、`.env.*`、`*.env` | 扁平表格 | `KEY=VALUE`，支持 `export` 前缀、单双引号、`#` 注释 |
| TOML / INI / properties / tfvars | `.toml`、`.ini`、`.conf`、`.cfg`、`.properties`、`.tfvars`、`.hcl` | 扁平表格 | 支持 `[section]`，路径形如 `sap.auth.password` |

**注释永远不会被当成值，也永远不会被改写。** 每种格式按自己的注释规则解析：
TOML / YAML 用 `#`（引号内的不算），INI / properties 用 `#`、`;`、`!`，
`.env` 只把行首的 `#` 当注释（所以 `PASSWORD=ab#cd` 是完整密码），
`.tfvars` / HCL 用 `#`、`//`、`/* … */`，JSONC 用 `//`、`/* … */`，XML 用 `<!-- … -->`。
`key: |` / `key: >` 这类 YAML 文本块整体按内容处理，不会在里面找键。

关键词匹配（「设置 → 文件关键词」，每个文件也可以单独覆盖）只决定哪些键被标成「疑似密码」，
默认包含 `password / passwd / pwd / pass / secret / passwort / kennwort / token`，
忽略大小写、允许包含匹配；没有命中的键同样可以手动绑定账号。

### 1.5 外观与便携模式

主题可选**亮色 / 暗色 / 跟随系统**（跟随系统会随 Windows 的浅色深色设置自动切换）。

在 `sapvault.exe` 旁边放一个 `portable.txt`（或直接建一个 `SapVaultData` 文件夹），
程序就会把所有数据写进同目录的 `SapVaultData\`，不再接触用户目录，适合 U 盘携带。

### 1.6 一键登录 SAP GUI

SAP 账号可以配成「点一下直接打开 SAP GUI」。配置在条目的「SAP GUI 登录」区块里：

1. **从 SAP Logon 选系统**：SapVault 读取 `%APPDATA%\SAP\Common\SAPUILandscape.xml`
   （以及它 include 进来的 `SAPUILandscapeGlobal.xml`），把你在 SAP Logon 里加过的系统列出来 ——
   不管是「Custom Application Server」（主机 + 实例号 + 系统 ID）还是
   「Server Group / 登录组」（选组、其余信息自动带出）都能读出来。
   同一个系统 ID 配了多次时会标注「（同名）」，选具体那一条即可（会记住连接串，避免打开错的系统）。
2. **或者手动填写**：系统 ID、客户端、登录语言、连接串（应用服务器 `/H/主机/S/端口`，
   登录组 `/R/系统ID/G/组名` 或 `/M/消息服务器/S/端口/G/组名`）。
3. 可以顺带填「登录后执行事务码」（例如 `SE80`），以及是否用 `-maxgui` 最大化。

存好之后，账号列表每行、详情页和右键菜单都会出现 **「登录 SAP GUI」**；详情页还能 **「导出快捷方式」**，
生成一个 `.sap` 文件 —— 那是 SAP GUI 自己的快捷方式格式，双击即用，也可以直接发给同事。
**`.sap` 文件里不含密码**（它是纯文本），打开时由 SAP GUI 自己询问；它**也不写连接串**，
只写系统 ID —— SAP GUI 会去 SAP Logon 里找对应系统，所以那个系统要已经在 SAP Logon 中配置过。

密码怎么交给 SAP GUI 由设置决定（「设置 → SAP GUI 登录 → 密码传递方式」）：

| 方式 | 行为 | 代价 |
| --- | --- | --- |
| **剪贴板（默认）** | 打开 SAP GUI 登录界面（系统、客户端、用户名、语言都已填好），只把**密码**放进剪贴板，按一次 `Ctrl+V` 填入密码 | 需要按一次粘贴 |
| **命令行明文** | 直接把 `-pw=密码` 交给 `sapshcut.exe`，点一下即登录 | 密码会出现在进程命令行里，本机其它程序在启动的一瞬间可能读到 |

同一张设置卡片里可以手动指定 `sapshcut.exe` 的位置（默认自动在
`C:\Program Files (x86)\SAP\FrontEnd\SAPGUI\` 等位置查找），也可以追加额外的 `SAPUILandscape.xml` 路径。

---

## 2. 技术点

### 2.1 架构

单进程桌面应用：Rust 侧提供全部 IPC 命令（`src-tauri/src/commands.rs` 是前端唯一入口），
前端是纯静态资源（`ui/`），由 Tauri 直接加载系统 WebView2 渲染，不需要 Node.js 参与运行时。

前端只有一层极薄的状态管理：`ui/js/state.js` 保存唯一的应用状态快照，视图函数渲染 DOM 后
由订阅回调整体重绘。所有 DOM 都通过 `ui/js/dom.js` 的元素工厂创建，没有任何 `innerHTML` 拼接，
因此用户输入永远不会变成标记。图标是一套自写的 SVG 路径（`ui/js/icons.js`），
统一用 `currentColor` 着色，激活态才切到填充变体。

后端每个命令都在锁定的状态下拒绝执行；空闲与锁屏检测跑在独立的守护线程里，
窗口隐藏或 WebView 暂停都不会让它失效。

### 2.2 安全模型

- 保险库是单个加密文件 `vault.sapvault`，内容是 `AES-256-GCM(KDF(主密码) 或 DPAPI 封装密钥)`。
- **主密码模式**：Argon2id（m=19456 KiB、t=2、p=1）派生 32 字节密钥，盐值随机 16 字节。
- **仅本机账户模式**：随机 32 字节密钥由 Windows DPAPI 以当前用户身份封装。
- 主密码只在内存中用于派生密钥；锁定或退出时用 `zeroize` 擦除密钥、密码、历史密码与解析结果。
- 剪贴板在复制后 N 秒自动清空（默认 30 秒，可关闭），只有内容仍是本次写入的才清空。
- 保险库写入采用「先写临时文件再改名」，保留最近 10 个备份；文件损坏时明确报错，
  不会伪装成「尚未创建」。

> 明文风险提示：解锁后的内容会经过 WebView 渲染。SapVault 不做进程级内存加密，
> 也无法防御已经取得你 Windows 账户权限的恶意软件——这是所有本地密码管理器的共同边界。

### 2.3 解析与原地改写

解析（`src-tauri/src/keys.rs`）按格式遍历出「键路径 → 值」的列表，并记录每个值在文件里的
字节区间、行号、引号风格与所属格式；改写（`src-tauri/src/patch.rs`）只在这个字节区间上替换值，
因此注释、缩进、键顺序、其它键都不会变。写入前会重新解析并核对（键的数量、顺序、被改动的值），
不通过就放弃写入；真正落盘时先写同目录的临时文件再改名覆盖，中断也不会留下写了一半的配置，
所以同步不再额外生成 `<文件>.bak-<时间戳>` 副本（旧密码本身已记录在保险库的密码历史里）。
保留原编码（UTF-8 / UTF-8 BOM / UTF-16 LE / UTF-16 BE）与原有引号风格，需要时按 JSON / XML 规则转义。

同步计划与执行在 `src-tauri/src/sync.rs`：它把「(文件, 键) → 账号」的绑定展开成
「将更新 / 已最新 / 键已不存在 / 账号缺密码」四种结论，界面上的标记就是这份计划的直出结果。

### 2.4 数据位置

| 内容 | 默认路径 |
| --- | --- |
| 保险库 | `%APPDATA%\SapVault\vault.sapvault` |
| 设置 | `%APPDATA%\SapVault\settings.json`（不含任何密钥） |
| 自动备份 | `%APPDATA%\SapVault\backups\vault-*.sapvault` |

便携模式下这些路径改为 `sapvault.exe` 同级的 `SapVaultData\`。

### 2.5 界面约定

- **布局**：`html/body/#app` 固定 `height:100%` 且不滚动；`.shell` 铺满视口，侧边栏是
  「品牌 + 可滚动中段 + 固定底部」的纵向 flex，主区是「标题栏 + 内容」两行 grid，只有内容区滚动。
- **圆角**：同心圆角，内层圆角 = 外层圆角 − 间距。
- **层级**：用分层半透明阴影表达，只有结构和状态才画 1px 边框。
- **按压反馈**：按钮用 `scale(0.96)` 反馈，但**行内的小图标按钮不位移**——整行很宽，
  一旦按下时缩放，按钮会在鼠标抬起前滑出光标，点击就落到行上而不生效。
- **动效**：只过渡具体属性（不使用 `transition: all`），并尊重系统的「减少动态效果」设置。

### 2.6 SAP GUI 集成

启动 SAP GUI 用的是 SAP 自带的 `sapshcut.exe`（SAP Note 103019 *SAPShortcut: Program parameters*，
配合 Note 390832 的补充参数），所以既不用我们去改 SAP 的配置，也不用模拟按键：

```
sapshcut.exe -system=PRD -client=100 -guiparm="/H/prd.example.com/S/3200" \
             -user=USER01 -language=ZH -maxgui [-type=Transaction -command=SE80]
```

- 客户端号不足三位会补零（`1` → `001`）；不给 `-user` 时由 SAP GUI 自己弹登录框。
- **系统 ID 始终交给 SAP GUI**（`-system=…`）：服务组连接少了它会被直接判为「缺少系统 ID」
  （2026-09-21 实测；社区里成熟的登录脚本同样只传 `-system` / `-client` / `-user` / `-pw` / `-language`）。
- `-guiparm` / `-gui` 只在需要**钉住具体连接**时使用，三种形态的首跳标记不能混：

  | 连接方式 | 连接串 |
  | --- | --- |
  | 应用服务器（含"Group/Server 里 Server 直接写地址"的情况） | `/H/主机/S/端口` |
  | 登录组（推荐，SAP GUI 用系统 ID + 组名解析消息服务器） | `/R/系统ID/G/组名` |
  | 登录组（消息服务器已知时） | `/M/消息服务器/S/端口/G/组名` |

  登录组一定要用 `/R/` 或 `/M/` 开头——用 `/H/` 拼消息服务器会被 SAP GUI 判为连接串不正确。
  saprouter 场景在整串前面加一跳：`/H/路由器/S/端口/M/消息服务器/S/端口/G/组名`（端口默认 `3299`）；
  本项目的使用场景里没有 SAProuter，所以只做兼容、不做额外配置。
- **窗口可见性**：SAP GUI 是异步创建窗口的，被别的程序调起时窗口可能被压在调起方后面，
  表现就是「登录其实成功了，却没有窗口；再点一次还提示已登录」。所以启动前会调用
  `AllowSetForegroundWindow(ASFW_ANY)` 把前台权限让给 SAP GUI，启动后由后台线程最多等 30 秒，
  一旦出现新的 `SAP_FRONTEND_*` 会话窗口就还原并置前。
  仍然看不到时的兜底顺序：① 勾上该条目的「启动后最大化窗口（`-maxgui`）」；
  ② 关闭 SAP GUI 后删除注册表 `HKCU\Software\SAP\SAPGUI Front\SAP Frontend Server\Window`
  （SAP GUI 会记住窗口位置，偶尔会把新窗口创建到屏幕外）；③ 用 `Alt+Tab` 确认窗口是不是只是被挡住。
- `src-tauri/src/saplogon.rs` 解析登录配置：`Service` 上的 `systemid` / `server` / `msid` / `routerid` / `url`，
  以及 `Messageservers`、`Routers`、`Includes`（递归读取）和 `Workspaces`（用来显示分组路径）。
  因为同一个 `systemid` 可能出现多次，内部统一用 `service_uuid` 精确定位一条连接。
  字段含义以 SAP 官方文档 **SAP UI Landscape → SAP UI Landscape XML Description**
  （`help.sap.com/saphelp_tm92/.../d5/66efdfdd0c47bab00b5031a4e1b580/content.htm`）为准，其中三点直接照着实现：
  `server` 是「登录组名**或** `主机:端口`」；保存过的 SAP GUI 快捷方式用 `sapguiid` 指回它所属的连接
  （这种条目自己没有服务器信息，解析时会继承被指向的连接）；路由串可能是前缀形式
  `/H/网关/S/端口/H/`，目标主机接在它后面。`<Includes>` 指向 `http(s)://` 时会被跳过并给出提示——
  SapVault 不发起任何网络请求。
- `.sap` 导出（`src-tauri/src/sapgui.rs`）：格式与 SAP GUI 自己保存的快捷方式一致
  （2026-09-21 用实测文件核对）——`[System]` 写 `Description` / `SystemID` / `Client`（**不含连接串**，
  SAP GUI 靠系统 ID 去 SAP Logon 里找系统），`[User]` 写 `Name` / `Language`，
  `[Function]` 写 `Title=SAP` / `Command=<事务码，默认 S000>`，
  再补 `[Configuration] WorkDir=<文档目录>\SAP\SAP GUI` 与 `[Options] Reuse=1`；
  以 UTF-8 写出，**不含密码**。

启动进程不使用 shell，参数原样交给 `sapshcut.exe`；`-pw=` 只在用户显式选择命令行模式时才出现，
而且任何回显（例如提示条里的参数预览）都会把它替换成 `-pw=***`。

---

## 3. 测试

### 3.1 后端单元测试

```powershell
cd src-tauri
cargo test
```

覆盖加密与 DPAPI 往返、设置归一化、各格式解析（含注释永不被解析 / 改写）、
原地改写的字节精度、同步计划、密码规则与历史、绑定归一化，
以及 SAP 登录配置解析（直连 / 登录组 / 同名系统 ID / Include 递归 / 子元素版布局）、
`sapshcut` 参数组装、`.sap` 文件内容与前后端字段契约（当前 76 个用例）。

### 3.2 界面审计

`tools/` 下有一套可复现的界面审计工具：它用静态服务器加载 `ui/` 并注入桩 IPC
（`tools/ui-fixtures.js`），再通过 DevTools 协议驱动 Edge（与 WebView2 同一引擎）逐页测量，
所以在不构建桌面包的情况下就能检查真实排版。

```powershell
pwsh tools/audit-ui.ps1 -WithModals                                     # 含弹窗的完整审计
pwsh tools/audit-ui.ps1 -Sizes 1000x660,1240x800,1600x900,1920x1080    # 多窗口尺寸
pwsh tools/audit-ui.ps1 -Sizes 1240x800 -Interactions                  # 审计后再跑交互回归
pwsh tools/audit-ui.ps1 -Sizes 1240x800 -ShotView 同步文件              # 附带字符画截图
```

审计检查外壳是否铺满窗口、每页是否有横向溢出、是否有元素超出窗口、文字是否被裁切、
字号是否过小、页面是否意外滚动、是否有未捕获的运行时异常，以及每页 / 每个弹窗该出现的内容是否都在。
`tools/ascii-shot.ps1` 可以把截图渲染成字符画，方便在终端里粗看版式。

脚本会先等到界面真正渲染出来再测量（`inspect-ui.mjs` 的 `waitForApp()`），
结束时按 `--user-data-dir` 结束整棵 Edge 进程树并删除临时 profile ——
否则每跑一次都会留下一个锁住 profile 的 headless Edge。

### 3.3 交互回归

```powershell
pwsh tools/audit-ui.ps1 -Interactions        # 一步到位：起服务器 + Edge，审计完再跑交互

node tools/serve-ui.mjs                      # 或者自己起静态服务器
node tools/check-interactions.mjs
```

这个探针用 DevTools 协议发送**真实鼠标事件**并按 Tauri 的事件格式回放窗口事件，覆盖纯排版审计
覆盖不到的部分：列表行按钮的边缘点击命中、搜索框占位文字与「按备注搜索」、右键菜单内容与
「复制」生效、拖拽上传投放层与上传弹窗、「改密码 → 提示同步 → 直接同步」的完整链路。
需要 Edge 以 `--remote-debugging-port` 启动（`tools/audit-ui.ps1` 里就是这么做的）。


---

## 4. 打包

前置条件：Windows 10/11、[Rust](https://rustup.rs)（MSVC 工具链）、
[WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)
（Win11 已内置，Win10 一般随 Edge 安装）。前端不需要 Node.js。

```powershell
cd src-tauri
cargo build --release
```

产物 `src-tauri\target\release\sapvault.exe` 是**单文件、免安装**的：MSVC 运行库已静态链接
（见 `src-tauri/.cargo/config.toml`），除系统 DLL 外只依赖 WebView2。

需要安装包时：

```powershell
cargo install tauri-cli --version "^2"
cd src-tauri
cargo tauri build          # 生成 NSIS 安装程序，版本号取自 tauri.conf.json
```

版本号只有三处：`src-tauri/Cargo.toml`（界面显示的版本）、`src-tauri/Cargo.lock`、
`src-tauri/tauri.conf.json`（安装包版本）。应用图标由 `src-tauri/build.rs` 在构建时程序化生成
（纯 Rust，自带 PNG / ICO 编码器），因此仓库里只需要提交少量占位图标。

---

## 5. 代码结构

```
src-tauri/src/
  lib.rs         Tauri 启动、命令注册、空闲 / 锁屏守护线程
  commands.rs    全部 IPC 命令（前端唯一入口）
  crypto.rs      Argon2id / AES-256-GCM / DPAPI / 口令强度
  rules.rs       密码规则：合规生成与违规检查
  keys.rs        内容文件解析：JSON / .env / TOML / INI / properties / tfvars / YAML / XML
  patch.rs       原地改写：编码保留、按字节区间替换、转义、写前核对
  store.rs       保险库信封、设置文件、备份轮转、便携模式、数据归一化
  model.rs       Vault / Entry / FileValue / FileBinding / SyncFile / KeyMapping
  sync.rs        同步计划与执行：只改被绑定的键，写入前校验并原子替换
  saplogon.rs    SAP Logon 配置解析（SAPUILandscape.xml → 可登录的系统列表）
  sapgui.rs      sapshcut 参数组装与启动、.sap 快捷方式生成

  state.rs       解锁状态、设置快照、锁屏检测（OpenInputDesktop）
ui/
  index.html
  styles/        tokens.css（设计变量）、app.css（布局模型见文件头注释）
  js/            app.js（外壳与路由）、state.js（状态与动作）、api.js、icons.js、contextmenu.js、dragdrop.js …
  js/views/      lock / accounts / editor / filedialog / sync / associations / settings
tools/
  serve-ui.mjs、ui-fixtures.js、inspect-ui.mjs、audit-ui.ps1、ascii-shot.ps1、check-interactions.mjs
```

---

## 6. 已知边界

- 仅支持 Windows（DPAPI、锁屏检测与资源管理器集成依赖 Windows API）。
- 字段解析基于键名匹配与格式遍历，不解析加密 / 压缩文件；复杂结构（例如多行 YAML 块标量、
  JSON 里重复出现的同名路径）建议改用文件里的唯一键名，或在同步后核对结果。
- 同步是「原地改一个值」：不格式化文件、不重排键顺序；同名键重复出现时，绑定的是解析到的
  第一个可定位位置。
- 拖拽上传只在「同步文件」页生效，避免在别的页面误把文件当成同步目标。
- 便携模式依赖 `portable.txt` 标记，不会自动迁移 `%APPDATA%` 里已有的数据。
- 一键登录需要机器上装有 **SAP GUI for Windows**：找不到 `sapshcut.exe` 时按钮会禁用并给出提示，
  可以在设置里手动指定路径。没有 SAP GUI 的机器仍然可以导出 `.sap` 快捷方式。
- 读不到 `SAPUILandscape.xml`（没装 SAP GUI、或还没在 SAP Logon 里加过系统）时，
  系统列表是空的，需要手动填写系统 ID 与连接串。
- `.sap` 以 UTF-8 写出。SAP GUI 7.70+ 直接可用；若某些旧环境只认本地代码页，
  可以把系统名/描述写成 ASCII 再导出。
- 「命令行明文」模式的安全性由使用者自行权衡：密码会短暂出现在进程命令行里。
  默认的剪贴板模式不把密码交给命令行。
