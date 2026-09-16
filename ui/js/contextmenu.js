/** The one context menu of the app.
 *
 *  `installContextMenu` switches the webview's own browser menu off, so
 *  right-clicking a row shows the actions this app has for that row, and
 *  right-clicking anywhere else shows nothing at all. */

import { h, mount } from "./dom.js";
import { icon } from "./icons.js";

let host = null;
let teardown = [];

function root() {
  if (!host) {
    host = h("div", { id: "menu-root" });
    document.body.append(host);
  }
  return host;
}

export function closeContextMenu() {
  if (!host || host.hidden) return;
  mount(host);
  host.hidden = true;
  for (const off of teardown) off();
  teardown = [];
}

function entry(item) {
  if (item.separator) return h("div", { class: "menu__separator", role: "separator" });
  return h(
    "button",
    {
      class: `menu__item${item.danger ? " menu__item--danger" : ""}`,
      type: "button",
      role: "menuitem",
      disabled: item.disabled || null,
      onClick: () => {
        closeContextMenu();
        item.onSelect?.();
      },
    },
    h("span", { class: "menu__icon" }, item.icon ? icon(item.icon, { size: 14 }) : null),
    h("span", { class: "menu__label" }, item.label),
    item.hint ? h("span", { class: "menu__hint" }, item.hint) : null,
  );
}

/** Opens the menu at the pointer. Items are `{ label, icon, hint, danger,
 *  disabled, onSelect }` or `{ separator: true }`. */
export function openContextMenu(event, items) {
  const entries = items.filter(Boolean);
  if (!entries.length) return;
  closeContextMenu();

  const node = root();
  const panel = h("div", { class: "menu", role: "menu" }, entries.map(entry));
  mount(node, panel);
  node.hidden = false;

  // Opening near an edge must not cut the menu off, so it is measured first
  // and then pulled back inside the window.
  const gap = 8;
  const box = panel.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - box.width - gap);
  const top = Math.min(event.clientY, window.innerHeight - box.height - gap);
  panel.style.left = `${Math.max(gap, left)}px`;
  panel.style.top = `${Math.max(gap, top)}px`;

  const items$ = [...panel.querySelectorAll(".menu__item:not([disabled])")];
  items$[0]?.focus();

  const onPointerDown = (pointerEvent) => {
    if (!panel.contains(pointerEvent.target)) closeContextMenu();
  };
  const onKeyDown = (keyEvent) => {
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      closeContextMenu();
      return;
    }
    if (keyEvent.key !== "ArrowDown" && keyEvent.key !== "ArrowUp") return;
    keyEvent.preventDefault();
    const current = items$.indexOf(document.activeElement);
    const step = keyEvent.key === "ArrowDown" ? 1 : -1;
    items$[(current + step + items$.length) % items$.length]?.focus();
  };
  const dismiss = () => closeContextMenu();

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("scroll", dismiss, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  teardown = [
    () => document.removeEventListener("pointerdown", onPointerDown, true),
    () => document.removeEventListener("keydown", onKeyDown, true),
    () => document.removeEventListener("scroll", dismiss, true),
    () => window.removeEventListener("resize", dismiss),
    () => window.removeEventListener("blur", dismiss),
  ];
}

/** Replaces the webview's browser menu with "nothing" for the whole app.
 *  Handlers that do open a menu call `stopPropagation`, so this one never
 *  closes what they just opened. */
export function installContextMenu() {
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    closeContextMenu();
  });
}
