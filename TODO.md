# SapVault 待办（1.1.x 及以后）

这份清单来自 1.0.1 的收尾审查和 1.1.0 的实测反馈。已经处理的问题不在这里重复记录；
每条都写清了「现象 → 证据 → 建议做法」，方便以后直接开工。

优先级：**P2 = 影响体验或会造成误解**，**P3 = 洁癖与长期健康度**。

---

## P2

### 1. 全量重渲染会丢滚动位置

- 现象：账号列表很长时，点一条记录、点一次收藏、切一次分类，列表都会跳回顶部；
  详情面板里「显示密码」、历史密码展开状态也会在任意一次状态变化后被重置。
- 证据：`ui/js/app.js` 的 `render()` 每次都用 `mount(root, …)` 重建整个外壳，
  `captureFocus()` 只保存焦点和光标；`ui/` 目录里没有任何 `scrollTop`/`scrollIntoView`。
- 建议：把滚动偏移纳入快照（按 `.pane__scroll` / `.content--scroll` 的选择器 + 视图名记录 `scrollTop`），
  或把账号列表改成局部重绘。详情面板的展开/显示状态同理，可提到 `state` 里。

### 2. 设置页点一次按钮就滚回顶部（1.1.0 实测反馈）

- 现象：在「设置」页点任意开关、分段按钮或「立即备份」之类的按钮后，页面瞬间跳回顶部，
  要继续调下一项就得重新滚下去。
- 原因：与第 1 条同一个根因。`saveSettings()` → `setState()` → 全量 `render()`，
  而设置页的滚动容器是每次新建的 `div.content.content--scroll`（`ui/js/app.js`），`scrollTop` 归零。
- 建议：和 1 一起修（一次改动即可覆盖列表与设置页）；修完补一条交互回归：
  「设置页滚到中间 → 点一个开关 → 滚动位置不变」。

### 3. 同步文件页没有键搜索，`Ctrl+K` 指向不存在的元素

- 现象：文件里几十上百个键时只能肉眼翻找；在同步/关联页按 `Ctrl+K` 没有任何反应。
- 证据：`ui/js/app.js` 的 `bindShortcuts()` 在非账号页聚焦 `#sap-filter`，而整个前端没有这个 id。
- 建议：给「同步文件」页的键列表加一个过滤框（复用 `.search` 样式），
  把 `Ctrl+K` 指过去；关联关系页也补齐快捷键。

### 4. `sap_line_separator` 在界面上改不了

- 现象：README 1.2 说「分隔符可在设置里选择 CRLF 或 LF」，设置页里找不到这一项。
- 证据：字段在 `src-tauri/src/store.rs` 的 `Settings` 里、被 `copy_sap_credentials`
  和 SAP 登录的剪贴板模式使用，但 `ui/js/views/settings.js` 没有任何控件写它。
- 建议：在「锁定与剪贴板」卡片里加一个二选一控件，并说明它同时影响
  「复制用户名 + 密码」和「剪贴板模式登录」。

### 5. toast 点击关闭失效

- 现象：点提示条不会关闭（只能等它自己消失，所以一直没被发现）。
- 证据：`ui/styles/app.css` 的 `.toasts` 设了 `pointer-events: none`，`.toast` 没有重新开启，
  而 `ui/js/toast.js` 绑了 click 处理。
- 建议：在 `.toast` 上加 `pointer-events: auto`（或把 click 收到 `.toasts` 之外的处理上）。

### 6. 导入保险库用了 `window.prompt`

- 现象：导入加密保险库时弹出系统原生输入框，和应用自己的弹窗风格完全不一致，
  也没有密码强度/错误提示；`modal.js` 里现成的 `promptModal()` 从未被使用（死代码）。
- 证据：`ui/js/views/settings.js` 的导入分支调用 `window.prompt`。
- 建议：改用 `promptModal()`，并加上「密码错误」时的重试循环。

### 7. 模态框没有焦点陷阱

- 现象：弹窗打开时按 Tab 可以一路跑到背后的界面上；关闭后焦点不回到触发按钮。
- 证据：`ui/js/modal.js` 只有 `role="dialog"`、`aria-modal="true"` 和 Esc 关闭。
- 建议：打开时记录触发元素、把焦点限制在 `.modal` 内循环，关闭后还原焦点。

### 8. 编辑条目弹窗内容过多，需要折叠（1.1.0 实测反馈）

- 现象：弹窗把「基本信息 / 凭据 / SAP GUI 登录 / 密码规则 / 密码循环与历史 / 备注」
  六个区块一次性全部铺开，1240×800 下要滚很久才能看完；大部分时候只需要改标题或密码。
- 证据：`ui/js/views/editor.js` 的 `body` 里 6 个 `section(...)`；审计实测弹窗
  `.modal` 为 940×622，内容高度远超可视区。
- 建议：每个区块做成可折叠面板，默认只展开「基本信息」「凭据」；
  「SAP GUI 登录」「密码循环与历史」「密码规则」默认收起。
  展开状态要放在 `state`（或编辑器自己的持久对象）里——放在渲染函数内的局部变量会
  被下一次重渲染重置（参见第 1 条）。

### 9. 表单控件的对齐不统一（1.1.0 实测反馈）

- 现象：同一个卡片里有的字段是「标签在上、控件在下」，有的是「控件 + 按钮排成一行」
  （SAP 卡片里的系统下拉、启动器路径），并且 `form__grid` 用 `auto-fit` 自动决定列数，
  于是换行之后同一行的标签宽度、输入框左右边界看起来参差不齐。
- 证据：`ui/styles/app.css` 的 `.form__row` / `.form__grid` / `.inline-row`，
  以及 `ui/js/views/settings.js`、`ui/js/views/editor.js` 里对这三种布局的混用。
- 建议：定一套规则并只用这一套 —— 要么统一「标签固定列宽 + 控件占满剩余」
  （`grid-template-columns: minmax(5.5rem, max-content) minmax(0, 1fr)`，`align-items: center`），
  要么统一「标签在上」；`form__grid` 的手动列数改成明确断点
  （≥720px 两列、≥1100px 三列），不要依赖 `auto-fit` 随机换行。

### 10. 未配置 SAP 登录的账号没有任何入口提示

- 现象：右键菜单和详情页里的「登录 SAP GUI / 导出快捷方式」只在条目已经配好
  系统 ID 或连接串时出现，所以刚升级到 1.1.0 的账号（以及还没配过的账号）看起来
  「这个功能不存在」，用户不知道要去编辑器里配置。
- 证据：`ui/js/views/accounts.js` 里详情面板的条件是
  `entry.sap?.systemId || entry.sap?.guiparm`，右键菜单的条件是
  `entry.sap?.systemId || entry.hasSapLogin`。
- 建议：SAP 分类的账号在没有配置时也显示一行提示 +「配置 SAP 登录」按钮
  （直接打开编辑器并聚焦到该区块）；或者在详情页放一枚置灰的按钮并说明原因。

### 11. 同步文件页只有在选中文件时才拉取「同步计划」

- 现象：刚进入页面时除第一个文件外，其它文件的状态列显示 `—`，点「重新检测」才补齐。
- 证据：`ui/js/views/sync.js` 的 `renderSync()` 只为 `files[0]` 请求 `filePlan`。
- 建议：进入页面时统一调一次 `filePlans()`；或把首个文件的请求改成全部。

### 12. 关联关系页把账号图标写死成 SAP

- 现象：自建分类下的账号在关联关系页也显示成 SAP 的服务器图标，统计文字也写成「N 个 SAP 账号」。
- 证据：`ui/js/views/associations.js` 里用了 `categoryIconName("sap")` 和固定文案。
- 建议：改用条目自己的分类。

---

## P3

### 13. 死代码与无用状态

- `ui/js/state.js` 的 `state.presets` 从 `info.presets` 取值，但后端 `Bootstrap` 结构体里
  没有这个字段，永远是 `undefined`。要么补后端，要么删掉。
- `ui/js/views/accounts.js` 导入了 `formatBytes`、`openFileKeys` 但没使用。
- `api.js` 里的 `entrySummary`、`vaultStatus`、`paths` 没有任何调用点。
- `commands.rs` 的 `clipboard_clear` 把剪贴板逻辑又抄了一遍，`clipboard.rs` 里已有现成封装。

### 14. 新建保险库页面上挂着一个无关设置

- 现象：首次创建保险库的界面上有「删除条目时二次确认」复选框，而设置页里也有同一个开关。
- 证据：`ui/js/views/lock.js` 的 `createForm()`。
- 建议：去掉，或移到设置页。

### 15. 账号列表缺少键盘导航与语义

- 现象：`role="button"` 的行只处理 Enter/Space，没有上下方向键；也没有 `aria-selected`。
- 建议：加方向键移动选中项，并把 `role` 换成 `listbox/option` 组合。

### 16. `with_vault_mut` 不是事务性的

- 现象：闭包返回 `Err` 时不会回滚内存里的改动，也不会落盘（当前调用方都是先校验后修改，
  所以还没出问题，但这是往后加功能很容易踩的坑）。
- 证据：`src-tauri/src/state.rs` 的 `with_vault_mut()`。
- 建议：改成「校验 → 克隆 → 提交」，或让闭包只声明变更。

### 17. 界面文案里的「SAP 换行格式」说明可以合并

- 「复制用户名 + 密码」在两个页面有三处不同长度的手写说明，
  等 SAP 登录功能稳定后可以统一成一句带链接的说明。

---

## 已在 1.1.0 处理

### 审计算子（原 P1）

- **启动竞态**：脚本只等 DevTools 端口就绪就开始测量，此时页面还没解析完，
  `document.getElementById("app")` 是 `null`，于是必然报
  `inspect-ui failed: TypeError: Cannot read properties of null (reading 'querySelector')`。
  现在 `tools/inspect-ui.mjs` 里有 `waitForApp()`，所有模式都会先等到界面渲染完成（`eval` 除外）。
- **泄漏 headless Edge**：原来只 `Kill()` 父进程，渲染/GPU 子进程继续持有临时 profile，
  于是 `finally` 里的删除静默失败、每跑一次多留一套进程（这台机器上累积过 37 个）。
  现在 `tools/audit-ui.ps1` 按 `--user-data-dir` 结束整棵进程树，并重试删除 profile，
  失败时给出警告。
- 顺手把交互回归并进同一个脚本：`pwsh tools/audit-ui.ps1 -Interactions`。

### SAP GUI 快捷登录（新功能）

- 解析 `SAPUILandscape.xml`（含 `Includes` 递归、`Messageservers`、`Routers`、`Workspaces`、
  `sapguiid` 引用、路由器前缀形式），按 SAP 官方 *SAP UI Landscape* 文档实现。
- 通过 SAP 自带的 `sapshcut.exe` 启动 SAP GUI，导出 `.sap` 快捷方式（不含密码）。
- 密码传递方式二选一：命令行明文（一次点击）或剪贴板粘贴（默认，更安全）。
- 详见 README 的 1.6 与 2.6 两节。
