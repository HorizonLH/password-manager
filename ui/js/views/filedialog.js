import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, addFiles, updateFileKeys } from "../state.js";
import { openModal } from "../modal.js";
import { toast } from "../toast.js";
import { FIELD_LABELS, FIELD_ORDER, formatBytes, formatLabel, mask } from "../format.js";

/** Credential blocks found in a file, with the fields they contain. */
function recordList(analysis) {
  const records = analysis?.records ?? [];
  if (!records.length) {
    return h(
      "p",
      { class: "form__hint" },
      analysis?.error ?? "没有解析到凭据块；请检查关键词，或确认文件里确实包含 URL / 用户名 / 密码。",
    );
  }
  return h(
    "div",
    { class: "stack stack--tight" },
    records.map((record) =>
      h(
        "div",
        { class: "evidence" },
        h(
          "div",
          { class: "token-list" },
          h("span", { class: "tag tag--mono" }, record.path || "文件级"),
          record.fields?.some((field) => field.kind === "url")
            ? null
            : h("span", { class: "tag tag--warn" }, "缺少 URL"),
          record.fields?.some((field) => field.kind === "password")
            ? null
            : h("span", { class: "tag tag--warn" }, "缺少密码"),
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
            hit?.line ? h("span", { class: "subtle" }, `第 ${hit.line} 行`) : null,
          );
        }),
      ),
    ),
  );
}

function keyInputs(keys, onEdit) {
  return h(
    "div",
    { class: "form__grid" },
    FIELD_ORDER.map((kind) =>
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, `${FIELD_LABELS[kind]}关键词`),
        h("input", {
          class: "input input--mono",
          value: (keys[kind] ?? []).join(", "),
          placeholder: "用逗号分隔",
          onChange: (event) => {
            keys[kind] = event.target.value
              .split(/[,;\s]+/)
              .map((value) => value.trim())
              .filter(Boolean);
            onEdit();
          },
        }),
      ),
    ),
  );
}

function accountPicker(selected) {
  const entries = (state.vault?.entries ?? []).filter((entry) => entry.categoryId === "sap");
  if (!entries.length) {
    return h(
      "p",
      { class: "form__hint" },
      "还没有 SAP 账号。先创建账号，再回来绑定。",
    );
  }
  return h(
    "div",
    { class: "stack stack--tight" },
    entries.map((entry) =>
      h(
        "label",
        { class: "checkbox" },
        h("input", {
          type: "checkbox",
          checked: selected.has(entry.id),
          onChange: (event) => {
            if (event.target.checked) selected.add(entry.id);
            else selected.delete(entry.id);
          },
        }),
        h(
          "span",
          null,
          `${entry.title}`,
          entry.username ? ` · ${entry.username}` : "",
          entry.matchUrl ? ` · ${entry.matchUrl}` : " · 未填写匹配 URL",
        ),
      ),
    ),
  );
}

/** Upload flow: inspect the chosen files, let the user fix the key words and
 *  pick the accounts to bind, then store them. */
export function openFileDialog({ paths, entryIds = [] }) {
  const bound = new Set(entryIds);
  const items = paths.map((path) => ({ path }));
  const container = h("div", { class: "stack" });

  function paint() {
    const missing = items.filter((item) => (item.inspection?.analysis?.missing ?? []).length > 0);
    mount(
      container,
      h(
        "div",
        { class: `banner${missing.length ? " banner--warn" : ""}` },
        h(
          "span",
          { class: "banner__icon" },
          icon(missing.length ? "alert" : "checkCircle", { size: 16 }),
        ),
        h(
          "div",
          { class: "banner__body" },
          h(
            "span",
            { class: "banner__title" },
            `${items.length} 个文件，其中 ${items.length - missing.length} 个已识别全部字段`,
          ),
          h(
            "span",
            null,
            "同步只会修改密码：账号需填写「匹配用 URL」，或用关键词让每个文件的每个凭据块被正确识别。",
          ),
        ),
      ),
      h(
        "div",
        { class: "card card--flat" },
        h("div", { class: "card__title" }, icon("link", { size: 15 }), "绑定账号（可选，之后也能改）"),
        accountPicker(bound),
      ),
      ...items.map((item) =>
        h(
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
                h("span", { class: "tag tag--accent" }, formatLabel(item.inspection?.format)),
                item.inspection?.label ?? item.path,
                item.inspection?.analysis?.records?.length
                  ? h(
                      "span",
                      { class: "tag tag--mono" },
                      `${item.inspection.analysis.records.length} 个凭据块`,
                    )
                  : h("span", { class: "tag tag--warn" }, "未识别到凭据块"),
              ),
              h("p", { class: "card__hint", title: item.path }, item.path),
            ),
            item.inspection?.exists
              ? h("span", { class: "tag tag--mono" }, formatBytes(item.inspection.size))
              : h("span", { class: "tag tag--danger" }, "文件不存在"),
          ),
          recordList(item.inspection?.analysis),
          keyInputs(item.inspection.keys, () => {}),
          h(
            "div",
            { style: { display: "flex", gap: "var(--s-2)", flexWrap: "wrap" } },
            h(
              "button",
              {
                class: "btn btn--soft btn--sm",
                type: "button",
                onClick: guard(async () => {
                  const [updated] = await api.fileInspect([item.path], item.inspection.keys);
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
                  item.inspection.keys = await api.keyMappingDefault();
                  const [updated] = await api.fileInspect([item.path], item.inspection.keys);
                  item.inspection = updated;
                  paint();
                }),
              },
              "恢复默认关键词",
            ),
          ),
        ),
      ),
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
          "上传后可在「同步文件」页随时调整关键词与绑定，并预览将要写入的密码。",
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
                .filter((item) => item.inspection)
                .map((item) => ({
                  path: item.inspection.path,
                  keys: item.inspection.keys,
                  entryIds: [...bound],
                }));
              if (!drafts.length) {
                toast("没有可上传的文件", "error");
                return;
              }
              await addFiles(drafts);
              close();
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
  const preview = h("div", { class: "stack stack--tight" });

  function paint() {
    mount(
      preview,
      h(
        "div",
        { class: "token-list" },
        h("span", { class: "tag tag--accent" }, formatLabel(file.analysis?.format)),
        h("span", { class: "tag tag--mono" }, file.path),
        h(
          "span",
          { class: "tag tag--mono" },
          `${file.analysis?.records?.length ?? 0} 个凭据块`,
        ),
      ),
      recordList(file.analysis),
    );
  }
  paint();

  mount(
    container,
    preview,
    keyInputs(keys, () => {}),
    h(
      "p",
      { class: "form__hint" },
      "修改关键词后点「保存并重新检测」；同步只会替换识别到的密码字段。",
    ),
  );

  openModal({
    title: `关键词：${file.label}`,
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
