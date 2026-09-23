/**
 * Interaction checks for the fixture-backed UI.
 *
 * Where `inspect-ui.mjs` measures layout, this one *acts*: it sends real mouse
 * input through the DevTools protocol (so press geometry is exercised the way a
 * person clicks) and replays Tauri window events the way the backend emits them.
 * Covered: edge clicks on the per-row icon buttons, the account context menu,
 * drag-and-drop upload, and "rotate a password → sync the bound files".
 *
 *   node tools/serve-ui.mjs        (tools/audit-ui.ps1 starts one as well)
 *   node tools/check-interactions.mjs
 */

const CDP_PORT = Number(process.env.SAPVAULT_CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${CDP_PORT}`;
const DROPPED = ["C:\\tmp\\dropped-sap-login.json"];

async function findPage() {
  const targets = await (await fetch(`${BASE}/json/list`)).json();
  const page = targets.find(
    (target) =>
      target.type === "page" && target.webSocketDebuggerUrl && !target.url.startsWith("devtools://"),
  );
  if (!page) throw new Error("no page target; is Edge running with --remote-debugging-port?");
  return page;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.errors.push(details.exception?.description ?? details.text);
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    }
    return result.result?.value;
  }
  close() {
    this.socket.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = { pass: [], fail: [] };

function check(name, ok, detail = "") {
  if (ok) results.pass.push(name);
  else {
    results.fail.push(
      `${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 240)}` : ""}`,
    );
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  [${detail}]`}`);
}

async function clickPoint(cdp, x, y, button = "left") {
  const common = { x, y, button, clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...common,
    buttons: button === "left" ? 1 : 2,
  });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  await sleep(220);
}

const clickByText = (needle, selector = "button, .nav__item, .row, .menu__item") => `(() => {
  const wanted = ${JSON.stringify(needle)};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const label = (node) =>
    ((node.textContent || "") + " " + (node.getAttribute("title") || "") + " " + (node.getAttribute("aria-label") || ""))
      .replace(/\\s+/g, " ").trim();
  const match = nodes.find((node) => label(node) === wanted) ?? nodes.find((node) => label(node).includes(wanted));
  if (!match) return "not-found:" + wanted;
  match.click();
  return "clicked:" + wanted;
})()`;

const buttonBox = (title) => `(() => {
  const node = document.querySelector('.row__actions button[title="' + ${JSON.stringify(title)} + '"]');
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height];
})()`;

const TOASTS = "document.querySelectorAll('.toast').length";
const TOAST_TEXTS = `[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim())`;
const FIRST_FAV = `document.querySelector('.row__actions button[title$="收藏"]')?.title ?? ""`;
const MODAL = `(() => { const m = document.querySelector('.modal'); if (!m) return null; return { title: m.querySelector('.modal__title')?.textContent ?? "", text: m.textContent.replace(/\\s+/g, " ").trim().slice(0, 320) }; })()`;

async function main() {
  const page = await findPage();
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  // The size audit may leave the window at whatever it measured last; pin it to
  // the size these checks were written for, so geometry-dependent cases (for
  // example "the detail pane can actually scroll") stay meaningful.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1240,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);

  if (await cdp.eval("!!document.querySelector('.lock__card')")) {
    await cdp.eval(clickByText("解锁", ".lock__card button"));
    await sleep(1500);
  }
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(400);
  check("进入账号列表", await cdp.eval("!!document.querySelector('.row')"));

  // ------------------------------------------------------- 0. Ctrl+K 落点 --
  // `Ctrl+K` used to focus `#sap-filter`, an id that never existed, so the key
  // did nothing on any page except the account list.
  const pressCtrlK = `document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`;
  const activeId = `(document.activeElement && document.activeElement.id) || ""`;
  const focusTargets = [
    ["账号", null, "global-search"],
    ["同步文件", null, "sync-key-filter"],
    ["关联关系", null, "assoc-filter"],
  ];
  for (const [nav, , expected] of focusTargets) {
    await cdp.eval(clickByText(nav, ".nav__item"));
    await sleep(420);
    await cdp.eval(pressCtrlK);
    await sleep(200);
    const focused = await cdp.eval(activeId);
    check(`Ctrl+K 在「${nav}」页聚焦 ${expected}`, focused === expected, `focused=${focused}`);
  }
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(400);

  // ------------------------------------------------------- 1. 行内按钮点击 --
  // Press geometry was the original bug: clicking the right or the top edge of
  // a 26 px button landed on the row instead of the button.
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.75, 0.5],
    [0.9, 0.5],
    [0.5, 0.2],
    [0.5, 0.8],
  ]) {
    const box = await cdp.eval(buttonBox("复制密码"));
    if (!box) {
      check("列表里的「复制密码」按钮存在", false, "not found");
      continue;
    }
    // Toasts expire on their own, so the check clears them first and only asks
    // whether this click produced one.
    await cdp.eval("document.getElementById('toasts').replaceChildren()");
    await clickPoint(cdp, box[0] + box[2] * fx, box[1] + box[3] * fy);
    const after = await cdp.eval(TOASTS);
    check(
      `点击「复制密码」（${Math.round(fx * 100)}% 宽 / ${Math.round(fy * 100)}% 高）命中按钮`,
      after > 0,
      JSON.stringify(await cdp.eval(TOAST_TEXTS)),
    );
  }

  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.9, 0.2],
    [0.5, 0.2],
  ]) {
    const before = await cdp.eval(FIRST_FAV);
    const box = await cdp.eval(buttonBox(before));
    if (!box) {
      check("列表里的收藏按钮存在", false, JSON.stringify(before));
      break;
    }
    await clickPoint(cdp, box[0] + box[2] * fx, box[1] + box[3] * fy);
    const after = await cdp.eval(FIRST_FAV);
    check(
      `点击「${before}」（${Math.round(fx * 100)}% 宽 / ${Math.round(fy * 100)}% 高）切换到「${after}」`,
      Boolean(after) && after !== before,
      `${before} -> ${after}`,
    );
  }

  // ------------------------------------------------------- 搜索框与备注搜索 --
  const searchBox = await cdp.eval(`(() => {
    const input = document.getElementById("global-search");
    if (!input) return null;
    const style = getComputedStyle(input);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
    const text = canvas.measureText(input.placeholder).width;
    const content = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { placeholder: input.placeholder, text: Math.round(text), content: Math.round(content) };
  })()`);
  check(
    "搜索框占位文字完整显示",
    Boolean(searchBox) && searchBox.text <= searchBox.content,
    JSON.stringify(searchBox),
  );

  const unfiltered = await cdp.eval("document.querySelectorAll('.row').length");
  await cdp.eval(
    `(() => { const input = document.getElementById("global-search"); input.value = "轮换"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await sleep(400);
  const hits = await cdp.eval(
    `[...document.querySelectorAll('.row')].map((row) => row.querySelector('.row__title')?.textContent.trim() ?? "")`,
  );
  check(
    "搜索能命中备注内容",
    unfiltered > 1 && hits.length === 1 && hits[0].includes("SAP 生产机"),
    `${unfiltered} -> ${JSON.stringify(hits)}`,
  );

  await cdp.eval(
    `(() => { const input = document.getElementById("global-search"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await sleep(350);
  check(
    "清空搜索后列表恢复",
    (await cdp.eval("document.querySelectorAll('.row').length")) === unfiltered,
  );

  // ----------------------------------------------------------- 4. 右键菜单 --

  const rowPoint = await cdp.eval(
    "(() => { const r = document.querySelector('.row').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
  );
  await clickPoint(cdp, rowPoint[0], rowPoint[1], "right");
  const menu = await cdp.eval(
    `(() => { const m = document.querySelector('.menu'); if (!m) return null; const b = m.getBoundingClientRect(); return { labels: [...m.querySelectorAll('.menu__label')].map((n) => n.textContent), box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }; })()`,
  );
  check("账号行右键弹出应用菜单", Boolean(menu), JSON.stringify(menu));
  check(
    "菜单里同时有复制与收藏",
    Boolean(menu) &&
      ["复制密码", "复制用户名 + 密码"].every((label) => menu.labels.includes(label)) &&
      menu.labels.some((label) => label === "收藏" || label === "取消收藏"),
    JSON.stringify(menu?.labels),
  );

  await cdp.eval("document.getElementById('toasts').replaceChildren()");
  const clicked = await cdp.eval(clickByText("复制密码", ".menu__item"));
  await sleep(350);
  const afterCopy = await cdp.eval(TOASTS);
  const menuGone = !(await cdp.eval("!!document.querySelector('.menu')"));
  check(
    "菜单里点「复制密码」生效并关闭菜单",
    afterCopy > 0 && menuGone,
    `${clicked} menuGone=${menuGone} ${JSON.stringify(await cdp.eval(TOAST_TEXTS))}`,
  );

  const prevented = await cdp.eval(
    `(() => { const header = document.querySelector('.main__header'); const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); header.dispatchEvent(e); return { prevented: e.defaultPrevented, menu: !!document.querySelector('.menu') }; })()`,
  );
  check(
    "其它位置的右键菜单被禁用",
    prevented.prevented === true && prevented.menu === false,
    JSON.stringify(prevented),
  );

  // ------------------------------------------------------- 2. 拖拽上传文件 --
  await cdp.eval(clickByText("同步文件", ".nav__item"));
  await sleep(400);
  await cdp.eval(
    `window.__FIXTURES__.emit("tauri://drag-enter", { paths: ${JSON.stringify(DROPPED)}, position: { x: 10, y: 10 } })`,
  );
  await sleep(250);
  const dropzone = await cdp.eval(
    `(() => { const z = document.querySelector('.dropzone'); return z ? z.textContent.replace(/\\s+/g, " ").trim().slice(0, 30) : null; })()`,
  );
  check("拖入文件时显示投放层", Boolean(dropzone), String(dropzone));

  await cdp.eval(
    `window.__FIXTURES__.emit("tauri://drag-drop", { paths: ${JSON.stringify(DROPPED)}, position: { x: 10, y: 10 } })`,
  );
  await sleep(500);
  const dialog = await cdp.eval(MODAL);
  check(
    "拖放后打开上传对话框",
    Boolean(dialog) && dialog.title === "上传同步文件" && dialog.text.includes("dropped-sap-login.json"),
    JSON.stringify(dialog),
  );
  check("投放层在拖放后消失", !(await cdp.eval("!!document.querySelector('.dropzone')")));
  await cdp.eval(clickByText("取消", ".modal__footer button"));
  await sleep(250);

  // --------------------------------------------------- 3. 改密码提示同步 --
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(300);
  await cdp.eval(clickByText("SAP 生产机", ".row"));
  await sleep(400);
  await cdp.eval(clickByText("编辑", ".detail__title button"));
  await sleep(900);
  // Regression: the notes box is a <textarea>, and `h()` used to set its value
  // as an attribute — the box rendered empty and saving then wiped the notes.
  const notesField = await cdp.eval(
    `(() => { const area = document.querySelector('.modal textarea.textarea'); return area ? area.value : null; })()`,
  );
  check(
    "编辑条目：备注内容会带进弹窗",
    typeof notesField === "string" && notesField.includes("每季度轮换"),
    JSON.stringify(notesField),
  );
  await cdp.eval(
    `(() => { const input = document.getElementById("editor-password"); input.value = "BrandNew#2026"; input.dispatchEvent(new Event("input", { bubbles: true })); return input.value; })()`,
  );
  await cdp.eval(clickByText("保存", ".modal__footer button"));
  await sleep(900);
  const rotated = await cdp.eval(MODAL);
  const savedNotes = await cdp.eval(`window.__FIXTURES__.entry.notes`);
  check(
    "保存后备注没有被清空",
    typeof savedNotes === "string" &&
      savedNotes.includes("每季度轮换") &&
      savedNotes.includes("wiki.example.com"),
    String(savedNotes).slice(0, 80),
  );
  check(
    "改密码后提示文件需要同步",
    Boolean(rotated) &&
      rotated.title === "文件里的密码还是旧的" &&
      rotated.text.includes("sap-login.json") &&
      rotated.text.includes("现在同步"),
    JSON.stringify(rotated),
  );

  await cdp.eval("document.getElementById('toasts').replaceChildren()");
  await cdp.eval(clickByText("现在同步", ".modal__footer button"));
  await sleep(900);
  check(
    "可以从提示里直接同步",
    (await cdp.eval(TOASTS)) > 0 &&
      !(await cdp.eval("!!document.querySelector('.modal')")),
    JSON.stringify(await cdp.eval(TOAST_TEXTS)),
  );


  // --------------------------------------------------- 6. SAP GUI 一键登录 --
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(300);
  await cdp.eval(clickByText("SAP 生产机", ".row"));
  await sleep(400);
  const sapDetail = await cdp.eval(
    `(() => { const d = document.querySelector('.detail'); return d ? d.textContent.replace(/\\s+/g, " ") : ""; })()`,
  );
  check(
    "详情页出现 SAP GUI 登录入口",
    sapDetail.includes("登录 SAP GUI") && sapDetail.includes("导出快捷方式"),
    sapDetail.slice(0, 140),
  );

  const sapRowButton = await cdp.eval(buttonBox("登录 SAP GUI"));
  check("账号行有 SAP 登录按钮", Array.isArray(sapRowButton), JSON.stringify(sapRowButton));

  await cdp.eval("document.getElementById('toasts').replaceChildren()");
  await cdp.eval(clickByText("登录 SAP GUI", ".detail button"));
  await sleep(450);
  const sapToasts = await cdp.eval(TOAST_TEXTS);
  check(
    "点「登录 SAP GUI」会启动并提示",
    sapToasts.some((text) => text.includes("SAP GUI")),
    JSON.stringify(sapToasts),
  );

  const sapRowPoint = await cdp.eval(
    "(() => { const r = document.querySelector('.row').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
  );
  await clickPoint(cdp, sapRowPoint[0], sapRowPoint[1], "right");
  const sapMenu = await cdp.eval(
    `(() => { const m = document.querySelector('.menu'); return m ? [...m.querySelectorAll('.menu__label')].map((n) => n.textContent) : null; })()`,
  );
  check(
    "右键菜单里有 SAP 登录",
    Boolean(sapMenu) && sapMenu.includes("登录 SAP GUI"),
    JSON.stringify(sapMenu),
  );
  await cdp.eval('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await sleep(250);

  // Focus the trigger first: closing the dialog has to give focus back to it.
  await cdp.eval(`(() => {
    const label = (node) => ((node.textContent || "") + " " + (node.getAttribute("title") || "") + " " + (node.getAttribute("aria-label") || "")).trim();
    const button = [...document.querySelectorAll('.detail__title button')].find((node) => label(node).includes('编辑'));
    button?.focus();
    button?.click();
  })()`);
  await sleep(900);
  const trap = await cdp.eval(`(() => {
    const modal = document.querySelector('.modal');
    if (!modal) return null;
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const list = [...modal.querySelectorAll(selector)].filter((node) => node.getClientRects().length > 0);
    if (list.length < 2) return { list: list.length };
    const first = list[0];
    const last = list[list.length - 1];
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const forward = document.activeElement === first;
    first.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    const backward = document.activeElement === last;
    // A control that lives behind the dialog must never keep the focus.
    const stray = document.createElement('button');
    document.body.append(stray);
    stray.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const pulledBack = modal.contains(document.activeElement);
    stray.remove();
    return { list: list.length, forward, backward, pulledBack };
  })()`);
  check(
    "弹窗焦点陷阱：Tab 在弹窗内循环",
    Boolean(trap) && trap.forward === true && trap.backward === true,
    JSON.stringify(trap),
  );
  check(
    "弹窗焦点陷阱：焦点跑到弹窗外会被拉回",
    Boolean(trap) && trap.pulledBack === true,
    JSON.stringify(trap),
  );
  const sapPicker = await cdp.eval(
    `(() => {
      const combo = document.getElementById("editor-sap-system");
      if (!combo) return null;
      combo.querySelector(".combo__control")?.click();
      const panel = document.querySelector("#combo-root .combo__panel");
      const result = {
        options: panel ? [...panel.querySelectorAll(".combo__option")].map((node) => node.textContent.trim()) : [],
        hasSearch: Boolean(panel?.querySelector(".combo__search")),
        value: combo.querySelector(".combo__value")?.textContent ?? "",
      };
      combo.querySelector(".combo__control")?.click();
      return result;
    })()`,
  );
  check(
    "编辑器列出 SAP Logon 里的系统",
    Boolean(sapPicker) &&
      sapPicker.options.some((text) => text.includes("PRD")) &&
      sapPicker.options.some((text) => text.includes("P20")),
    JSON.stringify(sapPicker?.options),
  );
  check(
    "同名系统 ID 有标记",
    Boolean(sapPicker) && sapPicker.options.some((text) => text.includes("（同名）")),
    JSON.stringify(sapPicker?.options),
  );
  // 1.2.3: native <select> replaced by the combo box the sync page uses, minus
  // the search box (the list here is short and typed-ahead instead).
  check(
    "SAP Logon 系统下拉与账号选择器同款、且不带搜索框",
    Boolean(sapPicker) && sapPicker.hasSearch === false && sapPicker.options.length >= 3,
    JSON.stringify(sapPicker),
  );
  // The category picker was the other native <select>.
  const categoryPicker = await cdp.eval(
    `(() => {
      const combo = document.getElementById("editor-category");
      if (!combo) return null;
      combo.querySelector(".combo__control")?.click();
      const panel = document.querySelector("#combo-root .combo__panel");
      const options = panel ? [...panel.querySelectorAll(".combo__option")].map((node) => node.textContent.trim()) : [];
      const hasSearch = Boolean(panel?.querySelector(".combo__search"));
      const row = panel ? [...panel.querySelectorAll(".combo__option")].find((node) => node.textContent.includes("内部系统")) : null;
      row?.click();
      const after = {
        label: combo.querySelector(".combo__value")?.textContent ?? "",
        sapBlock: (document.querySelector(".modal")?.textContent ?? "").includes("只有「SAP 账号」分类"),
      };
      return { options, hasSearch, ...after };
    })()`,
  );
  check(
    "分类下拉与账号选择器同款、且不带搜索框",
    Boolean(categoryPicker) &&
      categoryPicker.hasSearch === false &&
      categoryPicker.options.some((text) => text.includes("SAP 账号")),
    JSON.stringify(categoryPicker),
  );
  check(
    "分类改选后回显并联动 SAP 区块",
    Boolean(categoryPicker) &&
      categoryPicker.label.includes("内部系统") &&
      categoryPicker.sapBlock === true,
    JSON.stringify(categoryPicker),
  );
  await cdp.eval(`(() => {
    const combo = document.getElementById("editor-category");
    combo?.querySelector(".combo__control")?.click();
    const row = [...document.querySelectorAll("#combo-root .combo__option")].find((node) => node.textContent.includes("SAP 账号"));
    row?.click();
  })()`);
  await sleep(300);
  await cdp.eval(clickByText("取消", ".modal__footer button"));
  await sleep(300);
  check(
    "关闭弹窗后焦点回到触发按钮",
    await cdp.eval(
      `(() => { const el = document.activeElement; if (!el) return false; return ((el.textContent || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("aria-label") || "")).includes("编辑"); })()`,
    ),
    await cdp.eval(`document.activeElement?.outerHTML?.slice(0, 80) ?? ""`),
  );

  // ------------------------------- 7. 分类切换 / 非 SAP 账号 / 未配置登录 --
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(300);
  await cdp.eval(clickByText("SAP 生产机", ".row"));
  await sleep(400);
  const detailBefore = await cdp.eval(
    `document.querySelector('.detail__name')?.textContent ?? ""`,
  );
  await cdp.eval(clickByText("通用账号", ".nav__item"));
  await sleep(450);
  const afterSwitch = await cdp.eval(
    `(() => ({ name: document.querySelector('.detail__name')?.textContent ?? "", empty: !!document.querySelector('.empty__title') }))()`,
  );
  check(
    "切换分类后详情不再残留上一个账号",
    Boolean(detailBefore) && !afterSwitch.name && afterSwitch.empty,
    `${detailBefore} -> ${JSON.stringify(afterSwitch)}`,
  );

  await cdp.eval(clickByText("内部系统", ".nav__item"));
  await sleep(400);
  await cdp.eval(clickByText("内部系统门户", ".row"));
  await sleep(450);
  const webDetail = await cdp.eval(
    `document.querySelector('.detail')?.textContent.replace(/\\s+/g, " ") ?? ""`,
  );
  check(
    "非 SAP 账号详情不显示同步文件",
    Boolean(webDetail) &&
      !webDetail.includes("同步文件（") &&
      webDetail.includes("内部系统门户"),
    webDetail.slice(0, 160),
  );
  check(
    "非 SAP 账号详情不显示 SAP 登录区块",
    !webDetail.includes("SAP GUI 登录"),
    webDetail.slice(0, 160),
  );

  await cdp.eval(clickByText("SAP 账号", ".nav__item"));
  await sleep(400);
  await cdp.eval(clickByText("SAP 测试机", ".row"));
  await sleep(450);
  const unconfigured = await cdp.eval(
    `document.querySelector('.detail')?.textContent.replace(/\\s+/g, " ") ?? ""`,
  );
  check(
    "未配置登录的 SAP 账号给出配置入口",
    unconfigured.includes("SAP GUI 登录") && unconfigured.includes("配置 SAP 登录"),
    unconfigured.slice(0, 200),
  );
  check(
    "未配置登录的 SAP 账号不显示登录按钮",
    !unconfigured.includes("导出快捷方式"),
    unconfigured.slice(0, 160),
  );

  // ---------------------------------------------- 8. 滚动位置在重绘后保留 --
  const scroller = `document.querySelector('[data-scroll-key="accounts-detail"]')`;
  await cdp.eval(`${scroller}.scrollTop = 240`);
  await sleep(150);
  const scrolledTo = await cdp.eval(`${scroller}.scrollTop`);
  await cdp.eval(
    `document.querySelector('.row__actions button[title$="收藏"]')?.click()`,
  );
  await sleep(500);
  const keptScroll = await cdp.eval(`${scroller}.scrollTop`);
  check(
    "详情面板滚动位置在重渲染后保留",
    scrolledTo > 100 && Math.abs(keptScroll - scrolledTo) <= 2,
    `${scrolledTo} -> ${keptScroll}`,
  );

  // ------------------------------------------------- 9. 备注链接 / 绑定下拉 --
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(400);
  await cdp.eval(clickByText("SAP 生产机", ".row"));
  await sleep(450);
  const noteLink = await cdp.eval(
    `(() => { const a = document.querySelector('.notes__link'); return a ? { text: a.textContent, href: a.getAttribute('href'), tag: a.tagName } : null; })()`,
  );
  check(
    "备注里的链接渲染成可点元素且不带 href",
    Boolean(noteLink) &&
      noteLink.text.startsWith("https://wiki.example.com/") &&
      noteLink.href === null &&
      noteLink.tag === "A",
    JSON.stringify(noteLink),
  );
  await cdp.eval(
    `window.__FIXTURES__.openedLinks.length = 0; document.querySelector('.notes__link')?.click()`,
  );
  await sleep(400);
  const opened = await cdp.eval(`window.__FIXTURES__.openedLinks`);
  check(
    "点备注链接会交给系统浏览器打开",
    Array.isArray(opened) && opened.length === 1 && opened[0].startsWith("https://wiki.example.com/"),
    JSON.stringify(opened),
  );

  await cdp.eval(clickByText("同步文件", ".nav__item"));
  await sleep(500);
  await cdp.eval(
    `document.querySelectorAll('.combo__control')[0]?.click()`,
  );
  await sleep(300);
  const comboOpen = await cdp.eval(
    `(() => { const panel = document.querySelector('.combo__panel'); return panel ? { options: panel.querySelectorAll('.combo__option').length, hasSearch: !!panel.querySelector('.combo__search') } : null; })()`,
  );
  check(
    "绑定账号的下拉可搜索",
    Boolean(comboOpen) && comboOpen.hasSearch && comboOpen.options >= 2,
    JSON.stringify(comboOpen),
  );
  await cdp.eval(
    `(() => { const input = document.querySelector('.combo__search'); input.value = "测试"; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(300);
  const filtered = await cdp.eval(
    `(() => { const rows = [...document.querySelectorAll('.combo__option')].map((n) => n.textContent.trim()); return rows; })()`,
  );
  check(
    "输入关键字后只留下匹配的账号",
    Array.isArray(filtered) &&
      filtered.some((text) => text.includes("SAP 测试机")) &&
      !filtered.some((text) => text.includes("内部系统门户")),
    JSON.stringify(filtered),
  );
  await cdp.eval(
    `(() => { const row = [...document.querySelectorAll('.combo__option')].find((n) => n.textContent.includes("SAP 测试机")); row?.click(); })()`,
  );
  await sleep(600);
  const boundLabel = await cdp.eval(
    `document.querySelector('.combo__value')?.textContent ?? ""`,
  );
  check(
    "选中后绑定生效并回显账号名",
    boundLabel.includes("SAP 测试机"),
    String(boundLabel),
  );

  // 表格形式的文件（.env / TOML / INI …）里，选择器同样要能打开并选中：
  // 曾经被 .table / .table__cell 的 overflow:hidden 裁掉，看起来像禁用。
  await cdp.eval(
    `(() => { const rows = [...document.querySelectorAll('.pane__scroll--tight .row')]; rows.find((r) => r.textContent.includes('.env'))?.click(); })()`,
  );
  await sleep(500);
  const tablePicker = await cdp.eval(
    `(() => ({ rows: document.querySelectorAll('.table__row').length, pickers: document.querySelectorAll('.table__row .combo__control').length }))()`,
  );
  check(
    "表格形式的内容里存在账号选择器",
    tablePicker.pickers > 0,
    JSON.stringify(tablePicker),
  );
  const controlPoint = await cdp.eval(`(() => {
    const control = document.querySelector('.table__row .combo__control');
    if (!control) return null;
    const rect = control.getBoundingClientRect();
    return [rect.x + rect.width / 2, rect.y + rect.height / 2];
  })()`);
  if (controlPoint) await clickPoint(cdp, controlPoint[0], controlPoint[1]);
  await sleep(350);
  const panelHit = await cdp.eval(`(() => {
    const panel = document.querySelector('#combo-root .combo__panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 18);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      reachable: Boolean(hit && panel.contains(hit)),
      panels: document.querySelectorAll('#combo-root .combo__panel').length,
    };
  })()`);
  check(
    "表格里的选择器面板没有被裁剪",
    Boolean(panelHit) && panelHit.reachable && panelHit.width > 100 && panelHit.height > 20,
    JSON.stringify(panelHit),
  );
  const optionPoint = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('#combo-root .combo__option')].find((n) => n.textContent.includes("SAP 测试机"));
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return [rect.x + rect.width / 2, rect.y + rect.height / 2];
  })()`);
  if (optionPoint) await clickPoint(cdp, optionPoint[0], optionPoint[1]);
  await sleep(800);
  const tableState = await cdp.eval(`(() => ({
    rows: document.querySelectorAll('.table__row').length,
    value: document.querySelector('.table__row .combo__value')?.textContent ?? null,
    panelOpen: !!document.querySelector('#combo-root .combo__panel'),
    hasTree: !!document.querySelector('.tree'),
    selectedFile: (document.querySelector('.pane__scroll--tight .row.is-selected')?.textContent ?? "").trim().slice(0, 24),
    envBindings: (window.__FIXTURES__?.envFile?.bindings ?? []).map((b) => b.keyPath + "->" + b.entryId),
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
  }))()`);
  check(
    "表格里选中账号后绑定生效",
    Boolean(tableState.value) && tableState.value.includes("SAP 测试机"),
    JSON.stringify({ controlPoint, panelHit, optionPoint, tableState }),
  );

  // 面板内部的滚动不能把下拉框关掉（选项多的时候要能滚），页面滚动才关。
  await cdp.eval(`document.querySelector('.combo__control')?.click()`);
  await sleep(350);
  const scrollInside = await cdp.eval(`(() => {
    const options = document.querySelector('#combo-root .combo__options');
    if (!options) return null;
    options.scrollTop = 8;
    options.dispatchEvent(new Event("scroll", { bubbles: true }));
    return !!document.querySelector('#combo-root .combo__panel');
  })()`);
  check("滚动下拉框内容不会把它关掉", scrollInside === true, String(scrollInside));
  const scrollOutside = await cdp.eval(`(() => {
    document.querySelector('.pane__scroll')?.dispatchEvent(new Event("scroll", { bubbles: true }));
    return !document.querySelector('#combo-root .combo__panel');
  })()`);
  check("滚动页面会关掉下拉框", scrollOutside === true, String(scrollOutside));

  // ------------------------------------------------------- 5. 钥匙图标重画 --
  const keyIcon = await cdp.eval(
    `(() => { const svg = document.querySelector('.brand__mark svg'); return svg ? svg.outerHTML : null; })()`,
  );
  check(
    "品牌钥匙图标已更新",
    Boolean(keyIcon) && keyIcon.includes("M6.6 8.6a3.4") && !keyIcon.includes("M15.5 3.5a5 5"),
    String(keyIcon).slice(0, 160),
  );

  // ------------------------------------------------ 10. 导入保险库弹窗 --
  // 1.2.3: importing used `window.prompt` (a system dialog that ignores the app
  // theme and cannot show "wrong password"); it is now the app's own prompt,
  // and a rejected password keeps the dialog open for another try.
  await cdp.eval(clickByText("设置", ".nav__item"));
  await sleep(450);
  await cdp.eval(`window.__FIXTURES__.setPickFiles(["C:\\\\Users\\\\me\\\\backup.sapvault"])`);
  await cdp.eval(clickByText("导入"));
  await sleep(400);
  const importConfirm = await cdp.eval(MODAL);
  check("导入保险库先确认", importConfirm?.title === "导入保险库", JSON.stringify(importConfirm));
  await cdp.eval(clickByText("选择文件", ".modal__footer button"));
  await sleep(1000);
  const importPrompt = await cdp.eval(
    `(() => { const m = document.querySelector('.modal'); if (!m) return null; return { title: m.querySelector('.modal__title')?.textContent ?? "", passwordField: !!m.querySelector('input[type="password"]'), text: m.textContent.replace(/\\s+/g, " ").trim().slice(0, 120) }; })()`,
  );
  check(
    "导入改用应用自己的密码弹窗",
    Boolean(importPrompt) && importPrompt.title === "导入加密保险库" && importPrompt.passwordField,
    JSON.stringify(importPrompt),
  );
  await cdp.eval(
    `(() => { const input = document.querySelector('.modal input.input'); input.value = "nope"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await cdp.eval(clickByText("导入", ".modal__footer button"));
  await sleep(700);
  const retry = await cdp.eval(
    `(() => { const m = document.querySelector('.modal'); return { open: !!m, text: m?.textContent.replace(/\\s+/g, " ").trim().slice(0, 120) ?? "" }; })()`,
  );
  check(
    "主密码错误时弹窗不关闭并给出提示",
    retry.open && retry.text.includes("主密码不正确"),
    JSON.stringify(retry),
  );
  await cdp.eval(clickByText("取消", ".modal__footer button"));
  await sleep(300);

  cdp.close();

  if (cdp.errors.length) {
    console.log("\n---- 页面运行时错误 ----");
    for (const error of new Set(cdp.errors)) {
      console.log(`  ERROR ${String(error).replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  console.log(`\n---- ${results.pass.length} passed, ${results.fail.length} failed ----`);
  for (const line of results.fail) console.log(`  FAIL  ${line}`);
  if (results.fail.length || cdp.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("interaction check failed:", error.message);
  process.exitCode = 1;
});
