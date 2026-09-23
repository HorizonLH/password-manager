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
  // Scrolling *inside* the panel (its option list is scrollable) must not close
  // it; only a scroll of the page behind it means the anchor moved away.
  document.addEventListener(
    "scroll",
    (event) => {
      if (!openInstance) return;
      if (openInstance.panel && openInstance.panel.contains(event.target)) return;
      openInstance.close();
    },
    true,
  );
  window.addEventListener("resize", () => openInstance?.close());
  window.addEventListener("blur", () => openInstance?.close());
}

/**
 * @param {object}   config
 * @param {Array}    config.options        `{ value, label, hint }`
 * @param {string}   config.value          currently selected value ("" = none)
 * @param {string}   config.emptyLabel     label of the "no selection" entry;
 *                                         pass `empty: false` to leave it out
 * @param {boolean}  config.empty          whether the "no selection" entry exists
 * @param {string}   config.searchPlaceholder
 * @param {boolean}  config.search         whether the panel offers a filter box
 * @param {boolean}  config.small          compact variant for tree/table rows
 * @param {Function} config.onSelect       called with the new value
 */
function createSelect({
  id = null,
  options = [],
  value = "",
  emptyLabel = "未绑定",
  empty = true,
  searchPlaceholder = "搜索账号…",
  search = true,
  small = false,
  onSelect,
} = {}) {
  installGlobalClose();
  const root = h("div", { id, class: `combo${small ? " combo--sm" : ""}` });
  let open = false;
  let query = "";
  let cursor = 0;
  /** Type-ahead buffer for the non-searchable variant (a native select jumps to
   *  the first entry matching what you type; keep that muscle memory working). */
  let typed = "";
  let typedAt = 0;
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
  /** Panel rows: the optional "no selection" entry first, then the matches. */
  const entries = () => {
    const list = matches();
    return empty ? [{ value: "", label: emptyLabel, isEmpty: true }, ...list] : list;
  };
  /** Where the keyboard cursor should start: on the current value. */
  const cursorForValue = () => {
    const index = entries().findIndex((entry) => entry.value === value);
    return index < 0 ? 0 : index;
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
        cursor = cursorForValue();
        openInstance = { root, close, panel: null };
        paint();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      cursor = Math.max(0, Math.min(list.length - 1, cursor + step));
      paint();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!open) return;
      event.preventDefault();
      cursor = event.key === "Home" ? 0 : list.length - 1;
      paint();
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(list[cursor]?.value ?? "");
      return;
    }
    // Without a search box, typing is type-ahead (like a native `<select>`).
    if (!search && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const now = Date.now();
      typed = now - typedAt > 700 ? event.key : typed + event.key;
      typedAt = now;
      const term = typed.toLowerCase();
      const index = entries().findIndex((entry) =>
        `${entry.label}`.toLowerCase().startsWith(term),
      );
      if (index >= 0) {
        event.preventDefault();
        cursor = index;
        open = true;
        openInstance = { root, close, panel: null };
        paint();
      }
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
          typed = "";
          cursor = cursorForValue();
          if (!open) {
            panel?.remove();
            panel = null;
            openInstance = null;
          }
          paint();
        },
        onKeydown: (event) => onKeyDown(event, entries()),
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

    const searchInput = search
      ? h("input", {
          class: "input combo__search",
          placeholder: searchPlaceholder,
          value: query,
          onInput: (event) => {
            query = event.target.value;
            cursor = 0;
            paint();
          },
          onKeydown: (event) => onKeyDown(event, entries()),
        })
      : null;

    const list = matches();
    const rows = [
      ...(empty
        ? [
            h(
              "button",
              {
                class: `combo__option${cursor === 0 ? " is-cursor" : ""}`,
                type: "button",
                onClick: () => choose(""),
              },
              h("span", { class: "combo__option-label is-empty" }, emptyLabel),
            ),
          ]
        : []),
      ...list.map((option, index) => {
        const row = empty ? index + 1 : index;
        return h(
          "button",
          {
            class: `combo__option${option.value === value ? " is-selected" : ""}${
              row === cursor ? " is-cursor" : ""
            }`,
            type: "button",
            onClick: () => choose(option.value),
          },
          h("span", { class: "combo__option-label" }, option.label),
          option.hint ? h("span", { class: "combo__option-hint" }, option.hint) : null,
        );
      }),
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
      searchInput,
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
    // The searchable variant puts the caret in the filter box; the plain one
    // keeps focus on the control so ↑/↓/Enter never leave it.
    setTimeout(() => (searchInput ? searchInput.focus() : control.focus()), 0);
  }

  paint();
  return root;
}

/** Searchable single-select — the account pickers (see the module comment). */
export function searchSelect(config = {}) {
  return createSelect({ ...config, search: true });
}

/** Same control and panel, without the filter box: used for short, fixed lists
 *  that used to be native `<select>`s (category, SAP Logon system). */
export function selectMenu(config = {}) {
  return createSelect({ ...config, search: false });
}
