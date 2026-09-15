import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, refreshVault, selectEntry } from "../state.js";
import { openModal } from "../modal.js";
import { toast } from "../toast.js";
import { FIELD_LABELS, FIELD_ORDER, formatBytes, formatLabel, mask } from "../format.js";

/** One row per credential field: what was found (or not) plus the key words
 *  used to look for it. */
function fieldRow(kind, inspection, onChange, onRedetect) {
  const hit = (inspection.parse.fields ?? []).find((field) => field.kind === kind);
  const [keyInput] = [
    h("input", {
      class: "input input--mono",
      value: (inspection.keys[kind] ?? []).join(", "),
      placeholder: "用逗号分隔，例如 url, server, host",
      onChange: (event) => {
        inspection.keys[kind] = event.target.value
          .split(/[,;\s]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        onChange();
      },
    }),
  ];

  const valueCell = hit
    ? h(
        "span",
        { class: "field__value" },
        h(
          "span",
          { class: "field__text" },
          kind === "password" ? mask(hit.value, false) : hit.value,
        ),
        h("span", { class: "tag tag--mono" }, `键 ${hit.key}`),
        hit.line ? h("span", { class: "subtle" }, `第 ${hit.line} 行`) : null,
      )
    : h(
        "span",
        { class: "field__value" },
        h("span", { class: "tag tag--warn" }, "未找到"),
        h("span", { class: "form__hint" }, "请填写该字段在文件中的关键词"),
      );

  return h(
    "div",
    { class: "field" },
    h(
      "div",
      { class: "detail__section-head" },
      h(
        "span",
        { class: "field__label" },
        FIELD_LABELS[kind],
        hit ? h("span", { class: "tag tag--success" }, "已识别") : null,
      ),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(async () => {
            await onRedetect();
          }),
        },
        icon("refresh", { size: 12 }),
        "重新检测",
      ),
    ),
    valueCell,
    keyInput,
  );
}

/**
 * Flow for attaching files: analyse first, show what was found, and let the user
 * correct the key words before anything is stored.
 */
export function openLinkDialog({ entryId, paths, onSaved }) {
  const items = paths.map((path) => ({ path, inspection: null }));
  const container = h("div", { class: "stack" });

  function paint() {
    const total = items.length;
    const ready = items.filter(
      (item) => item.inspection && item.inspection.parse.missing.length === 0,
    ).length;
    const failed = items.filter((item) => item.inspection?.parse?.error).length;

    mount(
      container,
      h(
        "div",
        { class: `banner${ready < total ? " banner--warn" : ""}` },
        h("span", { class: "banner__icon" }, icon(ready < total ? "alert" : "checkCircle", { size: 16 })),
        h(
          "div",
          { class: "banner__body" },
          h("span", { class: "banner__title" }, `${total} 个文件，其中 ${ready} 个已识别全部字段`),
          h(
            "span",
            null,
            "支持 JSON、.env、TOML、YAML、XML 与纯文本。缺少字段时，修改对应关键词并重新检测即可。",
          ),
          failed ? h("span", { class: "form__hint" }, `${failed} 个文件无法读取`) : null,
        ),
      ),
      items.map((item) =>
        item.inspection
          ? h(
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
                    h("span", { class: "tag tag--accent" }, formatLabel(item.inspection.format)),
                    item.inspection.label,
                  ),
                  h(
                    "p",
                    { class: "card__hint", title: item.inspection.path },
                    item.inspection.path,
                  ),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  item.inspection.exists
                    ? h("span", { class: "tag tag--mono" }, formatBytes(item.inspection.size))
                    : h("span", { class: "tag tag--danger" }, "文件不存在"),
                ),
              ),
              item.inspection.parse.error
                ? h("div", { class: "banner banner--danger" }, item.inspection.parse.error)
                : null,
              h(
                "div",
                { class: "stack stack--tight" },
                FIELD_ORDER.map((kind) =>
                  fieldRow(
                    kind,
                    item.inspection,
                    () => {
                      /* edited in place */
                    },
                    async () => {
                      const [updated] = await api.linkInspect([item.path], item.inspection.keys);
                      item.inspection = updated;
                      paint();
                    },
                  ),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: "8px" } },
                  h(
                    "button",
                    {
                      class: "btn btn--sm btn--ghost",
                      type: "button",
                      onClick: guard(async () => {
                        item.inspection.keys = await api.keyMappingDefault();
                        const [updated] = await api.linkInspect([item.path], item.inspection.keys);
                        item.inspection = updated;
                        paint();
                      }),
                    },
                    icon("refresh", { size: 12 }),
                    "恢复默认关键词",
                  ),
                  h(
                    "button",
                    {
                      class: "btn btn--sm btn--ghost",
                      type: "button",
                      onClick: () => {
                        const source = items.find((other) => other.inspection)?.inspection;
                        if (!source) return;
                        item.inspection.keys = { ...source.keys };
                        paint();
                      },
                    },
                    "套用其它文件的关键词",
                  ),
                ),
              ),
            )
          : h(
              "article",
              { class: "card" },
              h(
                "div",
                { class: "card__head" },
                h("h3", { class: "card__title" }, item.path),
                h("span", { class: "boot__spinner" }),
              ),
            ),
      ),
    );
  }

  paint();

  const load = guard(async () => {
    const inspections = await api.linkInspect(paths, state.settings?.keyMapping ?? null);
    items.forEach((item, index) => {
      item.inspection = inspections[index] ?? null;
    });
    paint();
  });
  load();

  openModal({
    title: "关联内容文件",
    size: "wide",
    render: () => container,
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "8px", width: "100%", alignItems: "center" } },
        h(
          "span",
          { class: "form__hint" },
          "关联后可以在详情面板继续调整关键词，或随时重新检测。",
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
                .map((item) => ({ path: item.inspection.path, keys: item.inspection.keys }));
              if (!drafts.length) {
                toast("没有可关联的文件", "error");
                return;
              }
              const entry = await api.linkAdd(entryId, drafts);
              await refreshVault();
              await selectEntry(entry.id);
              close();
              toast(`已关联 ${drafts.length} 个文件`, "success");
              onSaved?.(entry);
            }),
          },
          icon("link", { size: 14 }),
          "关联到该账号",
        ),
      ),
  });
}

/** Inline editor for one already-attached file. */
export function openKeyEditor({ entry, link, onSaved }) {
  const inspection = {
    path: link.path,
    label: link.label,
    format: link.parse?.format ?? "text",
    exists: link.exists,
    size: link.size,
    keys: { ...link.keys },
    parse: link.parse ?? {
      format: "text",
      fields: [],
      missing: [...FIELD_ORDER],
      analyzedAt: "",
      error: null,
    },
  };
  const container = h("div", { class: "stack" });

  function paint() {
    mount(
      container,
      h(
        "div",
        { class: "stack stack--tight" },
        h(
          "div",
          { class: "token-list" },
          h("span", { class: "tag tag--accent" }, formatLabel(inspection.format)),
          h("span", { class: "tag tag--mono" }, inspection.path),
          inspection.exists ? h("span", { class: "tag tag--mono" }, formatBytes(inspection.size)) : null,
        ),
        inspection.parse.error
          ? h("div", { class: "banner banner--danger" }, inspection.parse.error)
          : null,
        FIELD_ORDER.map((kind) =>
          fieldRow(kind, inspection, () => {}, async () => {
            const [updated] = await api.linkInspect([inspection.path], inspection.keys);
            inspection.parse = updated.parse;
            inspection.format = updated.format;
            paint();
          }),
        ),
      ),
    );
  }

  paint();

  openModal({
    title: `关键词：${link.label}`,
    size: "wide",
    render: () => container,
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "8px", width: "100%", justifyContent: "flex-end" } },
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: guard(async () => {
              const updated = await api.linkUpdateKeys(entry.id, link.id, inspection.keys);
              await refreshVault();
              await selectEntry(entry.id);
              close();
              toast("已保存并重新检测", "success");
              onSaved?.(updated);
            }),
          },
          "保存并重新检测",
        ),
      ),
  });
}
