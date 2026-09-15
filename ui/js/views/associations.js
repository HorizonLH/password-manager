import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, selectEntry, navigate, copyText } from "../state.js";
import { formatLabel, initials, mask } from "../format.js";
import { openFileKeys } from "./filedialog.js";

function bindingRow(binding) {
  return h(
    "div",
    { class: "assoc__file" },
    icon(binding.fileExists ? "file" : "alert", { size: 13 }),
    h("span", { class: "assoc__file-path", title: binding.filePath }, binding.filePath),
    h("span", { class: "tag tag--accent" }, formatLabel(binding.format)),
    h("span", { class: "tag tag--mono", title: binding.keyPath }, binding.keyPath),
    h(
      "span",
      { class: "field__text", style: { flex: "1" } },
      binding.value ? mask(binding.value, false) : "—",
    ),
    binding.passwordCandidate ? h("span", { class: "tag tag--warn" }, "疑似密码") : null,
    h(
      "button",
      {
        class: "btn btn--icon btn--sm",
        type: "button",
        title: "在资源管理器中显示",
        onClick: guard(() => api.openInExplorer(binding.filePath)),
      },
      icon("external", { size: 12 }),
    ),
  );
}

function accountCard(association) {
  const bindings = association.bindings ?? [];
  const files = new Set(bindings.map((binding) => binding.fileId)).size;
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
          bindings.length ? ` · ${files} 个文件 / ${bindings.length} 个键` : " · 未绑定键",
        ),
      ),
      bindings.length
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
    bindings.length
      ? h("div", { class: "assoc__files" }, bindings.map(bindingRow))
      : h(
          "p",
          { class: "assoc__empty" },
          "尚未绑定键。到「同步文件」页上传文件，并点选该账号密码对应的键。",
        ),
  );
}

function tableView(rows) {
  const columns = "1fr 1fr 1.4fr 1.4fr 1fr";
  return h(
    "div",
    { class: "table" },
    h(
      "div",
      { class: "table__row table__head", style: { "--table-cols": columns } },
      h("span", { class: "table__cell" }, "账号"),
      h("span", { class: "table__cell" }, "用户名"),
      h("span", { class: "table__cell" }, "文件"),
      h("span", { class: "table__cell" }, "键"),
      h("span", { class: "table__cell" }, "文件中的值"),
    ),
    rows.flatMap((association) =>
      (association.bindings ?? []).length
        ? (association.bindings ?? []).map((binding) =>
            h(
              "div",
              { class: "table__row", style: { "--table-cols": columns } },
              h("span", { class: "table__cell" }, association.entryTitle),
              h("span", { class: "table__cell table__cell--mono" }, association.username || "—"),
              h("span", { class: "table__cell table__cell--mono", title: binding.filePath }, binding.fileLabel),
              h("span", { class: "table__cell table__cell--mono", title: binding.keyPath }, binding.keyPath),
              h(
                "span",
                { class: "table__cell table__cell--mono" },
                binding.value ? mask(binding.value, false) : "—",
              ),
            ),
          )
        : [
            h(
              "div",
              { class: "table__row", style: { "--table-cols": columns } },
              h("span", { class: "table__cell" }, association.entryTitle),
              h("span", { class: "table__cell table__cell--mono" }, association.username || "—"),
              h("span", { class: "table__cell subtle" }, "未绑定"),
              h("span", { class: "table__cell" }, "—"),
              h("span", { class: "table__cell" }, "—"),
            ),
          ],
    ),
  );
}

/** The account ↔ (file, key) relationship, rendered as UI. */
export function renderAssociations(container) {
  if (!state.vault) return;
  const term = state.assocFilter?.trim().toLowerCase() ?? "";
  const all = state.vault.associations ?? [];
  const rows = all.filter((association) => {
    const bindings = association.bindings ?? [];
    if (state.assocOnlyLinked && !bindings.length) return false;
    if (!term) return true;
    return [
      association.entryTitle,
      association.username,
      ...bindings.flatMap((binding) => [binding.filePath, binding.keyPath, binding.value]),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  const files = new Set(rows.flatMap((a) => (a.bindings ?? []).map((b) => b.fileId))).size;
  const total = rows.reduce((sum, a) => sum + (a.bindings ?? []).length, 0);
  const unbound = all.filter((a) => !(a.bindings ?? []).length).length;

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
        placeholder: "按账号、文件、键或值筛选",
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
            h("span", { class: "tag tag--mono" }, `${files} 个同步文件`),
            h("span", { class: "tag tag--mono" }, `${total} 个键绑定`),
            unbound ? h("span", { class: "tag tag--warn" }, `${unbound} 个账号未绑定`) : null,
          ),
          h(
            "p",
            { class: "form__hint" },
            "关联关系是「文件 + 键」：同一个文件可以绑定多个账号（各自指向不同的键），一个账号也可以绑定多个文件的键。同步只改写这些键的值。",
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
                  "先在「账号」页创建 SAP 账号，然后在「同步文件」页上传文件并点选密码键。",
                ),
              ),
        ),
      ),
    ),
  );
}