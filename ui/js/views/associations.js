import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, selectEntry, navigate, copyText } from "../state.js";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  formatBytes,
  formatLabel,
  initials,
  mask,
} from "../format.js";
import { openKeyEditor } from "./linkkeys.js";

function hitOf(link, kind) {
  return (link.parse?.fields ?? []).find((field) => field.kind === kind) ?? null;
}

function accountCard(association) {
  const files = association.links ?? [];
  const incomplete = files.filter((link) => (link.parse?.missing ?? []).length > 0).length;

  return h(
    "article",
    { class: "assoc" },
    h(
      "div",
      { class: "assoc__head" },
      h("span", { class: "assoc__avatar" }, initials(association.entryTitle)),
      h(
        "span",
        { class: "assoc__title" },
        h("span", { class: "assoc__name" }, association.entryTitle),
        h(
          "span",
          { class: "assoc__meta" },
          association.username ? `用户名 ${association.username}` : "未设置用户名",
          files.length ? ` · ${files.length} 个同步文件` : "",
        ),
      ),
      incomplete
        ? h("span", { class: "tag tag--warn" }, `${incomplete} 个文件字段不完整`)
        : files.length
          ? h("span", { class: "tag tag--success" }, "字段完整")
          : null,
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(async () => {
            await selectEntry(association.entryId);
            navigate("accounts", { categoryId: "sap" });
          }),
        },
        icon("chevronRight", { size: 13 }),
        "查看账号",
      ),
    ),
    files.length
      ? h(
          "div",
          { class: "assoc__files" },
          files.map((link) =>
            h(
              "div",
              { class: "stack stack--tight" },
              h(
                "div",
                { class: "assoc__file" },
                icon(link.exists ? "file" : "alert", { size: 13 }),
                h("span", { class: "assoc__file-path", title: link.path }, link.path),
                h("span", { class: "tag tag--accent" }, formatLabel(link.parse?.format)),
                link.exists
                  ? h("span", { class: "tag tag--mono" }, formatBytes(link.size))
                  : h("span", { class: "tag tag--danger" }, "文件不存在"),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "关键词 / 重新检测",
                    onClick: () => openKeyEditor({ entry: { id: association.entryId }, link }),
                  },
                  icon("sliders", { size: 12 }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "在资源管理器中显示",
                    onClick: guard(() => api.openInExplorer(link.path)),
                  },
                  icon("external", { size: 12 }),
                ),
              ),
              h(
                "div",
                { class: "evidence" },
                ...FIELD_ORDER.map((kind) => {
                  const hit = hitOf(link, kind);
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
              ),
            ),
          ),
        )
      : h(
          "p",
          { class: "assoc__empty" },
          "尚未添加同步文件。打开该账号，在详情里点击「添加文件」即可。",
        ),
  );
}

function tableView(rows) {
  return h(
    "div",
    { class: "table" },
    h(
      "div",
      {
        class: "table__row table__head",
        style: { "--table-cols": "1.2fr 1fr 1.6fr 90px" },
      },
      h("span", { class: "table__cell" }, "账号"),
      h("span", { class: "table__cell" }, "用户名"),
      h("span", { class: "table__cell" }, "URL（来自同步文件）"),
      h("span", { class: "table__cell" }, "文件"),
    ),
    rows.map((association) => {
      const files = association.links ?? [];
      const url = files.map((link) => hitOf(link, "url")?.value).find(Boolean) ?? "";
      const complete =
        files.length > 0 && files.every((link) => (link.parse?.missing ?? []).length === 0);
      return h(
        "div",
        { class: "table__row", style: { "--table-cols": "1.2fr 1fr 1.6fr 90px" } },
        h("span", { class: "table__cell" }, association.entryTitle),
        h("span", { class: "table__cell table__cell--mono" }, association.username || "—"),
        h(
          "span",
          { class: "table__cell table__cell--mono" },
          url || h("span", { class: "subtle" }, "—"),
        ),
        h(
          "span",
          { class: "table__cell" },
          files.length
            ? h(
                "span",
                { class: `tag${complete ? " tag--success" : " tag--warn"}` },
                `${files.length} 个`,
              )
            : h("span", { class: "subtle" }, "未关联"),
        ),
      );
    }),
  );
}

/** Requirement 5.3: the account ↔ content-file relationship rendered as UI,
 *  including which fields were recovered from each file. */
export function renderAssociations(container) {
  if (!state.vault) return;
  const term = state.assocFilter?.trim().toLowerCase() ?? "";
  const all = state.vault.associations ?? [];
  const rows = all.filter((association) => {
    if (state.assocOnlyLinked && !(association.links ?? []).length) return false;
    if (!term) return true;
    return [
      association.entryTitle,
      association.username,
      ...(association.links ?? []).map((link) => link.path),
      ...(association.links ?? []).flatMap((link) =>
        (link.parse?.fields ?? []).map((field) => field.value),
      ),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  const totalLinks = all.reduce((sum, item) => sum + (item.links ?? []).length, 0);
  const incomplete = all.reduce(
    (sum, item) =>
      sum + (item.links ?? []).filter((link) => (link.parse?.missing ?? []).length > 0).length,
    0,
  );
  const missingFiles = all.reduce(
    (sum, item) => sum + (item.links ?? []).filter((link) => !link.exists).length,
    0,
  );

  const toolbar = h(
    "div",
    { class: "pane__toolbar" },
    h(
      "div",
      { class: "search" },
      h("span", { class: "search__icon" }, icon("search", { size: 14 })),
      h("input", {
        id: "assoc-filter",
        class: "search__input",
        placeholder: "按账号、用户名、文件名或解析出的内容筛选",
        value: state.assocFilter ?? "",
        onInput: (event) => setState({ assocFilter: event.target.value }),
      }),
    ),
    h(
      "label",
      { class: "checkbox" },
      h("input", {
        type: "checkbox",
        checked: Boolean(state.assocOnlyLinked),
        onChange: (event) => setState({ assocOnlyLinked: event.target.checked }),
      }),
      h("span", null, "只看已关联"),
    ),
    h(
      "div",
      { class: "segmented" },
      h(
        "button",
        {
          class: `segmented__item${state.assocMode !== "table" ? " is-active" : ""}`,
          type: "button",
          onClick: () => setState({ assocMode: "cards" }),
        },
        icon("link", { size: 13 }),
        "卡片",
      ),
      h(
        "button",
        {
          class: `segmented__item${state.assocMode === "table" ? " is-active" : ""}`,
          type: "button",
          onClick: () => setState({ assocMode: "table" }),
        },
        icon("file", { size: 13 }),
        "表格",
      ),
    ),
  );

  mount(
    container,
    h(
      "div",
      { class: "pane" },
      toolbar,
      h(
        "div",
        { class: "pane__scroll" },
        h(
          "div",
          { class: "stack" },
          h(
            "div",
            { class: "token-list" },
            h("span", { class: "tag tag--mono" }, `${all.length} 个 SAP 账号`),
            h("span", { class: "tag tag--mono" }, `${totalLinks} 个同步文件`),
            incomplete ? h("span", { class: "tag tag--warn" }, `${incomplete} 个字段不完整`) : null,
            missingFiles
              ? h("span", { class: "tag tag--danger" }, `${missingFiles} 个文件已不存在`)
              : null,
          ),
          h(
            "p",
            { class: "form__hint" },
            "这里展示每个 SAP 账号与同步文件之间的关联：文件由你手动选择，SapVault 会从 JSON、.env、TOML、YAML、XML 或纯文本中解析出 URL、用户名与密码，并显示所用的关键词。缺失字段可点击「关键词」手动指定。",
          ),
          rows.length
            ? state.assocMode === "table"
              ? tableView(rows)
              : h("div", { class: "stack" }, rows.map(accountCard))
            : h(
                "div",
                { class: "empty" },
                h("div", { class: "empty__icon" }, icon("link", { size: 20 })),
                h("h3", { class: "empty__title" }, "没有符合条件的关联关系"),
                h(
                  "p",
                  { class: "empty__text" },
                  all.length
                    ? "试试清空筛选条件，或取消「只看已关联」。"
                    : "先在「账号」页创建 SAP 账号，然后在详情里添加同步文件。",
                ),
              ),
        ),
      ),
    ),
  );
}
