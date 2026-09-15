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

/** Key names that get flagged as 「疑似密码」 when a file is parsed. */
export const PASSWORD_KEY_HINT = "password / passwd / pwd / secret / passwort / kennwort / token";
