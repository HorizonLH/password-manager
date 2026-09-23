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
import { searchSelect } from "../combobox.js";

const ACTIONS = {
  update: ["将更新", "tag--accent"],
  same: ["已最新", "tag--success"],
  "missing-key": ["键已不存在", "tag--danger"],
  "no-password": ["账号缺密码", "tag--warn"],
};

const TREE_FORMATS = new Set(["json", "yaml", "xml"]);

/** Short, complete names for the file-type chip in the file list. */
const FILE_CHIPS = {
  json: "JSON",
  yaml: "YAML",
  xml: "XML",
  env: ".env",
  toml: "TOML",
  ini: "INI",
  properties: ".properties",
  hcl: "TFVARS",
};

function fileChip(file) {
  const format = file.analysis?.format ?? "";
  const label = FILE_CHIPS[format];
  if (!label) {
    return h(
      "span",
      { class: "row__badge row__badge--danger", title: "不支持的格式" },
      icon("alert", { size: 15 }),
    );
  }
  return h("span", { class: "row__badge row__badge--label", title: `文件类型 ${label}` }, label);
}

/** Branch state is remembered per file, so re-rendering the view (for example
 *  right after binding a key) never collapses what the user had open. */
function branchOpen(fileId, path, depth) {
  return state.treeOpen?.[fileId]?.[path] ?? depth < 1;
}

function rememberBranch(fileId, path, open) {
  state.treeOpen = state.treeOpen ?? {};
  state.treeOpen[fileId] = { ...(state.treeOpen[fileId] ?? {}), [path]: open };
}

function planFor(fileId) {
  return state.filePlans?.[fileId];
}

/** Which file list we already asked plans for, so the request happens once per
 *  change instead of on every render. */
let plannedSignature = "";

/** Loads the sync plan of every uploaded file, so the list shows the real status
 *  right away instead of "—" until the user presses 重新检测. */
function requestMissingPlans(files) {
  const signature = files.map((file) => file.id).join("|");
  if (signature === plannedSignature) return;
  if (files.every((file) => planFor(file.id))) return;
  plannedSignature = signature;
  loadFilePlans().catch(() => {});
}

/** Password values are masked unless masking is off in settings, or the user
 *  pressed the per-file 「显示密码值」 toggle. */
function revealValues() {
  return state.syncReveal ?? state.settings?.maskPasswords === false;
}

function accountOptions(file, keyPath) {
  const current = file.bindings.find((binding) => binding.keyPath === keyPath)?.entryId ?? "";
  // SAP accounts can number in the hundreds, so this is a searchable picker
  // instead of a native select (see ui/js/combobox.js).
  const options = (state.vault?.entries ?? [])
    .filter((entry) => entry.categoryId === "sap")
    .map((entry) => ({
      value: entry.id,
      label: entry.title,
      hint: entry.username || "",
    }));
  return searchSelect({
    options,
    value: current,
    emptyLabel: "未绑定",
    searchPlaceholder: `搜索账号（共 ${options.length} 个）`,
    small: true,
    onSelect: guard(async (next) => {
      const bindings = file.bindings.filter((binding) => binding.keyPath !== keyPath);
      if (next) bindings.push({ keyPath, entryId: next });
      await bindFile(file.id, bindings);
      selectFile(file.id);
    }),
  });
}

function valueRow(file, value, label, planRow) {
  const [actionLabel, actionClass] = planRow ? ACTIONS[planRow.action] ?? [] : [];
  return h(
    "div",
    { class: "tree__row" },
    h("span", { class: "tree__key mono", title: value.path }, label),
    h(
      "span",
      { class: "tree__value mono", title: value.value },
      value.passwordCandidate ? mask(value.value, revealValues()) : value.value || "—",
    ),
    value.passwordCandidate ? h("span", { class: "tag tag--warn" }, "疑似密码") : null,
    actionLabel ? h("span", { class: `tag ${actionClass}` }, actionLabel) : null,
    h("span", { class: "subtle" }, `第 ${value.line} 行`),
    accountOptions(file, value.path),
  );
}

function buildTree(values) {
  const root = { name: "", path: "", children: new Map(), values: [] };
  for (const value of values) {
    const parts = value.path.split(".");
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!node.children.has(key)) {
        node.children.set(key, {
          name: key,
          path: node.path ? `${node.path}.${key}` : key,
          children: new Map(),
          values: [],
        });
      }
      node = node.children.get(key);
    }
    node.values.push(value);
  }
  return root;
}

function treeNode(file, node, planRows, depth, forceOpen = false) {
  return h(
    "div",
    { class: "tree__branch" },
    node.values.map((value) =>
      valueRow(file, value, value.key, planRows.get(value.path)),
    ),
    [...node.children.values()].map((child) =>
      h(
        "details",
        {
          class: "tree__details",
          // While filtering, every branch is expanded: the matching keys are
          // what the user is after, not the shape of the document.
          open: forceOpen || branchOpen(file.id, child.path, depth),
          onToggle: (event) => rememberBranch(file.id, child.path, event.target.open),
        },
        h(
          "summary",
          { class: "tree__summary" },
          icon("chevronRight", { size: 12, class: "tree__chevron" }),
          h("span", { class: "tree__name" }, child.name),
        ),
        treeNode(file, child, planRows, depth + 1, forceOpen),
      ),
    ),
  );
}

/** The keys of one file, narrowed down by the filter box. Dozens of keys is the
 *  normal case for a .env or a landscape fragment, and scrolling a tree to find
 *  one key does not scale. */
function keyFilterTerm() {
  return (state.syncKeyFilter ?? "").trim().toLowerCase();
}

function matchingValues(values) {
  const term = keyFilterTerm();
  if (!term) return values;
  return values.filter((value) =>
    `${value.path} ${value.value}`.toLowerCase().includes(term),
  );
}

function structureView(file, plan) {
  const all = file.analysis?.values ?? [];
  if (!all.length) {
    return h(
      "p",
      { class: "form__hint" },
      file.analysis?.error ?? "没有解析到键值对。",
    );
  }
  const term = keyFilterTerm();
  const values = matchingValues(all);
  const planRows = new Map((plan?.rows ?? []).map((row) => [row.keyPath, row]));
  if (!values.length) {
    return h(
      "div",
      { class: "stack stack--tight" },
      h(
        "p",
        { class: "form__hint" },
        `没有匹配「${state.syncKeyFilter}」的键（共 ${all.length} 个键）。`,
      ),
      h(
        "button",
        { class: "btn btn--sm", type: "button", onClick: () => setState({ syncKeyFilter: "" }) },
        icon("x", { size: 13 }),
        "清除筛选",
      ),
    );
  }
  const format = file.analysis?.format ?? "";
  const counter = term
    ? h(
        "div",
        { class: "token-list" },
        h("span", { class: "tag tag--accent" }, `${values.length} / ${all.length} 个键匹配`),
      )
    : null;
  if (TREE_FORMATS.has(format)) {
    return h(
      "div",
      { class: "stack stack--tight" },
      counter,
      h("div", { class: "tree" }, treeNode(file, buildTree(values), planRows, 0, Boolean(term))),
    );
  }
  return h(
    "div",
    { class: "stack stack--tight" },
    counter,
    h(
      "div",
      { class: "table" },
      h(
        "div",
        { class: "table__row table__head", style: { "--table-cols": "1.3fr 1.4fr 80px 150px" } },
        h("span", { class: "table__cell" }, "键"),
        h("span", { class: "table__cell" }, "值"),
        h("span", { class: "table__cell" }, "行"),
        h("span", { class: "table__cell" }, "绑定账号"),
      ),
      values.map((value) =>
        h(
          "div",
          { class: "table__row", style: { "--table-cols": "1.3fr 1.4fr 80px 150px" } },
          h("span", { class: "table__cell table__cell--mono", title: value.path }, value.path),
          h(
            "span",
            { class: "table__cell table__cell--mono" },
            value.passwordCandidate ? mask(value.value, revealValues()) : value.value,
          ),
          h("span", { class: "table__cell subtle" }, String(value.line)),
          h("span", { class: "table__cell" }, accountOptions(file, value.path)),
        ),
      ),
    ),
  );
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
      h("span", { class: "form__hint" }, "也可把文件拖进来"),
    ),
    h(
      "div",
      { class: "pane__scroll pane__scroll--tight", dataset: { scrollKey: "sync-list" } },
      files.length
        ? h(
            "div",
            { class: "list" },
            files.map((file) => {
              const plan = planFor(file.id);
              return h(
                "div",
                {
                  class: `row${state.syncSelection === file.id ? " is-selected" : ""}`,
                  role: "button",
                  tabindex: "0",
                  onClick: () => selectFile(file.id),
                },
                fileChip(file),
                h(
                  "span",
                  { class: "row__body" },
                  h("span", { class: "row__title" }, file.label),
                  h("span", { class: "row__meta" }, h("span", { class: "mono" }, file.path)),
                  h(
                    "span",
                    { class: "row__meta" },
                    h("span", { class: "tag tag--mono" }, `${file.analysis?.values?.length ?? 0} 个键`),
                    h("span", { class: "tag" }, `${file.bindings.length} 个绑定`),
                    plan?.updates
                      ? h("span", { class: "tag tag--accent" }, `${plan.updates} 处待更新`)
                      : h("span", { class: "tag tag--success" }, plan?.status ?? "—"),
                  ),
                ),
              );
            }),
          )
        : h("p", { class: "form__hint", style: { padding: "var(--s-3)" } }, "还没有上传文件。"),
    ),
  );
}

function detailPane(file) {
  const plan = planFor(file.id);
  const bindings = file.bindings ?? [];
  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "pane__toolbar" },
      h("span", { class: "section-title" }, icon("file", { size: 13 }), file.label),
      h("div", { class: "modal__footer-spacer" }),
      h(
        "button",
        { class: "btn btn--ghost btn--sm", type: "button", onClick: guard(async () => {
            const preview = await api.filePreview(file.path, 4000);
            openModal({ title: file.label, size: "wide", render: () => h("pre", { class: "preview" }, preview.content) });
          }) },
        icon("eye", { size: 13 }),
        "预览",
      ),
      h(
        "button",
        { class: "btn btn--ghost btn--sm", type: "button", onClick: () => openFileKeys({ file }) },
        icon("sliders", { size: 13 }),
        "密码关键词",
      ),
      h(
        "button",
        {
          class: `btn btn--sm ${revealValues() ? "btn--soft" : "btn--ghost"}`,
          type: "button",
          title: revealValues() ? "隐藏文件里的密码值" : "显示文件里的密码值",
          onClick: () => setState({ syncReveal: !revealValues() }),
        },
        icon("eye", { size: 13 }),
        revealValues() ? "隐藏密码值" : "显示密码值",
      ),
      h(
        "button",
        { class: "btn btn--ghost btn--sm", type: "button", onClick: guard(async () => {
            await reanalyzeFile(file.id);
            selectFile(file.id);
          }) },
        icon("refresh", { size: 13 }),
        "重新解析",
      ),
      h(
        "button",
        { class: "btn btn--icon btn--sm", type: "button", title: "移除文件", onClick: () =>
            confirmModal({
              title: "移除文件",
              message: `确定不再同步「${file.label}」吗？`,
              detail: "只会解除绑定，不会修改磁盘上的文件。",
              confirmLabel: "移除",
              danger: true,
              onConfirm: guard(async () => {
                await removeFile(file.id);
                setState({ syncSelection: null });
              }),
            }) },
        icon("trash", { size: 14 }),
      ),
    ),
    h(
      "div",
      { class: "pane__scroll", dataset: { scrollKey: "sync-detail" } },
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "token-list" },
          h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
          h("span", { class: "tag tag--mono" }, formatBytes(file.size)),
          file.exists ? null : h("span", { class: "tag tag--danger" }, "文件不存在"),
          h("span", { class: "tag tag--mono" }, file.lastSyncAt ? `上次同步 ${formatTime(file.lastSyncAt)}` : "尚未同步"),
          plan ? h("span", { class: "tag" }, plan.status) : null,
        ),
        h("p", { class: "form__hint", title: file.path }, file.path),
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
            plan?.updates ? `同步（更新 ${plan.updates} 处密码）` : "无需同步",
          ),
          h("button", { class: "btn", type: "button", onClick: guard(() => syncAllFiles()) }, icon("download", { size: 14 }), "全部同步"),
          h("button", { class: "btn btn--ghost", type: "button", onClick: guard(() => api.openInExplorer(file.path)) }, icon("external", { size: 13 }), "显示文件"),
        ),
        h(
          "section",
          { class: "card" },
          h(
            "div",
            { class: "card__head" },
            h(
              "div",
              null,
              h("h3", { class: "card__title" }, icon("filter", { size: 15 }), "文件内容（选择密码对应的键）"),
              h(
                "p",
                { class: "card__hint" },
                "同步只替换你在右侧选了账号的那些键的值；其它内容（其它键、注释、缩进、编码）保持原样。已绑定 " +
                  `${bindings.length} 个键。`,
              ),
            ),
          ),
          // Filters the key list below; `Ctrl+K` focuses it (see bindShortcuts).
          h(
            "div",
            { class: "search" },
            h("span", { class: "search__icon" }, icon("search", { size: 14 })),
            h("input", {
              id: "sync-key-filter",
              class: "search__input",
              placeholder: "筛选键：按键路径或值匹配（Ctrl+K）",
              title: "按键路径或值筛选",
              value: state.syncKeyFilter ?? "",
              onInput: (event) => setState({ syncKeyFilter: event.target.value }),
            }),
          ),
          structureView(file, plan),
        ),
      ),
    ),
  );
}

export function renderSync(container) {
  const vault = state.vault;
  if (!vault) return;
  const files = vault.files ?? [];
  if (!state.syncSelection && files.length) {
    state.syncSelection = files[0].id;
  }
  requestMissingPlans(files);
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
                  "上传 JSON、.env、TOML/INI、YAML 或 XML 文件，然后在文件内容里点选密码对应的键并绑定账号；" +
                    "也可以把文件直接拖进这个窗口。",
                ),
                h(
                  "button",
                  { class: "btn btn--primary", type: "button", onClick: guard(async () => {
                      const picked = await api.pickFiles();
                      if (!picked.length) return;
                      openFileDialog({ paths: picked });
                    }) },
                  icon("upload", { size: 15 }),
                  "上传文件",
                ),
              ),
            ),
          ),
    ),
  );
}
