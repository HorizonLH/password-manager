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

function installGlobalClose() {
  if (globalCloseInstalled) return;
  globalCloseInstalled = true;
  // Capture phase: the panel closes before the click reaches whatever is
  // underneath (which would otherwise select a row).
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (openInstance && !openInstance.root.contains(event.target)) openInstance.close();
    },
    true,
  );
  document.addEventListener("scroll", () => openInstance?.close(), true);
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

  const selected = () => options.find((option) => option.value === value) ?? null;
  const matches = () => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) =>
      `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(term),
    );
  };

  function close() {
    if (openInstance?.root === root) openInstance = null;
    if (!open) return;
    open = false;
    paint();
  }

  function choose(next) {
    value = next;
    open = false;
    query = "";
    if (openInstance?.root === root) openInstance = null;
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
        openInstance = { root, close };
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
          openInstance = open ? { root, close } : null;
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
      h(
        "div",
        { class: "combo__panel", role: "listbox" },
        search,
        query.trim() && !list.length
          ? h("p", { class: "combo__empty" }, "没有匹配的账号")
          : h("div", { class: "combo__options" }, rows),
      ),
    );
    setTimeout(() => search.focus(), 0);
  }

  paint();
  return root;
}
