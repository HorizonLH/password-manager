import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, selectEntry, navigate } from "../state.js";
import { formatBytes, formatTime, originLabel, shortSid } from "../format.js";

function accountCard(association) {
  const files = association.links ?? [];
  return h(
    "article",
    { class: "assoc" },
    h(
      "div",
      { class: "assoc__head" },
      h("span", { class: "assoc__avatar" }, shortSid(association.systemId || association.entryTitle)),
      h(
        "span",
        { class: "assoc__title" },
        h(
          "span",
          { class: "assoc__name" },
          association.entryTitle,
          association.systemId
            ? h("span", { class: "tag tag--accent tag--mono", style: { marginLeft: "8px" } }, association.systemId)
            : null,
        ),
        h(
          "span",
          { class: "assoc__meta" },
          association.username ? `用户 ${association.username}` : "未设置用户名",
          association.hosts?.length ? ` · 主机 ${association.hosts.join(", ")}` : "",
        ),
      ),
      h(
        "span",
        { class: "tag" },
        icon("link", { size: 11 }),
        `${files.length} 个文件`,
      ),
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
              { class: "assoc__file" },
              icon(link.exists ? "file" : "alert", { size: 13 }),
              h("span", { class: "assoc__file-path", title: link.path }, link.path),
              h(
                "span",
                { class: `tag${link.origin === "scan" ? " tag--accent" : ""}` },
                originLabel(link.origin),
              ),
              h("span", { class: "tag tag--mono" }, formatBytes(link.size)),
              link.modifiedAt
                ? h("span", { class: "subtle", style: { fontSize: "11.5px" } }, formatTime(link.modifiedAt))
                : null,
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
          ),
        )
      : h(
          "p",
          { class: "assoc__empty" },
          "尚未关联文件。可以在账号详情里手动添加，或到“扫描文件”页按系统 ID 与用户名自动查找。",
        ),
  );
}

function tableView(rows) {
  return h(
    "div",
    { class: "table" },
    h(
      "div",
      { class: "table__row table__head", style: { "--table-cols": "120px 1.4fr 1fr 1.4fr 90px" } },
      h("span", { class: "table__cell" }, "系统 ID"),
      h("span", { class: "table__cell" }, "账号"),
      h("span", { class: "table__cell" }, "用户名"),
      h("span", { class: "table__cell" }, "关联文件"),
      h("span", { class: "table__cell" }, "来源"),
    ),
    rows.map((association) =>
      h(
        "div",
        {
          class: "table__row",
          style: { "--table-cols": "120px 1.4fr 1fr 1.4fr 90px" },
        },
        h(
          "span",
          { class: "table__cell" },
          h("span", { class: "tag tag--accent tag--mono" }, association.systemId || "—"),
        ),
        h("span", { class: "table__cell" }, association.entryTitle),
        h("span", { class: "table__cell table__cell--mono" }, association.username || "—"),
        h(
          "span",
          { class: "table__cell" },
          (association.links ?? []).length
            ? (association.links ?? []).map((link) => link.label).join("、")
            : h("span", { class: "subtle" }, "未关联"),
        ),
        h(
          "span",
          { class: "table__cell" },
          (association.links ?? []).some((link) => link.origin === "scan")
            ? h("span", { class: "tag tag--accent" }, "含扫描结果")
            : (association.links ?? []).length
              ? h("span", { class: "tag" }, "手动")
              : h("span", { class: "subtle" }, "—"),
        ),
      ),
    ),
  );
}

/** Requirement 5.3: the account ↔ content-file relationship rendered as UI. */
export function renderAssociations(container) {
  if (!state.vault) return;
  const term = state.assocFilter?.trim().toLowerCase() ?? "";
  const all = state.vault.associations ?? [];
  const rows = all.filter((association) => {
    if (state.assocOnlyLinked && !(association.links ?? []).length) return false;
    if (!term) return true;
    return [
      association.entryTitle,
      association.systemId,
      association.username,
      ...(association.hosts ?? []),
      ...(association.links ?? []).map((link) => link.path),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  const totalLinks = all.reduce((sum, item) => sum + (item.links ?? []).length, 0);
  const scannedLinks = all.reduce(
    (sum, item) => sum + (item.links ?? []).filter((link) => link.origin === "scan").length,
    0,
  );
  const missing = all.reduce(
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
        placeholder: "按账号、系统 ID、用户名或文件名筛选",
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
    h("div", { class: "modal__footer-spacer" }),
    h(
      "button",
      {
        class: "btn btn--soft btn--sm",
        type: "button",
        onClick: () => navigate("scan"),
      },
      icon("radar", { size: 13 }),
      "去扫描新内容",
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
            h("span", { class: "tag tag--mono" }, `${totalLinks} 个关联文件`),
            scannedLinks
              ? h("span", { class: "tag tag--accent tag--mono" }, `其中 ${scannedLinks} 个来自扫描`)
              : null,
            missing
              ? h("span", { class: "tag tag--warn tag--mono" }, `${missing} 个文件已不存在`)
              : null,
          ),
          h(
            "p",
            { class: "form__hint" },
            "这里展示每个 SAP 账号与「需要同步的内容」之间的关联：手动添加的文件标记为“手动”，由扫描按系统 ID 与用户名命中的标记为“扫描”。同步目标会把账号信息与这些文件清单一起写入全局配置。",
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
                    ? "试试清空筛选条件，或取消“只看已关联”。"
                    : "先在“账号”页创建 SAP 账号，然后手动添加文件或运行一次扫描。",
                ),
              ),
        ),
      ),
    ),
  );
}
