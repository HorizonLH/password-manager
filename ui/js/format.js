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

export function shortSid(sid) {
  const value = (sid || "").trim();
  if (!value) return "····";
  return value.slice(0, 4).toUpperCase();
}

const FORMAT_LABELS = {
  json: "JSON",
  env: ".env",
  toml: "TOML",
  yaml: "YAML",
  xml: "XML",
  text: "文本",
};

export function formatLabel(format) {
  return FORMAT_LABELS[format] ?? format ?? "文本";
}

export const FIELD_LABELS = {
  url: "URL",
  username: "用户名",
  password: "密码",
};

export const FIELD_ORDER = ["url", "username", "password"];
