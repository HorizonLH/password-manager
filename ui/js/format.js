export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

export function formatTime(iso) {
  if (!iso) return "从未";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function fileName(path) {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function mask(value, visible) {
  if (visible) return value || "";
  const length = (value || "").length;
  return length ? "•".repeat(Math.min(length, 18)) : "";
}

/** Which icon marks an account wherever it is listed. A category says more than
 *  the first letters of the title, and it never has to be invented by the user. */
export function categoryIconName(categoryId) {
  if (categoryId === "sap") return "server";
  if (categoryId === "general") return "key";
  return "folder";
}

/** Human readable description of a password rule. */
export function ruleSummary(rule, { includeDescription = true } = {}) {
  if (!rule || !rule.enabled) return "未设置规则";
  const classes = [];
  if (rule.lower) classes.push("小写");
  if (rule.upper) classes.push("大写");
  if (rule.digits) classes.push("数字");
  if (rule.symbols) classes.push("符号");
  const parts = [];
  if (includeDescription && rule.description) parts.push(rule.description);
  parts.push(`${rule.minLength}-${rule.maxLength} 位`);
  parts.push(classes.join("+") || "无字符集");
  if (rule.forbidden) parts.push(`禁用 ${rule.forbidden}`);
  if (rule.startWithLetter) parts.push("首字符为字母");
  if (rule.avoidAmbiguous) parts.push("排除易混字符");
  return parts.join(" · ");
}


const FORMAT_LABELS = {
  json: "JSON",
  env: ".env",
  toml: "TOML",
  ini: "INI",
  properties: "properties",
  hcl: "HCL / tfvars",
  yaml: "YAML",
  xml: "XML",
  unsupported: "不支持的格式",
};

export function formatLabel(format) {
  return FORMAT_LABELS[format] ?? format ?? "文本";
}

// ------------------------------------------------------------------- SAP ----

/** How a SAP Logon system reads in a picker: `PRD · 生产机`. */
export function systemLabel(system) {
  const id = (system?.systemId ?? "").trim() || "(无系统 ID)";
  const name = (system?.name ?? "").trim();
  return name && name !== id ? `${id} · ${name}` : id;
}

/** Where that system actually lives: host, logon group or URL. */
export function systemTarget(system) {
  if (!system) return "";
  if (system.kind === "serverGroup") {
    const host = system.messageServer || system.host || "?";
    const port = system.messageServerPort ? `:${system.messageServerPort}` : "";
    return `${host}${port} · 组 ${system.group || "SPACE"}`;
  }
  if (system.kind === "applicationServer") {
    return `${system.host || "?"}${system.port ? `:${system.port}` : ""}`;
  }
  return system.url || "—";
}

/** Short description of a stored launch configuration. */
export function launchSummary(sap) {
  if (!sap?.systemId && !sap?.guiparm) return "未配置";
  const parts = [sap.systemId?.trim() || "（无系统 ID）"];
  if (sap.client?.trim()) parts.push(`客户端 ${sap.client.trim()}`);
  if (sap.language?.trim()) parts.push(sap.language.trim());
  if (sap.transaction?.trim()) parts.push(`启动 ${sap.transaction.trim()}`);
  return parts.join(" · ");
}

export const PASSWORD_MODE_LABELS = {
  clipboard: "剪贴板（推荐）",
  commandLine: "命令行明文",
};

/** 备注里的链接。只认 http / https / mailto，其它一律当普通文本。 */
const LINK_PATTERN = /\b(?:https?:\/\/|mailto:)[^\s<>"'）)】]+/gi;
/** 结尾常见的中英文标点不属于链接本身。 */
const LINK_TRAILING = /[.,;:!?、。；：！？）)】\]]+$/;

/** Splits text into `{ text }` / `{ url }` parts so links can be rendered as
 *  real anchors while everything else stays plain text. */
export function splitLinks(value) {
  const text = String(value ?? "");
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const url = raw.replace(LINK_TRAILING, "");
    if (url.length <= 8) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ url });
    const trailing = raw.slice(url.length);
    if (trailing) parts.push({ text: trailing });
    cursor = start + raw.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** Key names that get flagged as 「疑似密码」 when a file is parsed. */
export const PASSWORD_KEY_HINT = "password / passwd / pwd / secret / passwort / kennwort / token";
