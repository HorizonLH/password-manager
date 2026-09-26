# AGENTS.md —— SapVault 开发/评审/测试/发布约定

给在这个仓库里干活的 agent（和同样干活的人）看的操作手册。
使用说明与背景在 [README.md](README.md)，待办与版本规划在 [TODO.md](TODO.md)；
这份文件只讲「怎么改、怎么验、怎么发」。

## 1. 项目速览

- Windows 桌面应用，**Tauri 2**：Rust 后端 + 系统 WebView2 前端，**完全离线**（没有账号体系、没有遥测、没有任何网络请求）。
- 前端是**零依赖**的原生 ES Module + CSS：没有 npm、没有打包器、运行期不需要 Node。
- 数据只有一个 `vault.sapvault`（AES-256-GCM；密钥来自 Argon2id 主密码或 Windows DPAPI 封装）。

```
src-tauri/src/
  lib.rs        启动、命令注册、空闲/锁屏守护线程
  commands.rs   全部 IPC 命令（前端唯一入口）；未解锁一律拒绝
  crypto.rs     Argon2id / AES-256-GCM / DPAPI / 口令强度
  rules.rs      密码规则（生成 + 校验）        keys.rs    内容文件解析（JSON/…/XML）
  patch.rs      按字节区间原地改写              sync.rs    同步计划与执行
  store.rs      保险库信封、设置、备份轮转、便携模式
  model.rs      Vault / Entry / SyncFile / FileBinding …
  state.rs      解锁状态、设置快照、锁屏检测
  saplogon.rs   SAPUILandscape.xml 解析        sapgui.rs  sapshcut 参数组装与 .sap 导出
ui/
  index.html    styles/(tokens.css, app.css)   js/(state, dom, modal, combobox, icons, …)
  js/views/     lock / accounts / editor / filedialog / sync / associations / settings
tools/
  serve-ui.mjs  静态服务器 + 桩 IPC            ui-fixtures.js  测试数据与桩后端
  inspect-ui.mjs 几何/内容审计（CDP）          audit-ui.ps1    一键：服务器 + headless Edge + 审计
  check-interactions.mjs  真实鼠标事件的交互回归    ascii-shot.ps1  截图转字符画
```

## 2. 铁律（动手前先确认没踩）

1. **不联网**：不新增任何 HTTP/DNS/更新检查。SAP 相关只读本机文件、只调本机 `sapshcut.exe`。
2. **前端零运行时依赖**：不引入 npm 包或打包器。要加 Rust 依赖先说明理由并保持最小
   （当前：tauri、serde、serde_json、aes-gcm、argon2、zeroize、quick-xml、walkdir、arboard、rfd、dirs、chrono、thiserror）。
3. **DOM 只走 `ui/js/dom.js`** 的 `h()` / `mount()` / `append()`：禁止把用户数据拼进 `innerHTML`
   （`h()` 的 `html:` 只用于常量）。用户输入永远不能变成标记。
4. **锁定态必须拒绝**：新命令要在 `commands.rs` 里走同样的「未解锁就报错」路径；新增的内存密码字段要能被 `zeroize` 清掉。
5. **密码不进日志、不进命令行**：只有用户在设置里显式选择「命令行明文」时才允许 `-pw=`，
   任何回显（含提示条里的参数预览）都要打码成 `-pw=***`。
6. **不猜，先读**：改 UI 先看对应的 `ui/js/views/*.js` 与 `ui/styles/app.css`；改同步先读 `keys.rs` + `patch.rs` + `sync.rs`。
   这个仓库的坑一半在渲染顺序和 CSS 盒模型上（见第 8 节）。

## 3. 开发流程

1. **定位**：先搜全量调用点（`rg -n "符号" ui src-tauri tools`）。
   **修 bug 修根因**：同一个错误出现在多个调用点时，改共享函数（`h()`、`commands.rs` 的共用路径、
   CSS 的共用规则），不要在每个调用点各贴一块补丁 —— 只修报告里那一条会留下同类问题。
2. **改动**：只用 `apply_patch` 编辑文件（不要用 shell 重定向/cat 写文件）；
   临时产物（补丁脚本、截图）放 `target/` 或系统临时目录，别留在仓库里。
3. **自测**：见第 5 节。**每次修 bug 必须留下一个「会失败过的检查」** ——
   后端 → `src-tauri/src/*.rs` 的 `#[cfg(test)]`；布局 → `tools/inspect-ui.mjs` 的断言；
   交互 → `tools/check-interactions.mjs`；需要新数据就在 `tools/ui-fixtures.js` 里补桩。
4. **提交**：见第 6 节。工作区脏就差最后一步：跑测试、写清「修了什么 / 为什么 / 验证结果」。

## 4. 分层规范

### Rust

- 命令集中在 `commands.rs`，入参结构体 `#[serde(rename_all = "camelCase")]`；前端字段名与 Rust 字段一一对应
  （已有测试固定这个契约，改名要同步改前端与测试）。
- 错误统一 `AppError`（`error.rs`），用户可见文案用中文短句，讲清「怎么办」。
- 落盘一律「先写同目录临时文件 → 改名覆盖」（`store.rs` / `sync.rs` 已有实现，不要绕过）。
- 注释用英文短句解释「为什么」，不要复述代码在做什么。
- 提交前 `cargo fmt` + `cargo test` 必须过。

### 前端

- **状态**：`ui/js/state.js` 是唯一 store，改动走 `setState({...})`，外壳 `app.js` 订阅后整体重绘。
  跨重绘要保留的 UI 状态（展开/折叠、滚动位置、筛选词）必须放进 `state` 或模块级持久对象 ——
  放在渲染函数里的局部变量会被下一次重绘清掉（1.1.2 滚动位置、1.2.3 折叠面板都是这个坑）。
- **滚动**：会滚动的容器加 `dataset: { scrollKey: "…" }`，由 `app.js` 保存/还原。
- **表单**：标签在上、控件在下；所有可交互控件共用 `--control-h`（`tokens.css`）的高度；
  同一行用 `.form__grid`（≥720px 两列、≥1100px 三列）+ `align-items: start`，
  「输入 + 输入 + 按钮」用 `.form__grid--action`。审计里有 ≤1px 的几何断言，别绕过它。
- **下拉框**：统一用 `ui/js/combobox.js` —— 长列表 `searchSelect()`（带搜索框），
  短固定列表 `selectMenu()`（不带搜索框、按首字母跳转）。不要再写原生 `<select>`，也不要自造浮层；
  浮层挂在 `#combo-root`（脱离所有 `overflow: hidden` 祖先）。
- **弹窗**：只用 `ui/js/modal.js`（`openModal` / `confirmModal` / `promptModal`）—— 它负责焦点陷阱、
  关闭后焦点还原、Esc，以及「提交失败留在弹窗里重试」。**禁止 `window.prompt/alert/confirm`**。
- **图标**：只用 `ui/js/icons.js`（`currentColor` + 激活动填变体），不要贴图片或新画 SVG。
- **CSS**：设计变量在 `tokens.css`；只过渡具体属性（禁止 `transition: all`）；尊重「减少动态效果」；
  圆角按同心规则（内 = 外 − 间距）。
- **文案**：界面与文档一律中文。

## 5. 评审清单（自查 / 互查都用它）

- [ ] 根因修在共享路径上，不是调用点贴补丁；同类问题没有遗留的兄弟调用点。
- [ ] 未解锁路径没被绕过；新增的内存密码字段会被 `zeroize` 清掉。
- [ ] 没有新增网络调用、没有新增前端运行时依赖。
- [ ] 没有 `innerHTML` 拼接用户数据、没有 `window.prompt/alert/confirm`、没有原生 `<select>`。
- [ ] 跨重绘状态放进了 `state`（或模块级持久对象）；滚动容器带 `data-scroll-key`。
- [ ] 表单控件高度走 `--control-h`；审计的几何断言通过。
- [ ] 新命令在 `commands.rs` 里定义**并且**在 `lib.rs` 的 `invoke_handler` 注册。
- [ ] 同步相关改动：注释「永不解析、永不改写」的用例仍过；写入仍是临时文件 + 改名。
- [ ] 版本号四处一致（`Cargo.toml` / `Cargo.lock` / `tauri.conf.json` / `README.md`）。
- [ ] `TODO.md` 归档已更新；README 与实现没有互相矛盾。
- [ ] 提交信息与交付说明里写明了测试结果（数字）。

## 6. 测试与验证

```powershell
# 后端 86 个用例：加密/DPAPI、六种格式解析与注释安全、原地改写字节精度、同步计划、
# 规则与历史、SAP 配置解析、sapshcut 参数、.sap 内容、前后端字段契约
cd src-tauri; cargo test

# 界面排版审计（无头 Edge + 桩 IPC，量真实几何）
pwsh tools/audit-ui.ps1                                   # 默认三种窗口尺寸
pwsh tools/audit-ui.ps1 -Sizes 1000x660,1240x800,1600x900,1920x1080
pwsh tools/audit-ui.ps1 -WithModals                       # 含解锁页 / 详情 / 编辑弹窗
pwsh tools/audit-ui.ps1 -Sizes 1240x800 -Interactions     # 审计 + 交互回归一把梭

# 只跑交互回归（先按 audit-ui.ps1 里的方式起服务器 + Edge）
node tools/serve-ui.mjs        # 另一个终端
node tools/check-interactions.mjs
```

- 排版审计会拦：横向溢出、元素超出窗口、文字被裁切、字号过小、页面意外滚动、页面运行时异常、
  每页应有内容缺失，以及**同一个 `.form__grid` 行内控件 top/height 差 ≤1px**。
- 交互回归用真实鼠标事件 + 回放 Tauri 窗口事件，覆盖点击命中（含按钮边缘）、右键菜单、拖拽上传、
  「改密码 → 提示同步 → 直接同步」、备注往返、`Ctrl+K` 落点、弹窗焦点陷阱、下拉选择、导入保险库重试。
- 改 `tools/ui-fixtures.js` 等于改测试数据：加场景要顺手加断言。
- 交付 UI 改动时附一张截图（`tools/ascii-shot.ps1` 或 `node tools/inspect-ui.mjs shot <png>`）比描述十行有用。

## 7. 版本、提交与发布

**版本号只有四处**：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、
`README.md` 的「当前版本」行。改完跑一次 `cargo build` 让 `Cargo.lock` 同步。

**提交信息**（中文；一行主题 + 可选正文）：

```
feat(ui): 1.2.3 —— 编辑条目分区折叠、下拉框统一为账号选择器同款、同步页键过滤 + Ctrl+K
fix(sap): 登录组改用 /R/ 与 /M/ 连接串、不再与 -system 混用
chore(release): 1.2.0 —— 备注里的链接可直接打开、同步文件绑定账号改为可搜索选择器
docs(todo): 记录 1.1.x 表单控件对齐（含三处实测位置）与 1.2.x 规划
```

- 类型：`feat` / `fix` / `chore` / `docs` / `refactor` / `test`；范围：`ui` / `sap` / `sync` / `tools` / `release` / `todo` / `security`。
- 一个版本一个提交；紧急修复单独提交并在主题里带上版本号。
- **`TODO.md` 是唯一的待办来源**：开工先找到对应条目，做完把它挪到文件末尾的「已完成」归档
  （写清现象 → 根因 → 修法 → 验证）。
- 标签：`git tag -a vX.Y.Z -m "SapVault X.Y.Z"`。**UI 大改后还没复测的版本先不 tag**，等复测通过再发。
- 发布：push `main` 与 tag → 建 GitHub Release，附两个产物：

  | 文件 | 来源 |
  | --- | --- |
  | `SapVault_<版本>_x64-setup.exe` | `cargo tauri build` 产出的 NSIS 安装包（`target/release/bundle/nsis/`） |
  | `SapVault_<版本>_x64-portable.exe` | `target/release/sapvault.exe` 改名，免安装单文件 |

  Release 正文沿用现有格式：`## SapVault X.Y.Z` → `### 新功能` / `### 修复` / `### 下载`（表格说明两个文件的区别，
  并保留「首次运行需要 WebView2、未签名可能有 SmartScreen 提示」这两句提醒）。
- 本机没有 `gh`：发布走 GitHub REST API（凭据取自 `git credential fill`，见第 8 节），
  上传地址为 `https://uploads.github.com/.../releases/<id>/assets?name=…`。

## 8. 沙箱注意（Codex 桌面环境）

- 沙箱用户写不了 `.git/index.lock`，也写不了 cargo 的构建锁：`git add/commit/push`、
  `cargo build/test/tauri build`、`pwsh tools/audit-ui.ps1` 都要 `require_escalated` 在沙箱外跑。
  只读命令（`git status`、`rg`、`Get-Content`）在沙箱内没问题。
- 审计脚本要监听 `127.0.0.1` 并启动 headless Edge，沙箱内会 `fetch failed`：必须沙箱外跑。
  它用随机端口 + 临时 profile，正常结束会自己清理；被中途打断时手动收掉
  `node tools/serve-ui.mjs` 与带 `--user-data-dir=…sapvault-edge-audit` 的 `msedge.exe`，
  否则下一次审计会报 profile 被占用。
- 发布用 GitHub API 时不要把令牌打印到输出里：`git credential fill` 取到值后只用于请求头。

## 9. 踩过的坑（改到相关代码前先看一眼）

| 坑 | 现象 | 结论 |
| --- | --- | --- |
| `<textarea value="…">` | 编辑条目时备注框是空的，保存后备注被清空 | `h()` 现在把 `value` 赋给元素**属性**；`textarea` 没有 value 内容属性 |
| `.table { overflow: hidden }` | 表格形式文件里的账号选择器点不开（面板被裁掉） | 浮层一律挂 `#combo-root` + `position: fixed` |
| `explorer /select,<含空格路径>` | 「显示文件」跳到「文档」目录 | Rust 会把整个参数加引号；改用 `Command::raw_arg()` 精确控制 |
| `form__grid` 用 `auto-fit` | 同一行两个控件忽上忽下、高度不一 | 明确断点 + `--control-h` + `align-items: start` |
| 面板内滚动 | 在下拉框里滚动时面板自己关掉了 | 只有面板**之外**的滚动才关闭 |
| 渲染函数内的局部变量 | 重绘后滚动位置 / 展开状态被重置 | 跨重绘状态放 `state` 或模块级持久对象 |
| 行按压缩放 `scale(0.96)` | 行尾小图标按钮点不中 | 行按下只换底色；行内图标按钮不位移 |
| 空闲/锁屏锁定 | 窗口隐藏或 WebView 暂停时计时也要继续 | 守护线程独立检测（`OpenInputDesktop`） |
