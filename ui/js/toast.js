import { h } from "./dom.js";
import { icon } from "./icons.js";

const ICONS = { success: "checkCircle", error: "closeCircle", info: "info" };

/** Shows a transient message. Errors stay a little longer than confirmations. */
export function toast(message, kind = "info", timeout) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const life = timeout ?? (kind === "error" ? 6000 : 3400);
  const node = h(
    "div",
    { class: `toast toast--${kind}` },
    h("span", { class: "toast__icon" }, icon(ICONS[kind] ?? "info", { size: 15 })),
    h("span", { class: "toast__text" }, String(message)),
  );
  host.append(node);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 180);
  };
  const timer = setTimeout(remove, life);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}
