/**
 * View-layer smoke test.
 *
 * The frontend is plain ES modules, so every view can be executed in Node
 * against a minimal DOM shim and a stubbed Tauri bridge. This catches the class
 * of mistakes a browser would only reveal at runtime: missing exports, bad
 * property access, and view functions that throw while rendering.
 *
 * Run with:  node tools/check-ui.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.join(here, "..", "ui", "js");

// --------------------------------------------------------------- DOM shim ---

class ClassList {
  constructor() {
    this.items = new Set();
  }
  add(...names) {
    names.forEach((name) => this.items.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.items.delete(name));
  }
  toggle(name, force) {
    const next = force === undefined ? !this.items.has(name) : Boolean(force);
    if (next) this.items.add(name);
    else this.items.delete(name);
    return next;
  }
  contains(name) {
    return this.items.has(name);
  }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.classList = new ClassList();
    this.hidden = false;
    this.type = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._text = "";
  }
  set className(value) {
    this.attributes.class = String(value);
    this.classList.items = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.attributes.class ?? "";
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get textContent() {
    const childText = this.children.map((child) => child.textContent ?? "").join("");
    return `${this._text}${childText}`;
  }
  set innerHTML(value) {
    this._text = String(value);
    this.children = [];
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== handler);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
  select() {}
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  remove() {}
}

const roots = new Map();
const documentStub = {
  documentElement: new Element("html"),
  activeElement: null,
  body: new Element("body"),
  createElement: (tag) => new Element(tag),
  createElementNS: (_namespace, tag) => new Element(tag),
  createTextNode: (text) => ({ textContent: String(text) }),
  createDocumentFragment: () => new Element("#fragment"),
  getElementById: (id) => {
    if (!roots.has(id)) roots.set(id, new Element("div"));
    return roots.get(id);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ------------------------------------------------------------- IPC bridge ---

const invokeLog = [];
let fixtures = {};
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function invoke(command, args) {
  invokeLog.push(command);
  const handler = fixtures[command];
  if (typeof handler === "function") return clone(handler(args));
  if (handler !== undefined) return clone(handler);
  if (command === "pick_files" || command === "pick_folder") return [];
  return null;
}

globalThis.window = {
  __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  location: { reload: () => {} },
  prompt: () => null,
};
globalThis.document = documentStub;
globalThis.Node = Element;

// ------------------------------------------------------------------ data ----

const parsedJson = {
  format: "json",
  fields: [
    { kind: "url", key: "url", path: "sap.url", value: "https://prd.corp.example", line: 3 },
    { kind: "username", key: "username", path: "sap.username", value: "FILEUSER", line: 4 },
    { kind: "password", key: "password", path: "sap.password", value: "FILEPASS", line: 5 },
  ],
  missing: [],
  analyzedAt: "2026-09-15T10:00:00+08:00",
  error: null,
};

const parsedEnv = {
  format: "env",
  fields: [
    { kind: "url", key: "SAP_URL", path: "SAP_URL", value: "https://dev.corp.example", line: 1 },
    { kind: "username", key: "SAP_USER", path: "SAP_USER", value: "ENVUSER", line: 2 },
  ],
  missing: ["password"],
  analyzedAt: "2026-09-15T10:00:00+08:00",
  error: null,
};

function makeLink(id, label, parse) {
  return {
    id,
    path: `C:\\demo\\${label}`,
    label,
    addedAt: "2026-09-15T10:00:00+08:00",
    exists: true,
    size: 512,
    modifiedAt: "2026-09-14T09:00:00+08:00",
    keys: {
      url: ["url"],
      username: ["username"],
      password: ["password"],
      ignoreCase: true,
      exact: false,
    },
    parse,
  };
}

const entry = {
  id: "e1",
  title: "生产机 PRD",
  categoryId: "sap",
  username: "JDOE",
  useKnoxId: true,
  password: "S3cret!Pass",
  url: "",
  notes: "季度轮换，注意不要与最近 5 次重复",
  favorite: true,
  sap: {
    systemId: "PRD",
    client: "100",
    language: "ZH",
    systemName: "PRD 生产机",
    hosts: ["prd.sap.corp.example", "corp.example"],
    landscapeSource: "SAPUILandscape.xml",
  },
  rule: {
    enabled: true,
    description: "集团口令策略 2024",
    minLength: 10,
    maxLength: 40,
    lower: true,
    upper: true,
    digits: true,
    symbols: false,
    symbolsSet: "!@#$%^&*()-_=+[]{};:,.?",
    forbidden: "@",
    startWithLetter: true,
    avoidAmbiguous: false,
  },
  historyCycle: 5,
  passwordHistory: [
    {
      id: "h2",
      password: "OldPass#2",
      recordedAt: "2026-06-01T09:00:00+08:00",
      note: "2026Q2 轮换",
      automatic: true,
    },
    {
      id: "h1",
      password: "OldPass#1",
      recordedAt: "2026-01-05T09:00:00+08:00",
      note: "",
      automatic: true,
    },
  ],
  links: [makeLink("l1", "sap.json", parsedJson), makeLink("l2", ".env", parsedEnv)],
  createdAt: "2026-01-01T00:00:00+08:00",
  updatedAt: "2026-09-15T10:00:00+08:00",
  lastUsedAt: "2026-09-15T09:30:00+08:00",
};

const summary = {
  id: "e1",
  title: "生产机 PRD",
  categoryId: "sap",
  username: "KNOX01",
  useKnoxId: true,
  hasPassword: true,
  url: "",
  favorite: true,
  systemId: "PRD",
  client: "100",
  language: "ZH",
  hosts: ["prd.sap.corp.example"],
  linkCount: 2,
  hasRule: true,
  ruleSummary: "10-40 位 / 小写+大写+数字",
  historyCycle: 5,
  historyCount: 2,
  updatedAt: "2026-09-15T10:00:00+08:00",
  lastUsedAt: null,
};

const syncTarget = {
  id: "s1",
  name: "MCP / JSON",
  kind: "mcp",
  path: "C:\\demo\\mcp.json",
  format: "mcpJson",
  enabled: true,
  template: '{\n  "accounts": {{accountsJson}}\n}\n',
  includeFiles: true,
  backup: true,
  lastSyncAt: "2026-09-15T09:00:00+08:00",
  lastStatus: "已写入 1024 字节",
};

const vaultView = {
  knoxId: "KNOX01",
  categories: [
    { id: "sap", name: "SAP 账号", builtin: true, sort: 0 },
    { id: "general", name: "通用账号", builtin: true, sort: 1 },
  ],
  entries: [summary],
  syncTargets: [syncTarget],
  associations: [
    {
      entryId: "e1",
      entryTitle: "生产机 PRD",
      systemId: "PRD",
      username: "KNOX01",
      hosts: ["prd.sap.corp.example"],
      links: entry.links,
    },
  ],
  updatedAt: "2026-09-15T10:00:00+08:00",
};

const landscape = {
  files: ["C:\\Users\\me\\AppData\\Roaming\\SAP\\Common\\SAPUILandscape.xml"],
  systems: [
    {
      serviceId: "svc1",
      name: "PRD 生产机",
      serviceType: "SAPGUI",
      systemId: "PRD",
      client: "100",
      language: "ZH",
      description: "",
      server: "prd.sap.corp.example:3200",
      hosts: ["prd.sap.corp.example"],
      domains: ["prd.sap.corp.example", "sap.corp.example", "corp.example"],
      router: "",
      messageServer: "",
      url: "",
      workspace: "生产 / 财务",
      sourceFile: "SAPUILandscape.xml",
    },
  ],
  warnings: [],
  duplicates: [{ systemId: "PRD", count: 2, hosts: ["prd.sap.corp.example"] }],
  parsedAt: "2026-09-15T10:00:00+08:00",
};

const settings = {
  theme: "system",
  clipboardClearSeconds: 30,
  autoLockMinutes: 10,
  lockOnSessionLock: true,
  sapLineSeparator: "\r\n",
  maskPasswords: true,
  confirmDelete: true,
  landscapePaths: [],
  keyMapping: {
    url: ["url", "server"],
    username: ["username", "user"],
    password: ["password", "pwd"],
    ignoreCase: true,
    exact: false,
  },
  defaultRule: {
    enabled: true,
    description: "集团口令策略",
    minLength: 8,
    maxLength: 40,
    lower: true,
    upper: true,
    digits: true,
    symbols: false,
    symbolsSet: "!@#$%^&*()",
    forbidden: "",
    startWithLetter: false,
    avoidAmbiguous: false,
  },
  lastCategory: "sap",
};

fixtures = {
  app_bootstrap: {
    hasVault: true,
    mode: "password",
    hint: "公司域密码",
    unlocked: false,
    dataDir: "C:\\Users\\me\\AppData\\Roaming\\SapVault",
    vaultPath: "C:\\Users\\me\\AppData\\Roaming\\SapVault\\vault.sapvault",
    portable: false,
    landscapeDefaults: ["SAPUILandscape.xml"],
    landscapePaths: ["SAPUILandscape.xml"],
    presets: [
      { format: "mcpJson", label: "MCP / JSON", description: "JSON", template: "{}" },
      { format: "plain", label: "纯文本", description: "文本", template: "x" },
    ],
    supportedFormats: ["JSON", ".env", "TOML", "YAML", "XML", "纯文本"],
    version: "0.1.0",
    startupError: null,
    settings,
  },
  vault_view: vaultView,
  entry_get: entry,
  sap_systems: landscape,
  sync_presets: [
    { format: "mcpJson", label: "MCP / JSON", description: "JSON", template: "{}" },
  ],
  sync_preview: {
    targetId: "s1",
    path: "C:\\demo\\mcp.json",
    bytes: 1024,
    accountCount: 1,
    fileCount: 2,
    backupPath: null,
    changed: true,
    content: '{\n  "accounts": []\n}\n',
  },
  link_inspect: [
    {
      path: "C:\\demo\\sap.json",
      label: "sap.json",
      format: "json",
      supported: true,
      exists: true,
      size: 512,
      keys: {
        url: ["url"],
        username: ["username"],
        password: ["password"],
        ignoreCase: true,
        exact: false,
      },
      parse: parsedJson,
    },
  ],
  key_mapping_default: {
    url: ["url"],
    username: ["username"],
    password: ["password"],
    ignoreCase: true,
    exact: false,
  },
  rule_default: { enabled: true, minLength: 8, maxLength: 40 },
  check_password_strength: { score: 4, label: "强", entropyBits: 96.2, suggestions: [] },
  validate_password: ["长度不足：至少 10 位（当前 3 位）"],
  generate_rule_password: "Abcd1234Xy",
  generate_password: "Abcd1234Xy",
};

// ------------------------------------------------------------------ check ---

const passes = [];
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail.replace(/\s+/g, " ").slice(0, 220)}` : ""}`);
}

const load = (relative) => import(pathToFileURL(path.join(uiRoot, relative)).href);
const tick = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Importing app.js runs start(): bootstrap, then the first render.
  await load("app.js");
  await tick();

  const lockText = roots.get("app").textContent;
  check("启动后显示解锁界面", lockText.includes("解锁 SapVault"), lockText);
  check("解锁界面包含主密码输入", lockText.includes("主密码"));
  check("启动调用了 app_bootstrap", invokeLog.includes("app_bootstrap"), invokeLog.join(","));

  const store = await load("state.js");
  store.setState({ locked: false, vault: vaultView });

  const renderView = async (label, patch, needles) => {
    store.setState(patch);
    await tick(20);
    const text = roots.get("app").textContent;
    check(`${label}：渲染成功`, text.length > 200, text);
    for (const needle of needles) {
      check(`${label}：包含「${needle}」`, text.includes(needle), text);
    }
  };

  await renderView(
    "账号视图",
    { view: "accounts", categoryId: "sap", selectedEntryId: "e1", selectedEntry: entry },
    [
      "生产机 PRD",
      "复制用户名 + 密码",
      "密码规则",
      "集团口令策略 2024",
      "密码循环",
      "禁止重复最近 5 个",
      "查看 2 个历史密码",
      "关联内容（2）",
      "sap.json",
      ".env",
      "https://prd.corp.example",
      "FILEUSER",
      "缺少 1 个字段",
      "键 url",
    ],
  );

  store.setState({ landscape });
  await renderView("SAP 系统视图", { view: "sap" }, [
    "PRD",
    "prd.sap.corp.example",
    "生产 / 财务",
    "建账号",
    "系统 ID 重复出现",
  ]);

  await renderView("关联关系（卡片）", { view: "associations", assocMode: "cards" }, [
    "生产机 PRD",
    "C:\\demo\\sap.json",
    "字段不完整",
    "SAP_URL",
  ]);

  await renderView("关联关系（表格）", { view: "associations", assocMode: "table" }, [
    "URL（来自关联文件）",
    "KNOX01",
  ]);

  await renderView(
    "同步视图",
    { view: "sync", syncSelectedId: "s1", syncDraft: { ...syncTarget } },
    ["同步目标", "MCP / JSON", "模板", "写入文件", "C:\\demo\\mcp.json"],
  );

  await renderView("设置视图", { view: "settings" }, [
    "默认密码规则",
    "文件关键词",
    "系统锁屏",
    "数据与备份",
    "URL 关键词",
    "SAP 与 Knox ID",
    "启用默认规则",
  ]);

  // Dialogs render into the modal root.
  const editor = await load("views/editor.js");
  editor.openEntryEditor({ entry });
  await tick();
  const modalText = roots.get("modal-root").textContent;
  check("编辑弹窗：渲染成功", modalText.includes("编辑条目"), modalText);
  check("编辑弹窗：包含规则设置", modalText.includes("按规则生成密码"), modalText);
  check("编辑弹窗：包含循环周期", modalText.includes("循环周期"), modalText);
  check("编辑弹窗：包含历史密码", modalText.includes("已记录 2 个历史密码"), modalText);
  check("编辑弹窗：显示规则摘要", modalText.includes("当前规则：10-40"), modalText);

  const linkkeys = await load("views/linkkeys.js");
  linkkeys.openLinkDialog({ entryId: "e1", paths: ["C:\\demo\\sap.json"] });
  await tick(120);
  const dialogText = roots.get("modal-root").textContent;
  check("关联弹窗：渲染成功", dialogText.includes("关联内容文件"), dialogText);
  check("关联弹窗：显示识别到的字段", dialogText.includes("FILEUSER"), dialogText);
  check("关联弹窗：提供关键词输入", dialogText.includes("重新检测"), dialogText);

  console.log("");
  for (const line of passes) console.log(`  PASS  ${line}`);
  for (const line of failures) console.log(`  FAIL  ${line}`);
  console.log("");
  console.log(`${passes.length} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("harness crashed:", error);
  process.exitCode = 1;
});
