import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, selectSyncTarget, refreshVault } from "../state.js";
import { confirmModal } from "../modal.js";
import { toast } from "../toast.js";
import { formatTime } from "../format.js";

const TOKENS = [
  "generatedAt",
  "knoxId",
  "accountCount",
  "fileCount",
  "accountsJson",
  "filesJson",
  "systemId",
  "client",
  "language",
  "username",
  "password",
  "usernamePassword",
  "hosts",
  "title",
  "linkCount",
];

async function createTarget(format) {
  const target = await api.syncTargetDefault(format);
  const saved = await api.syncTargetSave(target);
  setState({ vault: saved });
  await selectSyncTarget(target.id);
  toast(`已创建「${target.name}」同步目标`, "success");
}

function targetList() {
  const targets = state.vault?.syncTargets ?? [];
  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "pane__toolbar" },
      h("span", { class: "section-title" }, icon("refresh", { size: 13 }), "同步目标"),
      h("div", { class: "modal__footer-spacer" }),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          title: "全部写入",
          onClick: guard(async () => {
            const outcomes = await api.syncRunAll();
            await refreshVault();
            toast(
              outcomes.length
                ? `已同步 ${outcomes.length} 个目标`
                : "没有可写入的同步目标（请先设置路径）",
              outcomes.length ? "success" : "info",
            );
          }),
        },
        icon("save", { size: 13 }),
        "全部写入",
      ),
    ),
    h(
      "div",
      { class: "pane__scroll pane__scroll--tight" },
      h(
        "div",
        { class: "list" },
        targets.map((target) =>
          h(
            "div",
            {
              class: `row${state.syncSelectedId === target.id ? " is-selected" : ""}`,
              role: "button",
              tabindex: "0",
              onClick: guard(() => selectSyncTarget(target.id)),
            },
            h(
              "span",
              { class: "row__badge" },
              target.kind === "mcp" ? "MCP" : "CFG",
            ),
            h(
              "span",
              { class: "row__body" },
              h(
                "span",
                { class: "row__title" },
                target.name,
                target.enabled ? null : h("span", { class: "tag" }, "已停用"),
              ),
              h(
                "span",
                { class: "row__meta" },
                h("span", { class: "nowrap" }, target.path || "未设置路径"),
              ),
              h(
                "span",
                { class: "row__meta" },
                h(
                  "span",
                  { class: "subtle" },
                  target.lastSyncAt ? `上次同步 ${formatTime(target.lastSyncAt)}` : "尚未同步",
                ),
              ),
            ),
          ),
        ),
        targets.length
          ? null
          : h(
              "p",
              { class: "form__hint", style: { padding: "8px 12px" } },
              "还没有同步目标。下面选择一种格式即可创建，例如把 SAP 账号写入 MCP 配置。",
            ),
      ),
      h(
        "div",
        { class: "stack stack--tight", style: { padding: "12px 4px 0" } },
        h("span", { class: "section-title" }, "新建目标"),
        h(
          "div",
          { class: "token-list" },
          (state.presets ?? []).map((preset) =>
            h(
              "button",
              {
                class: "token",
                type: "button",
                title: preset.description,
                onClick: guard(() => createTarget(preset.format)),
              },
              `+ ${preset.label}`,
            ),
          ),
        ),
      ),
    ),
  );
}

function editorPane() {
  const target = state.syncDraft;
  if (!target) {
    return h(
      "div",
      { class: "pane" },
      h(
        "div",
        { class: "pane__scroll" },
        h(
          "div",
          { class: "empty" },
          h("div", { class: "empty__icon" }, icon("refresh", { size: 20 })),
          h("h3", { class: "empty__title" }, "选择或新建一个同步目标"),
          h(
            "p",
            { class: "empty__text" },
            "同步会把 SAP 分类下的账号（含 Knox ID、系统 ID、客户端、用户名密码）以及关联文件清单，按模板写入到你指定的文件，例如 MCP 的配置文件。",
          ),
        ),
      ),
    );
  }

  const patch = (values) => setState({ syncDraft: { ...state.syncDraft, ...values } });

  const templateArea = h("textarea", {
    id: "sync-template",
    class: "textarea textarea--mono textarea--code",
    spellcheck: "false",
    value: target.template,
    onInput: (event) => patch({ template: event.target.value }),
  });

  const insertToken = (token) => {
    const start = templateArea.selectionStart ?? templateArea.value.length;
    const end = templateArea.selectionEnd ?? start;
    const snippet = `{{${token}}}`;
    templateArea.value =
      templateArea.value.slice(0, start) + snippet + templateArea.value.slice(end);
    const caret = start + snippet.length;
    templateArea.focus();
    templateArea.setSelectionRange(caret, caret);
    patch({ template: templateArea.value });
  };

  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "pane__toolbar" },
      h("span", { class: "section-title" }, icon("save", { size: 13 }), target.name),
      h("div", { class: "modal__footer-spacer" }),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(async () => {
            const saved = await api.syncTargetSave(state.syncDraft);
            setState({ vault: saved });
            toast("同步目标已保存", "success");
          }),
        },
        icon("check", { size: 13 }),
        "保存",
      ),
      h(
        "button",
        {
          class: "btn btn--soft btn--sm",
          type: "button",
          onClick: guard(async () => {
            const preview = await api.syncPreviewTemplate(state.syncDraft);
            setState({ syncPreview: preview });
          }),
        },
        icon("eye", { size: 13 }),
        "预览",
      ),
      h(
        "button",
        {
          class: "btn btn--primary btn--sm",
          type: "button",
          onClick: guard(async () => {
            await api.syncTargetSave(state.syncDraft);
            const outcome = await api.syncRun(state.syncDraft.id);
            await refreshVault();
            toast(
              outcome.changed
                ? `已写入 ${outcome.path}`
                : "内容没有变化，未重写文件",
              "success",
            );
          }),
        },
        icon("download", { size: 13 }),
        "写入文件",
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "删除目标",
          onClick: () => {
            confirmModal({
              title: "删除同步目标",
              message: `确定删除「${state.syncDraft.name}」吗？`,
              detail: "已经写入的内容不会被删除。",
              confirmLabel: "删除",
              danger: true,
              onConfirm: guard(async () => {
                const vault = await api.syncTargetDelete(state.syncDraft.id);
                setState({ vault, syncDraft: null, syncSelectedId: null, syncPreview: null });
              }),
            });
          },
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
          { class: "form__grid" },
          h(
            "div",
            { class: "form__row" },
            h("label", { class: "form__label" }, "名称"),
            h("input", {
              class: "input",
              value: target.name,
              onInput: (event) => patch({ name: event.target.value }),
            }),
          ),
          h(
            "div",
            { class: "form__row" },
            h("label", { class: "form__label" }, "类型"),
            h(
              "select",
              { class: "select", onChange: (event) => patch({ kind: event.target.value }) },
              h("option", { value: "mcp", selected: target.kind === "mcp" }, "MCP 配置"),
              h("option", { value: "custom", selected: target.kind !== "mcp" }, "自定义文件"),
            ),
          ),
        ),
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "输出文件"),
          h(
            "div",
            { class: "input-group" },
            h("input", {
              class: "input input--mono",
              value: target.path,
              placeholder: "例如 %APPDATA%\\Claude\\claude_desktop_config.json",
              onInput: (event) => patch({ path: event.target.value }),
            }),
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onClick: guard(async () => {
                  const picked = await api.pickSaveFile(
                    target.kind === "mcp" ? "mcp.json" : "sapvault-output.txt",
                    null,
                  );
                  if (picked) patch({ path: picked });
                }),
              },
              icon("folder", { size: 14 }),
              "浏览",
            ),
          ),
        ),
        h(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: "16px" } },
          h(
            "label",
            { class: "checkbox" },
            h("input", {
              type: "checkbox",
              checked: target.enabled,
              onChange: (event) => patch({ enabled: event.target.checked }),
            }),
            h("span", null, "参与“全部写入”"),
          ),
          h(
            "label",
            { class: "checkbox" },
            h("input", {
              type: "checkbox",
              checked: target.backup,
              onChange: (event) => patch({ backup: event.target.checked }),
            }),
            h("span", null, "写入前备份原文件"),
          ),
        ),
        h(
          "div",
          { class: "form__row" },
          h(
            "div",
            { class: "detail__section-head" },
            h("label", { class: "form__label" }, "模板"),
            h(
              "select",
              {
                class: "select",
                style: { width: "220px" },
                onChange: (event) => {
                  const preset = (state.presets ?? []).find(
                    (item) => item.format === event.target.value,
                  );
                  if (preset) patch({ format: preset.format, template: preset.template });
                },
              },
              (state.presets ?? []).map((preset) =>
                h(
                  "option",
                  { value: preset.format, selected: preset.format === target.format },
                  `套用：${preset.label}`,
                ),
              ),
            ),
          ),
          templateArea,
          h(
            "div",
            { class: "form__row" },
            h("label", { class: "form__label" }, "点击插入变量"),
            h(
              "div",
              { class: "token-list" },
              TOKENS.map((token) =>
                h(
                  "button",
                  { class: "token", type: "button", onClick: () => insertToken(token) },
                  `{{${token}}}`,
                ),
              ),
            ),
            h(
              "p",
              { class: "form__hint" },
              "区块语法：{{#accounts}}…{{/accounts}} 逐个账号渲染；{{^accounts}}…{{/accounts}} 在账号为空时渲染；过滤器：{{knoxId|json}} 生成带引号的 JSON 字符串。",
            ),
          ),
        ),
        state.syncPreview
          ? h(
              "div",
              { class: "form__row" },
              h(
                "div",
                { class: "detail__section-head" },
                h("label", { class: "form__label" }, "预览"),
                h(
                  "span",
                  { class: "form__hint" },
                  `${state.syncPreview.bytes} 字节 · ${state.syncPreview.accountCount} 个账号 · ${state.syncPreview.fileCount} 个关联文件`,
                ),
              ),
              h("pre", { class: "preview" }, state.syncPreview.content),
            )
          : null,
      ),
    ),
  );
}

/** Sync view: targets on the left, template editor and preview on the right. */
export function renderSync(container) {
  if (!state.vault) return;
  mount(container, h("div", { class: "sync-layout" }, targetList(), editorPane()));
}
