/**
 * Drives the SapVault UI in Edge (the engine WebView2 uses) through the DevTools
 * protocol, so layout can be *measured* instead of guessed. It also renders every
 * view and asserts the expected content is present, which is the check that used
 * to live in tools/check-ui.mjs.
 *
 *   node tools/serve-ui.mjs                                   (once)
 *   node tools/inspect-ui.mjs audit                           current viewport
 *   node tools/inspect-ui.mjs sizes 1000x660,1240x800,1920x1080
 *   node tools/inspect-ui.mjs click 设置
 *   node tools/inspect-ui.mjs eval "document.title"
 *
 * tools/audit-ui.ps1 wraps the whole thing (server + Edge + cleanup).
 */

const PORT = Number(process.env.SAPVAULT_CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}`;

async function findPage() {
  const response = await fetch(`${BASE}/json/list`);
  const targets = await response.json();
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
    // Uncaught page errors must fail the audit: a view that throws silently
    // leaves the previous screen in place.
    this.errors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.errors.push(details.exception?.description ?? details.text);
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        const text = message.params.entry.text ?? "";
        // A missing favicon is not a page error.
        if (!/favicon|Failed to load resource/i.test(text)) this.errors.push(text);
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

const clickByText = (needle, selector = "button, .nav__item, .row, .segmented__item") => `(() => {
  const wanted = ${JSON.stringify(needle)};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const label = (node) =>
    ((node.textContent || "") + " " + (node.getAttribute("title") || "") + " " + (node.getAttribute("aria-label") || ""))
      .replace(/\\s+/g, " ")
      .trim();
  const match =
    nodes.find((node) => label(node) === wanted) ??
    nodes.find((node) => label(node).includes(wanted));
  if (!match) return "not-found:" + wanted;
  match.click();
  return "clicked:" + wanted;
})()`;

const modalText = `(document.querySelector(".modal")?.textContent || "").replace(/\\s+/g, " ")`;

/**
 * Layout audit: only measurable problems, so the output is actionable.
 */
const AUDIT = `(() => {
  const viewport = { width: innerWidth, height: innerHeight };
  const app = document.getElementById("app");
  const report = {
    viewport,
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
    boxes: {},
    overflowX: [],
    outside: [],
    clipped: [],
    smallText: [],
    emptySpace: [],
    ellipsis: [],
  };

  // Elements inside a scroll container are allowed to be taller than the
  // viewport; only elements that cannot be reached are a problem.
  const inScroller = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) return true;
      node = node.parentElement;
    }
    return false;
  };

  const describe = (el) => {
    const cls = (typeof el.className === "string" ? el.className : "")
      .split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 30);
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (text ? ' "' + text + '"' : "");
  };

  for (const selector of [".shell", ".sidebar", ".sidebar__scroll", ".main", ".main__header",
                          ".content", ".content--split", ".detail", ".settings-grid", ".modal"]) {
    const el = app.querySelector(selector) || document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    report.boxes[selector] = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    };
  }

  const roots = [app, document.querySelector(".modal-root")].filter(Boolean);
  for (const root of roots) {
    for (const el of root.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      const isFormControl = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
      if (!isFormControl && el.clientWidth > 0 && el.scrollWidth - el.clientWidth > 2 && style.overflowX !== "visible") {
        if (style.textOverflow === "ellipsis") {
          report.ellipsis.push({ who: describe(el) });
        } else {
          report.overflowX.push({ who: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        }
      }
      const verticallyReachable = inScroller(el) ? true : rect.bottom <= viewport.height + 2;
      if (rect.right > viewport.width + 2 || rect.left < -2 || !verticallyReachable) {
        report.outside.push({
          who: describe(el),
          rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        });
      }
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (ownText && !isFormControl && el.scrollWidth - el.clientWidth > 2 && style.textOverflow !== "ellipsis") {
        report.clipped.push({ who: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
      const fontSize = parseFloat(style.fontSize);
      if (fontSize && fontSize < 11 && (el.textContent || "").trim().length > 2) {
        report.smallText.push({ who: describe(el), fontSize });
      }
    }
  }

  for (const selector of [".sidebar", ".main", ".pane__scroll", ".detail", ".settings-grid"]) {
    const el = app.querySelector(selector);
    if (!el || !el.children.length) continue;
    const box = el.getBoundingClientRect();
    const last = [...el.children].pop().getBoundingClientRect();
    const gap = Math.round(box.bottom - last.bottom);
    if (gap > 120 && selector !== ".sidebar") report.emptySpace.push({ who: selector, gap });
  }

  const uniq = (list) => {
    const seen = new Set();
    return list.filter((item) => {
      const key = item.who + JSON.stringify(item.rect ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  report.overflowX = uniq(report.overflowX).slice(0, 8);
  report.outside = uniq(report.outside).slice(0, 8);
  report.clipped = uniq(report.clipped).slice(0, 8);
  report.smallText = uniq(report.smallText).slice(0, 8);
  report.ellipsis = uniq(report.ellipsis).slice(0, 6);
  report.title = (document.querySelector(".main__title")?.textContent || "").trim().slice(0, 20);
  return report;
})()`;

// ------------------------------------------------------------------ checks --

const results = { pass: [], fail: [] };

function check(name, ok, detail = "") {
  if (ok) results.pass.push(name);
  else results.fail.push(`${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
}

function printReport(label, report) {
  console.log(`\n=== ${label} — ${report.title || "(无标题)"} ===`);
  console.log(
    `  viewport ${report.viewport.width}x${report.viewport.height}   document ${report.document.scrollWidth}x${report.document.scrollHeight}`,
  );
  for (const [selector, box] of Object.entries(report.boxes)) {
    const flags = [];
    const vScroll = box.scrollHeight - box.clientHeight;
    const hScroll = box.scrollWidth - box.clientWidth;
    if (vScroll > 2) flags.push(`vscroll+${vScroll}`);
    if (hScroll > 2) flags.push(`hscroll+${hScroll}`);
    console.log(
      `  ${selector.padEnd(16)} ${String(box.x).padStart(4)},${String(box.y).padStart(4)} ${String(box.width).padStart(4)}x${String(box.height).padStart(4)} ${flags.join(" ")}`,
    );
  }
  const list = (name, items, format) => {
    if (!items.length) return;
    console.log(`  ${name} (${items.length}):`);
    items.slice(0, 6).forEach((item) => console.log(`    - ${format(item)}`));
  };
  list("横向溢出", report.overflowX, (i) => `${i.who}  ${i.scrollWidth}>${i.clientWidth}`);
  list("超出窗口", report.outside, (i) => `${i.who}  [${i.rect.join(",")}]`);
  list("文字被裁切", report.clipped, (i) => `${i.who}  ${i.clientWidth}/${i.scrollWidth}`);
  list("字号过小", report.smallText, (i) => `${i.who}  ${i.fontSize}px`);
  list("大片空白", report.emptySpace, (i) => `${i.who}  bottom gap ${i.gap}px`);
  list("省略号截断（预期行为）", report.ellipsis ?? [], (i) => `${i.who}`);

  check(`${label}：无横向溢出`, report.overflowX.length === 0, JSON.stringify(report.overflowX));
  check(`${label}：无元素超出窗口`, report.outside.length === 0, JSON.stringify(report.outside));
  check(`${label}：无文字被裁切`, report.clipped.length === 0, JSON.stringify(report.clipped));
  check(
    `${label}：页面不超出视口`,
    report.document.scrollHeight <= report.viewport.height + 2 &&
      report.document.scrollWidth <= report.viewport.width + 2,
    `${report.document.scrollWidth}x${report.document.scrollHeight} vs ${report.viewport.width}x${report.viewport.height}`,
  );
  const shell = report.boxes[".shell"];
  if (shell) {
    check(
      `${label}：外壳铺满窗口`,
      Math.abs(shell.height - report.viewport.height) <= 2,
      `shell ${shell.height} vs viewport ${report.viewport.height}`,
    );
  }
}

async function expectContent(cdp, label, needles) {
  const text = await cdp.eval(`(document.getElementById("app").textContent || "").replace(/\\s+/g, " ")`);
  for (const needle of needles) {
    check(`${label}：包含「${needle}」`, text.includes(needle), text);
  }
}

// ------------------------------------------------------------------ actions --

async function ensureUnlocked(cdp) {
  if (!(await cdp.eval("!!document.querySelector('.lock__card')"))) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await cdp.eval(clickByText("解锁", ".lock__card button"));
    for (let wait = 0; wait < 12; wait++) {
      await sleep(250);
      if (await cdp.eval("!!document.querySelector('.shell')")) return true;
    }
  }
  check("解锁进入主界面", false, await cdp.eval("document.getElementById('app').textContent.slice(0, 80)"));
  return true;
}

const VIEWS = [
  {
    nav: "账号",
    label: "账号",
    needles: ["全部账号", "SAP 账号", "SAP 生产机", "SAP 测试机", "循环 5", "有规则", "新建条目", "KNOX01"],
  },
  {
    nav: "关联关系",
    label: "关联关系",
    needles: [
      "SAP 生产机",
      "已绑定",
      "sap-login.json",
      "sap.production.password",
      "SAP_PRD_PASSWORD",
      "查看账号",
    ],
  },
  {
    nav: "同步文件",
    label: "同步文件",
    needles: [
      "已上传文件",
      "sap-login.json",
      "文件内容（选择密码对应的键）",
      "疑似密码",
      "将更新",
      "已最新",
      "第 6 行",
      "全部同步",
    ],
  },
  {
    nav: "设置",
    label: "设置",
    needles: [
      "外观",
      "锁定与剪贴板",
      "全局 Knox ID",
      "默认密码规则",
      "文件关键词",
      "数据与备份",
      "密码关键词",
      "键名必须完全一致",
    ],
  },
];

async function audit(cdp, { includeModals = true } = {}) {
  if (await cdp.eval("!!document.querySelector('.lock__card')")) {
    printReport("解锁界面", await cdp.eval(AUDIT));
    await expectContent(cdp, "解锁界面", ["解锁 SapVault", "使用 Windows 账户解锁", "完全本地"]);
  }
  await ensureUnlocked(cdp);

  for (const view of VIEWS) {
    const clicked = await cdp.eval(clickByText(view.nav, ".nav__item"));
    if (clicked.startsWith("not-found")) continue;
    await sleep(450);
    printReport(view.label, await cdp.eval(AUDIT));
    await expectContent(cdp, view.label, view.needles);
  }

  if (!includeModals) return;

  // Detail pane of the first entry, then the editor modal.
  await cdp.eval(clickByText("账号", ".nav__item"));
  await sleep(350);
  await cdp.eval(clickByText("SAP 生产机", ".row"));
  await sleep(450);
  printReport("账号详情", await cdp.eval(AUDIT));
  await expectContent(cdp, "账号详情", [
    "复制用户名 + 密码",
    "用户名（全局 Knox ID）",
    "KNOX01",
    "密码规则",
    "集团口令策略 2024",
    "密码循环",
    "禁止重复最近 5 个",
    "查看 2 个历史密码",
    "同步文件（2）",
    "sap-login.json",
    "sap.production.password",
    "SAP_PRD_PASSWORD",
    "键已不存在",
  ]);

  await cdp.eval(clickByText("编辑", ".detail__title button"));
  await sleep(800);
  if (!(await cdp.eval("!!document.querySelector('.modal')"))) {
    check("编辑弹窗：能打开", false, "modal missing");
    return;
  }
  printReport("编辑条目弹窗", await cdp.eval(AUDIT));
  const editorText = await cdp.eval(modalText);
  for (const needle of [
    "编辑条目",
    "基本信息",
    "凭据",
    "密码规则",
    "使用规则",
    "不使用规则",
    "按规则生成密码",
    "当前规则：10-40",
    "密码循环与历史",
    "2 个历史密码",
    "2026Q2 轮换",
    "备注",
  ]) {
    check(`编辑弹窗：包含「${needle}」`, editorText.includes(needle), editorText);
  }

  // The rule switch must be reversible (regression guard).
  await cdp.eval(clickByText("不使用规则", ".modal .segmented__item"));
  await sleep(250);
  const ruleOff = await cdp.eval(`${modalText}.includes("按规则生成密码")`);
  await cdp.eval(clickByText("使用规则", ".modal .segmented__item"));
  await sleep(250);
  const ruleOn = await cdp.eval(`${modalText}.includes("按规则生成密码")`);
  check("编辑弹窗：规则可以关闭并重新开启", ruleOff === false && ruleOn === true, `off=${ruleOff} on=${ruleOn}`);

  await cdp.eval(clickByText("取消", ".modal__footer button"));
  await sleep(300);
}

async function resize(cdp, size) {
  const [width, height] = size.split("x").map(Number);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const page = await findPage();
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  try {
    switch (command) {
      case "audit":
        await audit(cdp);
        break;
      case "sizes": {
        const sizes = (argument ?? "1240x800").split(",").map((value) => value.trim());
        for (const size of sizes) {
          await resize(cdp, size);
          console.log(`\n############ ${size} ############`);
          await audit(cdp, { includeModals: false });
        }
        break;
      }
      case "modal": {
        await ensureUnlocked(cdp);
        await cdp.eval(clickByText("账号", ".nav__item"));
        await sleep(350);
        await cdp.eval(clickByText("SAP 生产机", ".row"));
        await sleep(450);
        await cdp.eval(clickByText("编辑", ".detail__title button"));
        await sleep(800);
        printReport("编辑条目弹窗", await cdp.eval(AUDIT));
        break;
      }
      case "resize":
        await resize(cdp, argument ?? "1240x800");
        await audit(cdp);
        break;
      case "click":
        console.log(await cdp.eval(clickByText(argument)));
        await sleep(400);
        printReport("当前视图", await cdp.eval(AUDIT));
        break;
      case "reload":
        await cdp.send("Page.reload", { ignoreCache: true });
        await sleep(1500);
        console.log("reloaded");
        break;
      case "shot": {
        const target = argument ?? "ui-shot.png";
        const result = await cdp.send("Page.captureScreenshot", { format: "png" });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(target, Buffer.from(result.data, "base64"));
        console.log(`saved ${target}`);
        break;
      }
      case "eval":
        console.log(JSON.stringify(await cdp.eval(argument), null, 2));
        break;
      default:
        console.log("commands: audit | sizes <WxH,...> | resize <WxH> | click <text> | reload | shot <file> | eval <js>");
    }
  } finally {
    cdp.close();
  }

  if (cdp.errors.length) {
    console.log("\n---- 页面运行时错误 ----");
    for (const error of [...new Set(cdp.errors)]) {
      console.log(`  ERROR ${String(error).replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  if (command === "audit" || command === "sizes" || command === "resize" || command === "modal") {
    console.log(`\n---- ${results.pass.length} passed, ${results.fail.length} failed ----`);
    for (const line of results.fail) console.log(`  FAIL  ${line}`);
    if (results.fail.length || cdp.errors.length) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("inspect-ui failed:", error.message);
  process.exitCode = 1;
});
