import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  state,
  setState,
  selectEntry,
  navigate,
  copyPassword,
  copyUsername,
  copySap,
  copyText,
  toggleFavorite,
  bindFile,
  filesForEntry,
  removeHistory,
  syncFile,
  launchSap,
  exportSapShortcut,
} from "../state.js";
import { openModal } from "../modal.js";
import { openContextMenu } from "../contextmenu.js";
import { toast } from "../toast.js";
import {
  categoryIconName,
  formatBytes,
  formatLabel,
  formatTime,
  launchSummary,
  mask,
  ruleSummary,
} from "../format.js";
import { openEntryEditor } from "./editor.js";
import { openFileDialog, openFileKeys } from "./filedialog.js";

/** The user name actually used: the Knox ID wins when the entry asks for it. */
function effectiveUsername(entry) {
  if (entry.useKnoxId && state.vault?.knoxId) return state.vault.knoxId;
  return entry.username ?? "";
}

/** What right-clicking an account offers: the same copy actions as the row
 *  buttons, plus the favourite toggle. */
function entryMenuItems(entry) {
  const items = [
    { label: "复制密码", icon: "copy", onSelect: guard(() => copyPassword(entry.id)) },
  ];
  if (entry.sap?.systemId || entry.hasSapLogin) {
    items.push({
      label: "登录 SAP GUI",
      icon: "server",
      hint: entry.sap?.systemId ?? "",
      onSelect: guard(() => launchSap(entry.id)),
    });
  }
  if (entry.categoryId === "sap") {
    items.push({
      label: "复制用户名 + 密码",
      icon: "key",
      hint: "换行分隔",
      onSelect: guard(() => copySap(entry.id)),
    });
  }
  items.push(
    { separator: true },
    {
      label: entry.favorite ? "取消收藏" : "收藏",
      icon: "star",
      onSelect: guard(() => toggleFavorite(entry.id)),
    },
  );
  return items;
}

function openEntryMenu(event, entry) {
  event.preventDefault();
  event.stopPropagation();
  openContextMenu(event, entryMenuItems(entry));
}

/** What a person remembers about an account: title, user name and notes. */
function searchText(entry) {
  return [entry.title, entry.username, entry.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterEntries() {
  const term = state.search.trim().toLowerCase();
  return (state.vault?.entries ?? []).filter((entry) => {
    if (state.categoryId !== "all" && entry.categoryId !== state.categoryId) return false;
    if (!term) return true;
    return searchText(entry).includes(term);
  });
}

function entryRow(entry) {
  const selected = state.selectedEntryId === entry.id;
  const subtitle = entry.username;
  return h(
    "div",
    {
      class: `row${selected ? " is-selected" : ""}`,
      role: "button",
      tabindex: "0",
      onClick: guard(() => selectEntry(entry.id)),
      onKeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          guard(() => selectEntry(entry.id))();
        }
      },
      onContextMenu: (event) => openEntryMenu(event, entry),
    },
    h(
      "span",
      { class: "row__badge", title: entry.categoryId === "sap" ? "SAP 账号" : "账号" },
      icon(categoryIconName(entry.categoryId), { size: 16 }),
    ),
    h(
      "span",
      { class: "row__body" },
      h(
        "span",
        { class: "row__title" },
        entry.title,
        entry.favorite ? icon("star", { size: 12, solid: true }) : null,
        entry.useKnoxId ? h("span", { class: "tag tag--accent" }, "Knox") : null,
      ),
      h(
        "span",
        { class: "row__meta" },
        h("span", { class: "mono" }, subtitle || "未设置用户名"),
        entry.fileCount
          ? h("span", { class: "tag" }, icon("link", { size: 11 }), `${entry.fileCount} 文件`)
          : null,
        entry.historyCycle
          ? h("span", { class: "tag tag--mono" }, `循环 ${entry.historyCycle}`)
          : null,
        entry.hasRule ? h("span", { class: "tag" }, "有规则") : null,
      ),
    ),
    h(
      "span",
      { class: "row__actions" },
      entry.hasSapLogin
        ? h(
            "button",
            {
              class: "btn btn--icon btn--sm",
              type: "button",
              title: "登录 SAP GUI",
              onClick: (event) => {
                event.stopPropagation();
                guard(() => launchSap(entry.id))();
              },
            },
            icon("server", { size: 14 }),
          )
        : null,
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "复制密码",
          onClick: (event) => {
            event.stopPropagation();
            guard(() => copyPassword(entry.id))();
          },
        },
        icon("copy", { size: 14 }),
      ),
      entry.categoryId === "sap"
        ? h(
            "button",
            {
              class: "btn btn--icon btn--sm",
              type: "button",
              title: "复制用户名 + 密码（SAP 换行格式）",
              onClick: (event) => {
                event.stopPropagation();
                guard(() => copySap(entry.id))();
              },
            },
            icon("key", { size: 14 }),
          )
        : null,
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: entry.favorite ? "取消收藏" : "收藏",
          onClick: (event) => {
            event.stopPropagation();
            guard(() => toggleFavorite(entry.id))();
          },
        },
        icon("star", { size: 14, solid: entry.favorite }),
      ),
    ),
  );
}

function bindingRow(entry, file, binding) {
  const value = (file.analysis?.values ?? []).find((item) => item.path === binding.keyPath);
  return h(
    "div",
    { class: "assoc__file" },
    icon("key", { size: 13 }),
    h("span", { class: "assoc__file-path", title: binding.keyPath }, binding.keyPath),
    value
      ? h(
          "span",
          { class: "tag tag--mono" },
          mask(value.value, state.settings?.maskPasswords === false),
        )
      : h("span", { class: "tag tag--danger" }, "键已不存在"),
    value?.passwordCandidate ? h("span", { class: "tag tag--warn" }, "疑似密码") : null,
    h(
      "button",
      {
        class: "btn btn--icon btn--sm",
        type: "button",
        title: "解除绑定",
        onClick: guard(async () => {
          const next = file.bindings
            .filter((item) => item.id !== binding.id)
            .map((item) => ({ keyPath: item.keyPath, entryId: item.entryId }));
          await bindFile(file.id, next);
          toast("已解除绑定", "success");
        }),
      },
      icon("x", { size: 13 }),
    ),
  );
}

function fileCard(entry, file) {
  const mine = (file.bindings ?? []).filter((binding) => binding.entryId === entry.id);
  return h(
    "div",
    { class: "stack stack--tight" },
    h(
      "div",
      { class: "assoc__file" },
      icon(file.exists ? "file" : "alert", { size: 14 }),
      h("span", { class: "assoc__file-path", title: file.path }, file.path),
      h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
      h("span", { class: "tag tag--mono" }, `${file.analysis?.values?.length ?? 0} 个键`),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "查看文件内容 / 选择密码键",
          onClick: () => navigate("sync", { syncSelection: file.id }),
        },
        icon("sliders", { size: 13 }),
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "同步此文件",
          onClick: guard(() => syncFile(file.id)),
        },
        icon("download", { size: 13 }),
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "在资源管理器中显示",
          onClick: guard(() => api.openInExplorer(file.path)),
        },
        icon("external", { size: 13 }),
      ),
    ),
    mine.length
      ? h(
          "div",
          { class: "stack stack--tight" },
          mine.map((binding) => bindingRow(entry, file, binding)),
        )
      : h(
          "p",
          { class: "form__hint" },
          "还没有为这个账号选择密码键：到「同步文件」页点选。",
        ),
  );
}

function historyBlock(entry) {
  let revealed = new Set();
  let expanded = false;
  const body = h("div", { class: "stack stack--tight" });

  function paint() {
    mount(
      body,
      expanded
        ? entry.passwordHistory.map((item, index) =>
            h(
              "div",
              { class: "assoc__file" },
              h(
                "span",
                { class: "tag tag--mono" },
                entry.historyCycle > 0 && index < entry.historyCycle ? "循环内" : "更早",
              ),
              h(
                "span",
                { class: "field__text", style: { flex: "1" } },
                revealed.has(item.id) ? item.password : mask(item.password, false),
              ),
              h("span", { class: "subtle nowrap" }, item.note || formatTime(item.recordedAt)),
              h(
                "button",
                {
                  class: "btn btn--icon btn--sm",
                  type: "button",
                  title: "显示 / 隐藏",
                  onClick: () => {
                    if (revealed.has(item.id)) revealed.delete(item.id);
                    else revealed.add(item.id);
                    paint();
                  },
                },
                icon(revealed.has(item.id) ? "eyeOff" : "eye", { size: 13 }),
              ),
              h(
                "button",
                {
                  class: "btn btn--icon btn--sm",
                  type: "button",
                  title: "复制该历史密码",
                  onClick: guard(() => copyText(item.password, "历史密码")),
                },
                icon("copy", { size: 13 }),
              ),
              h(
                "button",
                {
                  class: "btn btn--icon btn--sm",
                  type: "button",
                  title: "删除",
                  onClick: guard(async () => {
                    await removeHistory(entry.id, item.id);
                  }),
                },
                icon("x", { size: 13 }),
              ),
            ),
          )
        : null,
    );
  }
  paint();

  return h(
    "div",
    { class: "stack stack--tight" },
    h(
      "button",
      {
        class: "btn btn--ghost btn--sm",
        type: "button",
        onClick: () => {
          expanded = !expanded;
          paint();
        },
      },
      icon(expanded ? "chevronDown" : "chevronRight", { size: 13 }),
      expanded ? "收起历史密码" : `查看 ${entry.passwordHistory.length} 个历史密码`,
    ),
    body,
  );
}

function detailPane(entry) {
  let revealed = false;
  const username = effectiveUsername(entry);
  const files = filesForEntry(entry.id);
  const passwordValue = h("span", { class: "secret__value" }, mask(entry.password, revealed));
  const revealButton = h(
    "button",
    {
      class: "btn btn--icon btn--sm",
      type: "button",
      title: "显示 / 隐藏",
      onClick: () => {
        revealed = !revealed;
        passwordValue.textContent = mask(entry.password, revealed);
        mount(revealButton, icon(revealed ? "eyeOff" : "eye", { size: 14 }));
      },
    },
    icon("eye", { size: 14 }),
  );

  return h(
    "div",
    { class: "detail", onContextMenu: (event) => openEntryMenu(event, entry) },
    h(
      "div",
      { class: "detail__identity" },
      h(

        "div",
        { class: "detail__title" },
        h("h2", { class: "detail__name" }, entry.title),
        h(
          "button",
          {
            class: "btn btn--icon",
            type: "button",
            title: "编辑",
            onClick: () => openEntryEditor({ entry }),
          },
          icon("pencil", { size: 15 }),
        ),
      ),
      h(
        "div",
        { class: "detail__tags" },
        entry.categoryId === "sap" ? h("span", { class: "tag tag--accent" }, "SAP 账号") : null,
        entry.useKnoxId ? h("span", { class: "tag tag--accent" }, "Knox ID") : null,
        entry.favorite ? h("span", { class: "tag" }, "已收藏") : null,
        files.length ? h("span", { class: "tag tag--mono" }, `${files.length} 个同步文件`) : null,
      ),
    ),
    h(
      "div",
      { class: `copy-row${entry.categoryId === "sap" ? "" : " copy-row--single"}` },
      h(
        "button",
        {
          class: "btn btn--soft",
          type: "button",
          onClick: guard(() => copyPassword(entry.id)),
        },
        icon("copy", { size: 14 }),
        "复制密码",
      ),
      entry.categoryId === "sap"
        ? h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              title: "用户名与密码以换行分隔，可直接粘贴到 SAP 登录界面",
              onClick: guard(() => copySap(entry.id)),
            },
            icon("key", { size: 14 }),
            "复制用户名 + 密码",
          )
        : h(
            "button",
            {
              class: "btn",
              type: "button",
              onClick: guard(() => copyUsername(entry.id)),
            },
            icon("user", { size: 14 }),
            "复制用户名",
          ),
    ),
    entry.categoryId === "sap"
      ? entry.sap?.systemId || entry.sap?.guiparm
        ? h(
          "div",
          { class: "detail__section" },
          h(
            "div",
            { class: "detail__section-head" },
            h("div", { class: "section-title" }, icon("server", { size: 12 }), "SAP GUI 登录"),
            h("span", { class: "tag tag--mono" }, launchSummary(entry.sap)),
          ),
          h(
            "div",
            { class: "copy-row" },
            h(
              "button",
              {
                class: "btn btn--primary",
                type: "button",
                disabled: !state.guiStatus?.executable,
                title: state.guiStatus?.executable
                  ? `使用 ${state.guiStatus.executable} 启动`
                  : "没有检测到 sapshcut.exe",
                onClick: guard(() => launchSap(entry.id)),
              },
              icon("server", { size: 14 }),
              "登录 SAP GUI",
            ),
            h(
              "button",
              {
                class: "btn",
                type: "button",
                title: "导出 .sap 快捷方式（可以在资源管理器里双击或发送给别人）",
                onClick: guard(async () => {
                  const suggested = `${entry.sap?.systemId || entry.title || "sapvault"}.sap`;
                  const target = await api.pickSaveFile(suggested, "sap");
                  if (!target) return;
                  await exportSapShortcut(entry.id, target);
                }),
              },
              icon("save", { size: 14 }),
              "导出快捷方式",
            ),
          ),
          h(
            "p",
            { class: "form__hint" },
            state.settings?.sapPasswordMode === "commandLine"
              ? "当前设置：直接带密码启动（密码会出现在进程命令行里，本机其它程序可能读到）。"
              : "当前设置：打开 SAP GUI 登录界面（用户名已填好），密码已放进剪贴板，按 Ctrl+V 填入即可。",
          ),
        )
        : h(
            "div",
            { class: "detail__section" },
            h(
              "div",
              { class: "detail__section-head" },
              h("div", { class: "section-title" }, icon("server", { size: 12 }), "SAP GUI 登录"),
            ),
            h(
              "p",
              { class: "form__hint" },
              "这个账号还没有配置 SAP 登录信息（系统 ID 或连接串），所以没有一键登录和快捷方式导出。",
            ),
            h(
              "button",
              {
                class: "btn btn--sm",
                type: "button",
                onClick: () => openEntryEditor({ entry }),
              },
              icon("sliders", { size: 13 }),
              "配置 SAP 登录",
            ),
          )
      : null,
    h(
      "div",
      { class: "detail__section" },
      h("div", { class: "section-title" }, icon("user", { size: 12 }), "凭据"),
      h(
        "div",
        { class: "field" },
        h(
          "span",
          { class: "field__label" },
          entry.useKnoxId ? "用户名（全局 Knox ID）" : "用户名",
        ),
        h(
          "span",
          { class: "field__value" },
          h("span", { class: "field__text", title: username }, username || "—"),
          h(
            "span",
            { class: "field__actions" },
            h(
              "button",
              {
                class: "btn btn--icon btn--sm",
                type: "button",
                title: "复制用户名",
                onClick: guard(() => copyUsername(entry.id)),
              },
              icon("copy", { size: 13 }),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "密码"),
        h(
          "span",
          { class: "field__value" },
          passwordValue,
          h(
            "span",
            { class: "field__actions" },
            revealButton,
            h(
              "button",
              {
                class: "btn btn--icon btn--sm",
                type: "button",
                title: "复制密码",
                onClick: guard(() => copyPassword(entry.id)),
              },
              icon("copy", { size: 13 }),
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "detail__section" },
      h("div", { class: "section-title" }, icon("sliders", { size: 12 }), "密码规则"),
      h("p", { class: "form__hint" }, ruleSummary(entry.rule)),
    ),
    h(
      "div",
      { class: "detail__section" },
      h(
        "div",
        { class: "detail__section-head" },
        h("div", { class: "section-title" }, icon("clock", { size: 12 }), "密码循环"),
        h(
          "span",
          { class: "tag tag--mono" },
          entry.historyCycle > 0 ? `禁止重复最近 ${entry.historyCycle} 个` : "不校验重复",
        ),
      ),
      entry.passwordHistory.length
        ? historyBlock(entry)
        : h("p", { class: "form__hint" }, "还没有历史密码；修改密码时会自动记录。"),
    ),
    entry.notes
      ? h(
          "div",
          { class: "detail__section" },
          h("div", { class: "section-title" }, icon("file", { size: 12 }), "备注"),
          h("p", { style: { margin: "0", whiteSpace: "pre-wrap" } }, entry.notes),
        )
      : null,
    // 同步文件是 SAP 账号专属：非 SAP 分类不显示这一块，避免让人以为通用账号也能绑定文件。
    entry.categoryId === "sap"
      ? h(
          "div",
          { class: "detail__section" },
          h(
            "div",
            { class: "detail__section-head" },
            h(
              "div",
              { class: "section-title" },
              icon("link", { size: 12 }),
              `同步文件（${files.length}）`,
            ),
            h(
              "button",
              {
                class: "btn btn--ghost btn--sm",
                type: "button",
                onClick: guard(async () => {
                  const picked = await api.pickFiles();
                  if (!picked.length) return;
                  openFileDialog({ paths: picked, entryIds: [entry.id] });
                }),
              },
              icon("plus", { size: 13 }),
              "添加文件",
            ),
          ),
          files.length
            ? h(
                "div",
                { class: "stack stack--tight" },
                files.map((file) => fileCard(entry, file)),
              )
            : h(
                "p",
                { class: "form__hint" },
                "还没有绑定文件。点击「添加文件」选择 JSON、.env、TOML/INI、YAML 或 XML 文件，再在「同步文件」页点选密码对应的键；同步只会改写这些键的值。",
              ),
        )
      : null,
    h(
      "div",
      { class: "detail__section" },
      h(
        "div",
        { class: "field field--plain" },
        h("span", { class: "field__label" }, "创建"),
        h("span", { class: "muted" }, formatTime(entry.createdAt)),
      ),
      h(
        "div",
        { class: "field field--plain" },
        h("span", { class: "field__label" }, "最近更新"),
        h("span", { class: "muted" }, formatTime(entry.updatedAt)),
      ),
      h(
        "div",
        { class: "field field--plain" },
        h("span", { class: "field__label" }, "最近复制"),
        h("span", { class: "muted" }, formatTime(entry.lastUsedAt)),
      ),
    ),
  );
}

/** Master/detail view for every entry, filtered by the selected category. */
export function renderAccounts(listHost, detailHost) {
  if (!state.vault) return;
  const entries = filterEntries();
  // The detail pane must never describe an account that is not in the list that
  // is currently on screen (switching category or typing a search used to leave
  // the previous account's details behind).
  const visibleIds = new Set(entries.map((entry) => entry.id));
  const selected =
    state.selectedEntry && visibleIds.has(state.selectedEntry.id) ? state.selectedEntry : null;

  mount(
    listHost,
    entries.length
      ? h("div", { class: "list" }, entries.map(entryRow))
      : h(
          "div",
          { class: "empty" },
          h("div", { class: "empty__icon" }, icon("key", { size: 20 })),
          h(
            "h3",
            { class: "empty__title" },
            state.search ? "没有匹配的条目" : "这个分类还是空的",
          ),
          h(
            "p",
            { class: "empty__text" },
            state.search
              ? "试试其它关键字，或清空搜索框。"
              : "点击右上角「新建条目」创建账号，然后在详情里绑定需要同步的配置文件。",
          ),
        ),
  );

  if (selected) {
    mount(detailHost, detailPane(selected));
  } else {
    mount(
      detailHost,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty__icon" }, icon("shield", { size: 20 })),
        h("h3", { class: "empty__title" }, "选择左侧条目查看详情"),
        h(
          "p",
          { class: "empty__text" },
          "详情面板提供复制密码、SAP 换行凭据、密码规则与循环历史，以及同步文件与绑定关系。",
        ),
      ),
    );
  }
}
