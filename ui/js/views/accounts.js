import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  state,
  setState,
  selectEntry,
  copyPassword,
  copyUsername,
  copySap,
  copyText,
  toggleFavorite,
  bindFile,
  removeHistory,
  syncFile,
} from "../state.js";
import { openModal } from "../modal.js";
import { toast } from "../toast.js";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  formatBytes,
  formatLabel,
  formatTime,
  initials,
  mask,
  ruleSummary,
  urlHost,
} from "../format.js";
import { openEntryEditor } from "./editor.js";
import { openFileDialog, openFileKeys } from "./filedialog.js";

/** The user name actually used: the Knox ID wins when the entry asks for it. */
function effectiveUsername(entry) {
  if (entry.useKnoxId && state.vault?.knoxId) return state.vault.knoxId;
  return entry.username ?? "";
}

function filesFor(entryId) {
  return (state.vault?.files ?? []).filter((file) => (file.entryIds ?? []).includes(entryId));
}

function filterEntries() {
  const term = state.search.trim().toLowerCase();
  return (state.vault?.entries ?? []).filter((entry) => {
    if (state.categoryId !== "all" && entry.categoryId !== state.categoryId) return false;
    if (!term) return true;
    return [entry.title, entry.username, entry.matchUrl]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });
}

function entryRow(entry) {
  const selected = state.selectedEntryId === entry.id;
  const subtitle = entry.matchUrl || entry.username;
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
    },
    h("span", { class: "row__badge" }, initials(entry.title)),
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

function recordRow(record, highlight) {
  return h(
    "div",
    { class: `evidence${highlight ? "" : ""}` },
    h(
      "div",
      { class: "token-list" },
      h("span", { class: "tag tag--mono" }, record.path || "文件级"),
      highlight ? h("span", { class: "tag tag--accent" }, "匹配到本账号") : null,
    ),
    ...FIELD_ORDER.map((kind) => {
      const hit = (record.fields ?? []).find((field) => field.kind === kind);
      return h(
        "div",
        { class: "evidence__row" },
        h("span", { class: "field__label" }, FIELD_LABELS[kind]),
        hit
          ? h(
              "span",
              { class: "field__text", title: hit.value },
              kind === "password" ? mask(hit.value, false) : hit.value,
            )
          : h("span", { class: "tag tag--warn" }, "未识别"),
        hit ? h("span", { class: "tag tag--mono" }, `键 ${hit.key}`) : null,
        hit
          ? h(
              "button",
              {
                class: "btn btn--icon btn--sm",
                type: "button",
                title: `复制${FIELD_LABELS[kind]}`,
                onClick: guard(() => copyText(hit.value, FIELD_LABELS[kind])),
              },
              icon("copy", { size: 12 }),
            )
          : null,
      );
    }),
  );
}

function fileCard(entry, file) {
  const records = file.analysis?.records ?? [];
  const bare = (value) => urlHost(value).toLowerCase().split(":")[0];
  const match = bare(entry.matchUrl ?? "");
  const matchedIndex = match
    ? records.findIndex((record) => {
        const url = (record.fields ?? []).find((field) => field.kind === "url")?.value ?? "";
        const host = bare(url);
        return host === match || host.endsWith(`.${match}`) || match.endsWith(`.${host}`);
      })
    : records.length === 1
      ? 0
      : -1;

  return h(
    "div",
    { class: "stack stack--tight" },
    h(
      "div",
      { class: "assoc__file" },
      icon(file.exists ? "file" : "alert", { size: 14 }),
      h("span", { class: "assoc__file-path", title: file.path }, file.path),
      h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
      h("span", { class: "tag tag--mono" }, `${records.length} 个凭据块`),
      file.exists
        ? h("span", { class: "tag tag--mono" }, formatBytes(file.size))
        : h("span", { class: "tag tag--danger" }, "文件不存在"),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "关键词 / 重新检测",
          onClick: () => openFileKeys({ file }),
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
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "解除与该账号的绑定",
          onClick: guard(async () => {
            const next = (file.entryIds ?? []).filter((id) => id !== entry.id);
            await bindFile(file.id, next);
            toast("已解除绑定", "success");
          }),
        },
        icon("x", { size: 13 }),
      ),
    ),
    records.length
      ? h(
          "div",
          { class: "stack stack--tight" },
          records.map((record, index) => recordRow(record, index === matchedIndex)),
        )
      : h("p", { class: "form__hint" }, "没有解析到凭据块，请调整关键词后重新检测。"),
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
  const files = filesFor(entry.id);
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
    { class: "detail" },
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
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "匹配用 URL（用于在同步文件中定位凭据块）"),
        h(
          "span",
          { class: "field__value" },
          h(
            "span",
            { class: "field__text", title: entry.matchUrl },
            entry.matchUrl || "未设置",
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
    h(
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
            "还没有绑定文件。点击「添加文件」选择 JSON、.env、TOML、YAML、XML 或纯文本文件；同步时只会改写其中的密码。",
          ),
    ),
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

  if (state.selectedEntry) {
    mount(detailHost, detailPane(state.selectedEntry));
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
