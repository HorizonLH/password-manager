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
import { openFileKeys } from "./filedialog.js";

function hitOf(record, kind) {
  return (record.fields ?? []).find((field) => field.kind === kind) ?? null;
}

function recordRow(record) {
  return h(
    "div",
    { class: "evidence" },
    h(
      "div",
      { class: "token-list" },
      h("span", { class: "tag tag--mono" }, record.path || "文件级"),
    ),
    ...FIELD_ORDER.map((kind) => {
      const hit = hitOf(record, kind);
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

function accountCard(association) {
  const files = association.files ?? [];
  const records = files.reduce((sum, file) => sum + (file.analysis?.records?.length ?? 0), 0);
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
          association.matchUrl ? ` · 匹配 ${association.matchUrl}` : " · 未填写匹配 URL",
          files.length ? ` · ${files.length} 个文件 / ${records} 个凭据块` : " · 未绑定文件",
        ),
      ),
      files.length
        ? h("span", { class: "tag tag--success" }, "已绑定")
        : h("span", { class: "tag tag--warn" }, "未绑定"),
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
          files.map((file) =>
            h(
              "div",
              { class: "stack stack--tight" },
              h(
                "div",
                { class: "assoc__file" },
                icon(file.exists ? "file" : "alert", { size: 13 }),
                h("span", { class: "assoc__file-path", title: file.path }, file.path),
                h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
                h(
                  "span",
                  { class: "tag tag--mono" },
                  `${file.analysis?.records?.length ?? 0} 个凭据块`,
                ),
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
                  icon("sliders", { size: 12 }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "在资源管理器中显示",
                    onClick: guard(() => api.openInExplorer(file.path)),
                  },
                  icon("external", { size: 12 }),
                ),
              ),
              ...(file.analysis?.records ?? []).map(recordRow),
            ),
          ),
        )
      : h(
          "p",
          { class: "assoc__empty" },
          "尚未绑定同步文件。打开该账号，在详情里点击「添加文件」。",
        ),
  );
}

function tableView(rows) {
  const columns = "1.1fr 1fr 1.4fr 1.1fr 80px";
  return h(
    "div",
    { class: "table" },
    h(
      "div",
      { class: "table__row table__head", style: { "--table-cols": columns } },
      h("span", { class: "table__cell" }, "账号"),
      h("span", { class: "table__cell" }, "用户名"),
      h("span", { class: "table__cell" }, "匹配用 URL"),
      h("span", { class: "table__cell" }, "同步文件"),
      h("span", { class: "table__cell" }, "凭据块"),
    ),
    rows.map((association) => {
      const files = association.files ?? [];
      const records = files.reduce((sum, file) => sum + (file.analysis?.records?.length ?? 0), 0);
      return h(
        "div",
        { class: "table__row", style: { "--table-cols": columns } },
        h("span", { class: "table__cell" }, association.entryTitle),
        h("span", { class: "table__cell table__cell--mono" }, association.username || "—"),
        h("span", { class: "table__cell table__cell--mono" }, association.matchUrl || "—"),
        h(
          "span",
          { class: "table__cell" },
          files.length
            ? h("span", { class: "tag" }, `${files.length} 个`)
            : h("span", { class: "subtle" }, "未绑定"),
        ),
        h("span", { class: "table__cell table__cell--mono" }, String(records)),
      );
    }),
  );
}

/** Requirement 5.3: the account ↔ sync-file relationship rendered as UI. */
export function renderAssociations(container) {
  if (!state.vault) return;
  const term = state.assocFilter?.trim().toLowerCase() ?? "";
  const all = state.vault.associations ?? [];
  const rows = all.filter((association) => {
    if (state.assocOnlyLinked && !(association.files ?? []).length) return false;
    if (!term) return true;
    return [
      association.entryTitle,
      association.username,
      association.matchUrl,
      ...(association.files ?? []).map((file) => file.path),
      ...(association.files ?? []).flatMap((file) =>
        (file.analysis?.records ?? []).flatMap((record) =>
          (record.fields ?? []).map((field) => field.value),
        ),
      ),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  const totalFiles = new Set(
    rows.flatMap((association) => (association.files ?? []).map((file) => file.id)),
  ).size;
  const totalRecords = rows.reduce(
    (sum, association) =>
      sum +
      (association.files ?? []).reduce(
        (inner, file) => inner + (file.analysis?.records?.length ?? 0),
        0,
      ),
    0,
  );
  const unbound = all.filter((association) => !(association.files ?? []).length).length;

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
        placeholder: "按账号、用户名、匹配 URL、文件名或解析出的内容筛选",
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
      h("span", null, "只看已绑定"),
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
            h("span", { class: "tag tag--mono" }, `${totalFiles} 个同步文件`),
            h("span", { class: "tag tag--mono" }, `${totalRecords} 个凭据块`),
            unbound ? h("span", { class: "tag tag--warn" }, `${unbound} 个账号未绑定`) : null,
          ),
          h(
            "p",
            { class: "form__hint" },
            "一个文件可以绑定多个账号，一个账号也可以绑定多个文件。文件里有多个凭据块时，同步会用账号的「匹配用 URL」找到对应块，只替换其中的密码。",
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
                    ? "试试清空筛选条件，或取消「只看已绑定」。"
                    : "先在「账号」页创建 SAP 账号，然后在「同步文件」页上传并绑定文件。",
                ),
              ),
        ),
      ),
    ),
  );
}