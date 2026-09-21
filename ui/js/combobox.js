/** Searchable single-select control.
 *
 *  A native `<select>` stops being usable once the list holds hundreds of SAP
 *  accounts (you scroll a tiny popup and type blind), so the binding pickers use
 *  this instead: a compact control that opens a filterable list.
 *
 *  The control is a `<button>` and the rows are `<button>`s — never an `<a>` or
 *  a form — so nothing the user types can navigate the webview. */

import { h, mount } from "./dom.js";
import { icon } from "./icons.js";

/** The one currently open instance, so opening a second one closes the first. */
let openInstance = null;
let globalCloseInstalled = false;

/** The floating panel lives in its own host at the end of <body>: a select inside
 *  a table cell would otherwise be clipped by `overflow: hidden` on the cell and
 *  on the table itself, which looks exactly like a disabled control. */
function panelHost() {
  let host = document.getElementById("combo-root");
  if (!host) {
    host = h("div", { id: "combo-root" });
    document.body.append(host);
  }
  return host;
}

function installGlobalClose() {
  if (globalCloseInstalled) return;
  globalCloseInstalled = true;
  // Capture phase: the panel closes before the click reaches whatever is
  // underneath (which would otherwise select a row).
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!openInstance) return;
      // The control can be replaced by a re-render while the panel is open; in
      // that case the panel is stale and must go.
      if (!openInstance.root.isConnected) {
        openInstance.close();
        return;
      }
      const inside =
        openInstance.root.contains(event.target) ||
        (openInstance.panel && openInstance.panel.contains(event.target));
      if (!inside) openInstance.close();
    },
    true,
  );
  document.addEventListener("scroll", () => openInstance?.close(), true);
  window.addEventListener("resize", () => openInstance?.close());
  window.addEventListener("blur", () => openInstance?.close());
}

/**
 * @param {object}   config
 * @param {Array}    config.options        `{ value, label, hint }`
 * @param {string}   config.value          currently selected value ("" = none)
 * @param {string}   config.emptyLabel     label of the "no selection" entry
 * @param {string}   config.searchPlaceholder
 * @param {boolean}  config.small          compact variant for tree/table rows
 * @param {Function} config.onSelect       called with the new value
 */
export function searchSelect({
  options = [],
  value = "",
  emptyLabel = "未绑定",
  searchPlaceholder = "搜索账号…",
  small = false,
  onSelect,
} = {}) {
  installGlobalClose();
  const root = h("div", { class: `combo${small ? " combo--sm" : ""}` });
  let open = false;
  let query = "";
  let cursor = 0;
  /** The floating panel of *this* instance (see `paint`). */
  let panel = null;

  const selected = () => options.find((option) => option.value === value) ?? null;
  const matches = () => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) =>
      `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(term),
    );
  };

  function close() {
    panel?.remove();
    panel = null;
    if (openInstance?.root === root) {
      openInstance = null;
    }
    if (!open) return;
    open = false;
    paint();
  }

  function choose(next) {
    value = next;
    open = false;
    query = "";
    panel?.remove();
    panel = null;
    if (openInstance?.root === root) {
      openInstance = null;
    }
    paint();
    onSelect?.(next);
  }

  function onKeyDown(event, list) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        open = true;
        openInstance = { root, close, panel: null };
        paint();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      cursor = Math.max(0, Math.min(list.length - 1, cursor + step));
      paint();
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(list[cursor]?.value ?? "");
    }
  }

  function paint() {
    // `paint()` runs on every keystroke and arrow key press; without dropping the
    // previous panel first they would pile up in the host and clicks would land
    // on a stale one.
    panel?.remove();
    panel = null;

    const current = selected();
    const control = h(
      "button",
      {
        class: `combo__control${open ? " is-open" : ""}`,
        type: "button",
        "aria-haspopup": "listbox",
        "aria-expanded": open ? "true" : "false",
        title: current ? current.label : emptyLabel,
        onClick: () => {
          open = !open;
          query = "";
          cursor = 0;
          if (!open) {
            panel?.remove();
            panel = null;
            openInstance = null;
          }
          paint();
        },
        onKeydown: (event) => onKeyDown(event, matches()),
      },
      h(
        "span",
        { class: `combo__value${current ? "" : " is-empty"}` },
        current ? current.label : emptyLabel,
      ),
      icon("chevronDown", { size: 12, class: "combo__caret" }),
    );

    if (!open) {
      mount(root, control);
      return;
    }

    const search = h("input", {
      class: "input combo__search",
      placeholder: searchPlaceholder,
      value: query,
      onInput: (event) => {
        query = event.target.value;
        cursor = 0;
        paint();
      },
      onKeydown: (event) => onKeyDown(event, matches()),
    });

    const list = matches();
    const rows = [
      h(
        "button",
        { class: "combo__option", type: "button", onClick: () => choose("") },
        h("span", { class: "combo__option-label is-empty" }, emptyLabel),
      ),
      ...list.map((option, index) =>
        h(
          "button",
          {
            class: `combo__option${option.value === value ? " is-selected" : ""}${
              index === cursor ? " is-cursor" : ""
            }`,
            type: "button",
            onClick: () => choose(option.value),
          },
          h("span", { class: "combo__option-label" }, option.label),
          option.hint ? h("span", { class: "combo__option-hint" }, option.hint) : null,
        ),
      ),
    ];

    mount(
      root,
      control,
    );
    // The panel is appended to its own host (see panelHost) and positioned with
    // `position: fixed`, so no ancestor can clip it.
    panel = h(
      "div",
      { class: "combo__panel", role: "listbox" },
      search,
      query.trim() && !list.length
        ? h("p", { class: "combo__empty" }, "没有匹配的账号")
        : h("div", { class: "combo__options" }, rows),
    );
    openInstance = { root, close, panel };
    panelHost().append(panel);
    const rect = control.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16);
    panel.style.width = `${width}px`;
    const height = panel.offsetHeight;
    const below = rect.bottom + 4;
    const above = rect.top - height - 4;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    panel.style.top = `${below + height <= window.innerHeight - 8 || above < 8 ? below : above}px`;
    setTimeout(() => search.focus(), 0);
  }

  paint();
  return root;
}
