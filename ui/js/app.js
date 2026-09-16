import { h, mount, guard, debounce } from "./dom.js";
import { icon, iconPair } from "./icons.js";
import { api, listen } from "./api.js";
import {
  state,
  subscribe,
  setState,
  bootstrap,
  navigate,
  lock,
  handleLocked,
  refreshVault,
  saveSettings,
  loadFilePlans,
  syncAllFiles,
} from "./state.js";
import { toast } from "./toast.js";
import { currentTheme, setTheme } from "./theme.js";
import { renderLock } from "./views/lock.js";
import { renderAccounts } from "./views/accounts.js";


import { renderSync } from "./views/sync.js";
import { renderSettings } from "./views/settings.js";
import { renderAssociations } from "./views/associations.js";
import { openEntryEditor } from "./views/editor.js";
import { openFileDialog } from "./views/filedialog.js";
import { installContextMenu } from "./contextmenu.js";
import { installFileDrop } from "./dragdrop.js";

const root = document.getElementById("app");

const VIEW_META = {
  accounts: { title: "账号", subtitle: "本地加密保存的账号与密码" },
  associations: { title: "关联关系", subtitle: "账号与需要同步的内容文件" },

  sync: { title: "同步文件", subtitle: "把账号密码写回已上传的配置文件" },
  settings: { title: "设置", subtitle: "外观、安全、SAP 与数据" },
};

const TOOL_VIEWS = ["associations", "sync", "settings"];
const TOOL_ICONS = {
  associations: "link",
  sync: "refresh",
  settings: "sliders",
};

// --------------------------------------------------------------- rendering --

function captureFocus() {
  const active = document.activeElement;
  if (!active || !active.id) return null;
  return {
    id: active.id,
    start: active.selectionStart ?? null,
    end: active.selectionEnd ?? null,
  };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const target = document.getElementById(snapshot.id);
  if (!target) return;
  target.focus();
  if (snapshot.start !== null && typeof target.setSelectionRange === "function") {
    try {
      target.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // Range selection is only valid for text inputs.
    }
  }
}

function render() {
  const snapshot = captureFocus();
  root.setAttribute("aria-busy", "false");

  if (!state.ready) {
    mount(
      root,
      h(
        "div",
        { class: "boot" },
        h("div", { class: "boot__spinner", "aria-hidden": "true" }),
        h("p", { class: "boot__text" }, "正在启动 SapVault…"),
      ),
    );
    return;
  }

  if (!state.hasVault || state.locked) {
    renderLock(root);
    return;
  }

  mount(root, h("div", { class: "shell" }, sidebar(), main(), dropOverlay()));
  restoreFocus(snapshot);
}

/** Shown while files are dragged over the window in the sync view. */
function dropOverlay() {
  if (!state.dragActive || state.view !== "sync") return null;
  return h(
    "div",
    { class: "dropzone" },
    h(
      "div",
      { class: "dropzone__card" },
      h("div", { class: "dropzone__icon" }, icon("upload", { size: 26 })),
      h("h3", { class: "dropzone__title" }, "松开鼠标即上传同步文件"),
      h(
        "p",
        { class: "dropzone__text" },
        "支持 JSON、.env、TOML / INI / YAML / XML。松开后会先列出解析到的键，" +
          "再由你点选密码对应的键并绑定账号——拖进来的文件不会被改写。",
      ),
    ),
  );
}

function knoxCard() {
  const knox = state.vault?.knoxId ?? "";
  return h(
    "div",
    { class: "knox-card" },
    h(
      "div",
      { class: "knox-card__head" },
      icon("fingerprint", { size: 12 }),
      h("span", null, "全局 Knox ID"),
    ),
    h(
      "div",
      { class: `knox-card__value${knox ? "" : " is-empty"}` },
      h("span", null, knox || "未设置"),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "编辑 Knox ID",
          onClick: () => editKnox(),
        },
        icon("pencil", { size: 13 }),
      ),
    ),
  );
}

function editKnox() {
  const input = h("input", {
    id: "knox-input",
    class: "input input--mono",
    value: state.vault?.knoxId ?? "",
    placeholder: "例如 K1234567",
  });
  import("./modal.js").then(({ openModal }) => {
    openModal({
      title: "全局 Knox ID",
      size: "narrow",
      render: () =>
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "Knox ID"),
          input,
          h(
            "p",
            { class: "form__hint" },
            "在条目里勾选“使用全局 Knox ID”后，该条目就会用这个值作为用户名；复制与同步同样生效。",
          ),
        ),
      footer: (close) =>
        h(
          "div",
          { style: { display: "flex", gap: "8px", width: "100%", justifyContent: "flex-end" } },
          h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
          h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              onClick: guard(async () => {
                const vault = await api.knoxSet(input.value);
                setState({ vault });
                close();
                toast("Knox ID 已更新", "success");
              }),
            },
            "保存",
          ),
        ),
    });
    setTimeout(() => input.select(), 0);
  });
}

function categoryNav() {
  const categories = state.vault?.categories ?? [];
  const counts = new Map();
  for (const entry of state.vault?.entries ?? []) {
    counts.set(entry.categoryId, (counts.get(entry.categoryId) ?? 0) + 1);
  }

  const item = (id, name, builtin, count) =>
    h(
      "div",
      { class: "nav__row" },
      h(
        "button",
        {
          class: `nav__item${state.view === "accounts" && state.categoryId === id ? " is-active" : ""}`,
          type: "button",
          onClick: () => {
            navigate("accounts", { categoryId: id });
            saveSettings({ lastCategory: id }).catch(() => {});
          },
        },
        iconPair(id === "sap" ? "server" : "key", 15),
        h("span", { class: "nav__label" }, name),
        h("span", { class: "nav__count" }, String(count ?? 0)),
      ),
      builtin
        ? null
        : h(
            "button",
            {
              class: "btn btn--icon btn--sm",
              type: "button",
              title: "重命名或删除",
              onClick: () => editCategory(id, name),
            },
            icon("pencil", { size: 12 }),
          ),
    );

  return h(
    "nav",
    { class: "nav" },
    h(
      "div",
      { class: "nav__title" },
      h("span", null, "分类"),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "新建分类",
          onClick: () => createCategory(),
        },
        icon("plus", { size: 13 }),
      ),
    ),
    h(
      "button",
      {
        class: `nav__item${state.view === "accounts" && state.categoryId === "all" ? " is-active" : ""}`,
        type: "button",
        onClick: () => navigate("accounts", { categoryId: "all" }),
      },
      iconPair("link", 15),
      h("span", { class: "nav__label" }, "全部账号"),
      h("span", { class: "nav__count" }, String(state.vault?.entries?.length ?? 0)),
    ),
    categories.map((category) =>
      item(category.id, category.name, category.builtin, counts.get(category.id)),
    ),
  );
}

function createCategory() {
  const input = h("input", { id: "category-input", class: "input", placeholder: "分类名称" });
  import("./modal.js").then(({ openModal }) => {
    openModal({
      title: "新建分类",
      size: "narrow",
      render: () => h("div", { class: "form__row" }, input),
      footer: (close) =>
        h(
          "div",
          { style: { display: "flex", gap: "8px", width: "100%", justifyContent: "flex-end" } },
          h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
          h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              onClick: guard(async () => {
                const vault = await api.categoryCreate(input.value);
                setState({ vault });
                close();
                toast("分类已创建", "success");
              }),
            },
            "创建",
          ),
        ),
    });
    setTimeout(() => input.focus(), 0);
  });
}

function editCategory(id, name) {
  const input = h("input", { id: "category-rename", class: "input", value: name });
  import("./modal.js").then(({ openModal, confirmModal }) => {
    openModal({
      title: "管理分类",
      size: "narrow",
      render: () =>
        h(
          "div",
          { class: "stack" },
          h("label", { class: "form__label" }, "分类名称"),
          input,
        ),
      footer: (close) =>
        h(
          "div",
          { style: { display: "flex", gap: "8px", width: "100%", alignItems: "center" } },
          h(
            "button",
            {
              class: "btn btn--danger",
              type: "button",
              onClick: () => {
                close();
                confirmModal({
                  title: "删除分类",
                  message: `确定删除「${name}」吗？`,
                  detail: "该分类下的条目会移动到“通用账号”。",
                  confirmLabel: "删除",
                  danger: true,
                  onConfirm: guard(async () => {
                    const vault = await api.categoryDelete(id);
                    setState({ vault, categoryId: "sap" });
                  }),
                });
              },
            },
            "删除",
          ),
          h("div", { class: "modal__footer-spacer" }),
          h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
          h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              onClick: guard(async () => {
                const vault = await api.categoryRename(id, input.value);
                setState({ vault });
                close();
              }),
            },
            "保存",
          ),
        ),
    });
  });
}

function sidebar() {
  const theme = currentTheme();
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const themeIcon = theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor";

  return h(
    "aside",
    { class: "sidebar" },
    h(
      "div",
      { class: "sidebar__brand" },
      h("div", { class: "brand__mark" }, icon("key", { size: 17 })),
      h(
        "div",
        { class: "brand__text" },
        h("span", { class: "brand__name" }, "SapVault"),
        h("span", { class: "brand__sub" }, "完全本地 · 无联网"),
      ),
      h("div", { class: "brand__spacer" }),
      h(
        "button",
        {
          class: "btn btn--icon",
          type: "button",
          title: `主题：${theme === "system" ? "跟随系统" : theme === "dark" ? "暗色" : "亮色"}`,
          onClick: guard(async () => {
            setTheme(nextTheme);
            await saveSettings({ theme: nextTheme });
          }),
        },
        icon(themeIcon, { size: 15 }),
      ),
    ),
    h(
      "div",
      { class: "sidebar__scroll" },
      knoxCard(),
      categoryNav(),
      h(
        "nav",
        { class: "nav" },
        h("div", { class: "nav__title" }, "工具"),
        TOOL_VIEWS.map((view) =>
          h(
            "button",
            {
              class: `nav__item${state.view === view ? " is-active" : ""}`,
              type: "button",
              onClick: () => navigate(view),
            },
            iconPair(TOOL_ICONS[view], 15),
            h("span", { class: "nav__label" }, VIEW_META[view].title),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "sidebar__footer" },
      h(
        "button",
        { class: "btn btn--block", type: "button", onClick: guard(() => lock()) },
        icon("lock", { size: 14 }),
        "锁定保险库",
      ),
    ),
  );
}

function headerActions() {
  if (state.view === "accounts") {
    return h(
      "div",
      { class: "main__actions" },
      h(
        "div",
        { class: "search search--header" },
        h("span", { class: "search__icon" }, icon("search", { size: 14 })),
        h("input", {
          id: "global-search",
          class: "search__input",
          placeholder: "搜索标题、用户名、备注",
          title: "按标题、用户名或备注筛选",
          value: state.search,
          onInput: (event) => setState({ search: event.target.value }),
        }),
      ),
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onClick: () =>
            openEntryEditor({
              defaultCategory: state.categoryId === "all" ? "sap" : state.categoryId,
            }),
        },
        icon("plus", { size: 15 }),
        "新建条目",
      ),
    );
  }
  if (state.view === "sync") {
    return h(
      "div",
      { class: "main__actions" },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(() => loadFilePlans()),
        },
        icon("refresh", { size: 14 }),
        "重新检测",
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(() => syncAllFiles()),
        },
        icon("download", { size: 14 }),
        "全部同步",
      ),
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          title: "选择文件上传；也可以把文件直接拖到窗口里",
          onClick: guard(async () => {
            const files = await api.pickFiles();
            if (!files.length) return;
            openFileDialog({ paths: files });
          }),
        },
        icon("plus", { size: 15 }),
        "上传文件",
      ),
    );
  }
  if (state.view === "settings") {
    return h(
      "div",
      { class: "main__actions" },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(async () => {
            await refreshVault();
            toast("已重新载入", "success");
          }),
        },
        icon("refresh", { size: 14 }),
        "重新载入",
      ),
    );
  }
  return h(
    "div",
    { class: "main__actions" },
    h(
      "button",
      { class: "btn btn--ghost", type: "button", onClick: guard(() => lock()) },
      icon("lock", { size: 14 }),
      "锁定",
    ),
  );
}

function subtitle() {
  const vault = state.vault;
  if (!vault) return VIEW_META[state.view].subtitle;
  if (state.view === "accounts") {
    const files = vault.files?.length ?? 0;
    const bound = vault.entries.reduce((sum, entry) => sum + entry.fileCount, 0);
    return `${vault.entries.length} 个账号 · ${files} 个同步文件 · ${bound} 处绑定`;
  }
  if (state.view === "sync") {
    return `${vault.files?.length ?? 0} 个已上传文件 · 只把密码写回原文件`;
  }
  return VIEW_META[state.view].subtitle;
}

function viewContent() {
  if (state.view === "accounts") {
    const listHost = h("div", { class: "pane__scroll" });
    const detailHost = h("div", { class: "pane__scroll" });
    const node = h("div", { class: "content content--split" }, listHost, detailHost);
    renderAccounts(listHost, detailHost);
    return node;
  }
  const host = h("div", { class: "content" });
  if (state.view === "sync") renderSync(host);
  else if (state.view === "associations") renderAssociations(host);
  else if (state.view === "settings") {
    const scroll = h("div", { class: "content content--scroll" });
    renderSettings(scroll);
    return scroll;
  }
  return host;
}

function main() {
  return h(
    "main",
    { class: "main" },
    h(
      "header",
      { class: "main__header" },
      h(
        "div",
        { class: "main__heading" },
        h(
          "h1",
          { class: "main__title" },
          VIEW_META[state.view].title,
          state.refreshing ? h("span", { class: "tag" }, "同步中…") : null,
        ),
        h("span", { class: "main__subtitle" }, subtitle()),
      ),
      headerActions(),
    ),
    viewContent(),
  );
}

// ------------------------------------------------------------------ events --

function bindShortcuts() {
  document.addEventListener("keydown", (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (!meta) return;
    if (event.key === "l") {
      event.preventDefault();
      guard(() => lock())();
    } else if (event.key === "k") {
      event.preventDefault();
      const input = document.getElementById(
        state.view === "accounts" ? "global-search" : "sap-filter",
      );
      input?.focus();
    } else if (event.key === "n" && state.view === "accounts") {
      event.preventDefault();
      openEntryEditor({
        defaultCategory: state.categoryId === "all" ? "sap" : state.categoryId,
      });
    }
  });
}

async function wireEvents() {
  try {
    await listen("vault:locked", () => handleLocked());

    await listen("app:notice", (event) => {
      const { kind, message } = event.payload ?? {};
      toast(message ?? "", kind === "error" ? "error" : kind === "success" ? "success" : "info");
    });
  } catch {
    // Events are a nicety; the app still works without them.
  }
}

subscribe(() => render());

async function start() {
  try {
    await bootstrap();
  } catch (error) {
    const message = typeof error === "string" ? error : error?.message ?? String(error);
    mount(
      root,
      h(
        "div",
        { class: "lock" },
        h(
          "div",
          { class: "lock__card" },
          h("h1", { class: "lock__title" }, "SapVault 启动失败"),
          h("p", { class: "lock__sub" }, message),
          h(
            "button",
            { class: "btn btn--primary", type: "button", onClick: () => window.location.reload() },
            icon("refresh", { size: 14 }),
            "重试",
          ),
        ),
      ),
    );
    return;
  }
  installContextMenu();
  installFileDrop({
    active: () => state.view === "sync" && !state.locked,
    onDrop: (paths) => openFileDialog({ paths }),
  });
  render();
  await wireEvents();
}

bindShortcuts();
start();
