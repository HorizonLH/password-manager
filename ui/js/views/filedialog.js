import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, addFiles, bindFile, navigate, updateFileKeys } from "../state.js";
import { openModal } from "../modal.js";
import { toast } from "../toast.js";
import { formatBytes, formatLabel, mask } from "../format.js";

const VALUE_COLS = "1.4fr 1.3fr 92px 64px";

/** Every key/value pair the parser found, so the user can see at a glance
 *  whether the password key was recognised. Picking the *one* key that holds
 *  the password happens in the 「同步文件」 view, where the same values are
 *  rendered as a collapsible tree (JSON/YAML/XML) or a flat table. */
function valueTable(values, { limit = 30 } = {}) {
  if (!values.length) {
    return h("p", { class: "form__hint" }, "没有解析到键值对。");
  }
  const shown = values.slice(0, limit);
  const candidates = values.filter((value) => value.passwordCandidate).length;
  return h(
    "div",
    { class: "stack stack--tight" },
    h(
      "div",
      { class: "token-list" },
      h("span", { class: "tag tag--mono" }, `${values.length} 个键`),
      candidates
        ? h("span", { class: "tag tag--warn" }, `${candidates} 个疑似密码`)
        : h("span", { class: "tag" }, "没有命中密码关键词"),
    ),
    h(
      "div",
      { class: "table" },
      h(
        "div",
        { class: "table__row table__head", style: { "--table-cols": VALUE_COLS } },
        h("span", { class: "table__cell" }, "键"),
        h("span", { class: "table__cell" }, "值"),
        h("span", { class: "table__cell" }, "标记"),
        h("span", { class: "table__cell" }, "行"),
      ),
      shown.map((value) =>
        h(
          "div",
          { class: "table__row", style: { "--table-cols": VALUE_COLS } },
          h("span", { class: "table__cell table__cell--mono", title: value.path }, value.path),
          h(
            "span",
            { class: "table__cell table__cell--mono" },
            value.passwordCandidate
              ? mask(value.value, state.settings?.maskPasswords === false)
              : value.value || "—",
          ),
          h(
            "span",
            { class: "table__cell" },
            value.passwordCandidate
              ? h("span", { class: "tag tag--warn" }, "疑似密码")
              : null,
          ),
          h("span", { class: "table__cell" }, String(value.line)),
        ),
      ),
    ),
    values.length > shown.length
      ? h("p", { class: "form__hint" }, `只列出前 ${shown.length} 个键，其余在「同步文件」页查看。`)
      : null,
  );
}

/** The only keyword that matters for syncing: the one that marks a key as
 *  「疑似密码」. Everything else in the file is shown so it can be picked by hand. */
function passwordKeyRow(keys, onEdit) {
  return h(
    "div",
    { class: "form__grid" },
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "密码关键词（用逗号分隔）"),
      h("input", {
        class: "input input--mono",
        value: (keys.password ?? []).join(", "),
        placeholder: "password, passwd, pwd, secret",
        onChange: (event) => {
          keys.password = event.target.value
            .split(/[,;\s]+/)
            .map((value) => value.trim())
            .filter(Boolean);
          onEdit();
        },
      }),
      h(
        "p",
        { class: "form__hint" },
        "只影响「疑似密码」标记；没有命中的键同样可以在「同步文件」页手动绑定账号。",
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "匹配方式"),
      h(
        "div",
        { style: { display: "flex", gap: "var(--s-4)", flexWrap: "wrap" } },
        h(
          "label",
          { class: "checkbox" },
          h("input", {
            type: "checkbox",
            checked: keys.ignoreCase !== false,
            onChange: (event) => {
              keys.ignoreCase = event.target.checked;
              onEdit();
            },
          }),
          h("span", null, "忽略大小写"),
        ),
        h(
          "label",
          { class: "checkbox" },
          h("input", {
            type: "checkbox",
            checked: Boolean(keys.exact),
            onChange: (event) => {
              keys.exact = event.target.checked;
              onEdit();
            },
          }),
          h("span", null, "键名必须完全一致"),
        ),
      ),
    ),
  );
}

function fileCard(item, paint) {
  const inspection = item.inspection;
  const analysis = inspection?.analysis;
  const supported = inspection?.supported !== false;
  return h(
    "article",
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
          h("span", { class: "tag tag--accent" }, formatLabel(inspection?.format)),
          inspection?.label ?? item.path,
        ),
        h("p", { class: "card__hint", title: item.path }, item.path),
      ),
      inspection
        ? supported
          ? h("span", { class: "tag tag--mono" }, formatBytes(inspection.size))
          : h("span", { class: "tag tag--danger" }, "不支持的格式")
        : h("span", { class: "tag" }, "读取中…"),
    ),
    !inspection
      ? h("p", { class: "form__hint" }, "正在解析…")
      : !supported
        ? h(
            "p",
            { class: "form__hint" },
            "只支持能按键定位值的结构：JSON、.env、TOML / INI / .properties / .tfvars、YAML、XML（含 .config / .plist / .resx）。",
          )
        : h(
            "div",
            { class: "stack stack--tight" },
            analysis?.error
              ? h("p", { class: "form__hint" }, analysis.error)
              : valueTable(analysis?.values ?? []),
            passwordKeyRow(inspection.keys, () => {}),
            h(
              "div",
              { style: { display: "flex", gap: "var(--s-2)", flexWrap: "wrap" } },
              h(
                "button",
                {
                  class: "btn btn--soft btn--sm",
                  type: "button",
                  onClick: guard(async () => {
                    const [updated] = await api.fileInspect([item.path], inspection.keys);
                    item.inspection = updated;
                    paint();
                  }),
                },
                icon("refresh", { size: 13 }),
                "重新检测",
              ),
              h(
                "button",
                {
                  class: "btn btn--ghost btn--sm",
                  type: "button",
                  onClick: guard(async () => {
                    inspection.keys = await api.keyMappingDefault();
                    const [updated] = await api.fileInspect([item.path], inspection.keys);
                    item.inspection = updated;
                    paint();
                  }),
                },
                "恢复默认关键词",
              ),
            ),
          ),
  );
}

/** Binds every 「疑似密码」 key of the just-uploaded files to one account, so the
 *  flow 「先选账号 → 再上传文件」 still lands somewhere useful. */
async function bindCandidates(vault, drafts, entryId) {
  const wanted = new Set(drafts.map((draft) => draft.path));
  let bound = 0;
  for (const file of vault.files ?? []) {
    if (!wanted.has(file.path)) continue;
    const next = (file.bindings ?? []).map((binding) => ({
      keyPath: binding.keyPath,
      entryId: binding.entryId,
    }));
    const taken = new Set(next.map((binding) => binding.keyPath));
    let added = false;
    for (const value of file.analysis?.values ?? []) {
      if (!value.passwordCandidate || taken.has(value.path)) continue;
      next.push({ keyPath: value.path, entryId });
      taken.add(value.path);
      bound += 1;
      added = true;
    }
    if (added) await bindFile(file.id, next);
  }
  return bound;
}

/** Upload flow: parse the chosen files, show what was found, keep them in the
 *  vault. The key → account binding itself is done in the 「同步文件」 view. */
export function openFileDialog({ paths, entryIds = [] }) {
  const items = paths.map((path) => ({ path }));
  const container = h("div", { class: "stack" });

  function paint() {
    const parsed = items.filter((item) => item.inspection);
    const unsupported = parsed.filter((item) => !item.inspection.supported).length;
    const candidates = parsed.reduce(
      (sum, item) =>
        sum +
        (item.inspection.analysis?.values ?? []).filter((value) => value.passwordCandidate).length,
      0,
    );
    mount(
      container,
      h(
        "div",
        { class: `banner${unsupported ? " banner--warn" : ""}` },
        h("span", { class: "banner__icon" }, icon(unsupported ? "alert" : "checkCircle", { size: 16 })),
        h(
          "div",
          { class: "banner__body" },
          h(
            "span",
            { class: "banner__title" },
            `${items.length} 个文件 · ${candidates} 个疑似密码键` +
              (unsupported ? ` · ${unsupported} 个格式不支持` : ""),
          ),
          h(
            "span",
            null,
            "上传后到「同步文件」页点选每个文件里密码对应的键并绑定账号：一个文件可以绑多个账号（各选不同的键），一个账号也可以绑多个文件。同步只改写被绑定的那个键的值。",
          ),
        ),
      ),
      ...items.map((item) => fileCard(item, paint)),
    );
  }

  paint();

  guard(async () => {
    const inspections = await api.fileInspect(paths, null);
    items.forEach((item, index) => {
      item.inspection = inspections[index] ?? null;
    });
    paint();
  })();

  openModal({
    title: "上传同步文件",
    size: "wide",
    render: () => container,
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "var(--s-2)", width: "100%", alignItems: "center" } },
        h(
          "span",
          { class: "form__hint" },
          "原文件不会被移动或重写，直到你点「同步」。",
        ),
        h("div", { class: "modal__footer-spacer" }),
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: guard(async () => {
              const drafts = items
                .filter((item) => item.inspection?.supported)
                .map((item) => ({ path: item.inspection.path, keys: item.inspection.keys }));
              if (!drafts.length) {
                toast("没有可上传的文件：格式不支持", "error");
                return;
              }
              const vault = await addFiles(drafts);
              close();
              if (!entryIds.length) return;
              const bound = await bindCandidates(vault, drafts, entryIds[0]);
              const entry = (vault.entries ?? []).find((item) => item.id === entryIds[0]);
              const first = (vault.files ?? []).find((file) => file.path === drafts[0].path);
              if (bound && entry) {
                toast(`已把 ${bound} 个疑似密码键绑定到「${entry.title}」`, "success");
              } else {
                toast("请到「同步文件」页点选密码对应的键并绑定账号", "info");
              }
              navigate("sync", { syncSelection: first?.id ?? null });
            }),
          },
          icon("upload", { size: 14 }),
          "上传",
        ),
      ),
  });
}

/** Keyword editor for a file that is already registered. */
export function openFileKeys({ file }) {
  const keys = { ...file.keys };
  const container = h("div", { class: "stack" });

  mount(
    container,
    h(
      "div",
      { class: "token-list" },
      h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
      h("span", { class: "tag tag--mono", title: file.path }, file.label),
      h("span", { class: "tag tag--mono" }, `${file.analysis?.values?.length ?? 0} 个键`),
      h("span", { class: "tag tag--mono" }, `${file.bindings?.length ?? 0} 个绑定`),
    ),
    valueTable(file.analysis?.values ?? [], { limit: 16 }),
    passwordKeyRow(keys, () => {}),
    h(
      "p",
      { class: "form__hint" },
      "修改关键词后点「保存并重新检测」；同步只替换你绑定过的键，其它内容和格式保持不变。",
    ),
  );

  openModal({
    title: `密码关键词：${file.label}`,
    size: "wide",
    render: () => container,
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "var(--s-2)", width: "100%", justifyContent: "flex-end" } },
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: guard(async () => {
              await updateFileKeys(file.id, keys);
              close();
            }),
          },
          "保存并重新检测",
        ),
      ),
  });
}
