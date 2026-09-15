import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  state,
  setState,
  bindFile,
  removeFile,
  reanalyzeFile,
  syncFile,
  syncAllFiles,
  loadFilePlans,
} from "../state.js";
import { confirmModal, openModal } from "../modal.js";
import { toast } from "../toast.js";
import { formatBytes, formatLabel, formatTime, mask } from "../format.js";
import { openFileDialog, openFileKeys } from "./filedialog.js";

const ACTION_LABELS = {
  update: ["将更新", "tag--accent"],
  same: ["已最新", "tag--success"],
  unbound: ["未绑定", "tag"],
  "no-password": ["无密码", "tag--warn"],
  unreachable: ["无法定位", "tag--danger"],
};

function accountName(vault, id) {
  return (vault?.entries ?? []).find((entry) => entry.id === id)?.title ?? "";
}

function selectFile(id) {
  setState({ syncSelection: id });
  guard(async () => {
    const plan = await api.filePlan(id);
    setState({ filePlans: { ...state.filePlans, [plan.fileId]: plan } });
  })();
}

function fileList(files) {
  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "pane__toolbar" },
      h("span", { class: "section-title" }, icon("file", { size: 13 }), "已上传文件"),
      h("div", { class: "modal__footer-spacer" }),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(() => loadFilePlans()),
        },
        icon("refresh", { size: 13 }),
        "检测",
      ),
    ),
    h(
      "div",
      { class: "pane__scroll pane__scroll--tight" },
      files.length
        ? h(
            "div",
            { class: "list" },
            files.map((file) => {
              const plan = state.filePlans?.[file.id];
              const selected = state.syncSelection === file.id;
              return h(
                "div",
                {
                  class: `row${selected ? " is-selected" : ""}`,
                  role: "button",
                  tabindex: "0",
                  onClick: () => selectFile(file.id),
                },
                h(
                  "span",
                  { class: "row__badge" },
                  formatLabel(file.analysis?.format).slice(0, 3).toUpperCase(),
                ),
                h(
                  "span",
                  { class: "row__body" },
                  h(
                    "span",
                    { class: "row__title" },
                    file.label,
                    file.exists ? null : h("span", { class: "tag tag--danger" }, "已删除"),
                  ),
                  h(
                    "span",
                    { class: "row__meta" },
                    h("span", { class: "mono" }, file.path),
                  ),
                  h(
                    "span",
                    { class: "row__meta" },
                    h(
                      "span",
                      { class: "tag tag--mono" },
                      `${file.analysis?.records?.length ?? 0} 块`,
                    ),
                    h(
                      "span",
                      { class: "tag" },
                      `${file.entryIds?.length ?? file.entry_ids?.length ?? 0} 账号`,
                    ),
                    plan?.updates
                      ? h("span", { class: "tag tag--accent" }, `${plan.updates} 处待更新`)
                      : h("span", { class: "tag tag--success" }, "无待更新"),
                  ),
                ),
              );
            }),
          )
        : h(
            "p",
            { class: "form__hint", style: { padding: "var(--s-3)" } },
            "还没有上传任何文件。点击右上角「上传文件」选择要同步的配置文件。",
          ),
    ),
  );
}

function bindCard(file) {
  const bound = new Set(file.entryIds ?? []);
  const entries = (state.vault?.entries ?? []).filter((entry) => entry.categoryId === "sap");
  const save = guard(async (next) => {
    await bindFile(file.id, next);
    selectFile(file.id);
  });
  return h(
    "section",
    { class: "card card--flat" },
    h(
      "div",
      { class: "card__head" },
      h(
        "div",
        null,
        h("h3", { class: "card__title" }, icon("user", { size: 15 }), "绑定账号"),
        h(
          "p",
          { class: "card__hint" },
          "一个文件可以绑定多个账号；文件里有多个凭据块时，用账号的「匹配用 URL」区分。",
        ),
      ),
    ),
    entries.length
      ? h(
          "div",
          { class: "stack stack--tight" },
          entries.map((entry) =>
            h(
              "label",
              { class: "checkbox" },
              h("input", {
                type: "checkbox",
                checked: bound.has(entry.id),
                onChange: (event) => {
                  if (event.target.checked) bound.add(entry.id);
                  else bound.delete(entry.id);
                  save([...bound]);
                },
              }),
              h(
                "span",
                null,
                entry.title,
                entry.username ? ` · ${entry.username}` : "",
                entry.matchUrl ? ` · ${entry.matchUrl}` : " · 未填写匹配 URL",
              ),
            ),
          ),
        )
      : h("p", { class: "form__hint" }, "还没有 SAP 账号，请先在「账号」页创建。"),
  );
}

function recordsTable(file, plan) {
  const rows = plan?.records ?? [];
  if (!rows.length) {
    return h(
      "p",
      { class: "form__hint" },
      plan?.error ?? "没有解析到凭据块。调整关键词后重新检测。",
    );
  }
  return h(
    "div",
    { class: "table" },
    h(
      "div",
      {
        class: "table__row table__head",
        style: { "--table-cols": "1fr 1.4fr 1fr 1.1fr 1fr 0.9fr" },
      },
      h("span", { class: "table__cell" }, "凭据块"),
      h("span", { class: "table__cell" }, "URL"),
      h("span", { class: "table__cell" }, "用户名"),
      h("span", { class: "table__cell" }, "文件中的密码"),
      h("span", { class: "table__cell" }, "账号"),
      h("span", { class: "table__cell" }, "状态"),
    ),
    rows.map((row) => {
      const [label, cls] = ACTION_LABELS[row.action] ?? [row.action, "tag"];
      return h(
        "div",
        { class: "table__row", style: { "--table-cols": "1fr 1.4fr 1fr 1.1fr 1fr 0.9fr" } },
        h("span", { class: "table__cell", title: row.path }, row.path),
        h(
          "span",
          { class: "table__cell table__cell--mono", title: row.url },
          row.url || "—",
        ),
        h("span", { class: "table__cell table__cell--mono" }, row.username || "—"),
        h(
          "span",
          { class: "table__cell table__cell--mono" },
          row.password ? mask(row.password, false) : "—",
        ),
        h(
          "span",
          { class: "table__cell" },
          row.accountTitle ?? h("span", { class: "subtle" }, "未绑定"),
        ),
        h(
          "span",
          { class: "table__cell" },
          h("span", { class: `tag ${cls}` }, label),
          row.detail ? h("span", { class: "form__hint" }, row.detail) : null,
        ),
      );
    }),
  );
}

function detailPane(file) {
  const plan = state.filePlans?.[file.id];
  const unmatched = plan?.unmatched ?? [];
  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "pane__toolbar" },
      h(
        "span",
        { class: "section-title" },
        icon("file", { size: 13 }),
        file.label,
      ),
      h("div", { class: "modal__footer-spacer" }),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(async () => {
            const preview = await api.filePreview(file.path, 4000);
            openModal({
              title: file.label,
              size: "wide",
              render: () =>
                h("pre", { class: "preview" }, preview.content),
            });
          }),
        },
        icon("eye", { size: 13 }),
        "预览",
      ),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: () => openFileKeys({ file }),
        },
        icon("sliders", { size: 13 }),
        "关键词",
      ),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(async () => {
            await reanalyzeFile(file.id);
            selectFile(file.id);
          }),
        },
        icon("refresh", { size: 13 }),
        "重新检测",
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "移除文件",
          onClick: () =>
            confirmModal({
              title: "移除文件",
              message: `确定不再同步「${file.label}」吗？`,
              detail: "只会解除绑定，不会删除或修改磁盘上的文件。",
              confirmLabel: "移除",
              danger: true,
              onConfirm: guard(async () => {
                await removeFile(file.id);
                setState({ syncSelection: null });
              }),
            }),
        },
        icon("trash", { size: 14 }),
      ),
    ),
    h(
      "div",
      { class: "pane__scroll" },
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "token-list" },
          h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
          h("span", { class: "tag tag--mono" }, formatBytes(file.size)),
          file.exists ? null : h("span", { class: "tag tag--danger" }, "文件不存在"),
          h(
            "span",
            { class: "tag tag--mono" },
            file.lastSyncAt ? `上次同步 ${formatTime(file.lastSyncAt)}` : "尚未同步",
          ),
          file.lastStatus ? h("span", { class: "tag" }, file.lastStatus) : null,
        ),
        h(
          "p",
          { class: "form__hint", title: file.path },
          file.path,
        ),
        plan?.error
          ? h(
              "div",
              { class: "banner banner--danger" },
              h("span", { class: "banner__icon" }, icon("alert", { size: 16 })),
              h("span", null, plan.error),
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: "var(--s-2)", flexWrap: "wrap" } },
          h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              disabled: !plan?.updates,
              onClick: guard(() => syncFile(file.id)),
            },
            icon("download", { size: 14 }),
            plan?.updates ? `同步此文件（${plan.updates} 处密码）` : "无需同步",
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
              class: "btn btn--ghost",
              type: "button",
              onClick: guard(() => api.openInExplorer(file.path)),
            },
            icon("external", { size: 13 }),
            "在资源管理器中显示",
          ),
        ),
        unmatched.length
          ? h(
              "div",
              { class: "banner banner--warn" },
              h("span", { class: "banner__icon" }, icon("alert", { size: 16 })),
              h(
                "div",
                { class: "banner__body" },
                h("span", { class: "banner__title" }, `${unmatched.length} 个账号未能匹配到凭据块`),
                ...unmatched.map((item) =>
                  h("span", null, `${item.accountTitle}：${item.reason}`),
                ),
              ),
            )
          : null,
        h(
          "section",
          { class: "card" },
          h(
            "div",
            { class: "card__head" },
            h(
              "div",
              null,
              h(
                "h3",
                { class: "card__title" },
                icon("filter", { size: 15 }),
                "将写入的内容",
              ),
              h(
                "p",
                { class: "card__hint" },
                "同步只替换下表中的「密码」值，文件里的其它内容（URL、用户名、注释、格式、编码）保持原样。",
              ),
            ),
            plan ? h("span", { class: "tag tag--mono" }, plan.status) : null,
          ),
          recordsTable(file, plan),
        ),
        bindCard(file),
      ),
    ),
  );
}

/** Sync view: the uploaded files, their bindings and the password sync runner. */
export function renderSync(container) {
  const vault = state.vault;
  if (!vault) return;
  const files = vault.files ?? [];

  if (!state.syncSelection && files.length) {
    // Pick the first file without triggering a re-render from inside render().
    state.syncSelection = files[0].id;
    if (!state.filePlans?.[files[0].id]) {
      api
        .filePlan(files[0].id)
        .then((plan) => setState({ filePlans: { ...state.filePlans, [plan.fileId]: plan } }))
        .catch(() => {});
    }
  }

  const selected = files.find((file) => file.id === state.syncSelection) ?? files[0];
  mount(
    container,
    h(
      "div",
      { class: "sync-layout" },
      fileList(files),
      selected
        ? detailPane(selected)
        : h(
            "div",
            { class: "pane" },
            h(
              "div",
              { class: "pane__scroll" },
              h(
                "div",
                { class: "empty" },
                h("div", { class: "empty__icon" }, icon("file", { size: 20 })),
                h("h3", { class: "empty__title" }, "还没有上传同步文件"),
                h(
                  "p",
                  { class: "empty__text" },
                  "上传 JSON、.env、TOML、YAML、XML 或纯文本文件，绑定账号后即可把密码写回文件中的对应位置。",
                ),
                h(
                  "button",
                  {
                    class: "btn btn--primary",
                    type: "button",
                    onClick: guard(async () => {
                      const files2 = await api.pickFiles();
                      if (!files2.length) return;
                      openFileDialog({ paths: files2 });
                    }),
                  },
                  icon("upload", { size: 15 }),
                  "上传文件",
                ),
              ),
            ),
          ),
    ),
  );
}
