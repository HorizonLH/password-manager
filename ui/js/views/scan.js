import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  state,
  setState,
  runScan,
  cancelScan,
  attachScan,
  refreshVault,
} from "../state.js";
import { toast } from "../toast.js";
import { formatBytes, formatDuration } from "../format.js";

function sapEntries() {
  return (state.vault?.entries ?? []).filter((entry) => entry.categoryId === "sap");
}

/** Seeds the matcher from one SAP account: system id, user name and every host
 *  name the landscape resolved for that system id. */
function applyAccount(entryId) {
  const entry = sapEntries().find((item) => item.id === entryId);
  if (!entry) {
    setState({
      scanOptions: { ...state.scanOptions, label: "", systemIds: [], usernames: [], hosts: [] },
    });
    return;
  }
  setState({
    scanOptions: {
      ...state.scanOptions,
      label: entry.title,
      systemIds: entry.systemId ? [entry.systemId] : [],
      usernames: entry.username ? [entry.username] : [],
      hosts: entry.hosts ?? [],
      targetEntryId: entry.id,
    },
  });
}

function tokenEditor(label, key, placeholder) {
  const value = (state.scanOptions?.[key] ?? []).join(", ");
  return h(
    "div",
    { class: "form__row" },
    h("label", { class: "form__label" }, label),
    h("input", {
      class: "input input--mono",
      value,
      placeholder,
      onInput: (event) => {
        const list = event.target.value
          .split(/[,;\s]+/)
          .map((item) => item.trim())
          .filter(Boolean);
        setState({ scanOptions: { ...state.scanOptions, [key]: list } });
      },
    }),
    h(
      "p",
      { class: "form__hint" },
      value ? `当前 ${(state.scanOptions?.[key] ?? []).length} 项` : "留空表示不参与匹配",
    ),
  );
}

function optionForm() {
  const options = state.scanOptions;
  const entries = sapEntries();

  const accountSelect = h(
    "select",
    {
      class: "select",
      onChange: (event) => applyAccount(event.target.value),
    },
    h("option", { value: "" }, "（不指定，使用下方条件）"),
    entries.map((entry) =>
      h(
        "option",
        { value: entry.id, selected: options.targetEntryId === entry.id },
        `${entry.systemId || "无 SID"} · ${entry.title}`,
      ),
    ),
  );

  const roots = options.roots.map((root) =>
    h(
      "div",
      { class: "path-row" },
      icon("folder", { size: 13 }),
      h("span", { class: "path-row__text", title: root }, root),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "移除",
          onClick: () =>
            setState({
              scanOptions: {
                ...state.scanOptions,
                roots: state.scanOptions.roots.filter((item) => item !== root),
              },
            }),
        },
        icon("x", { size: 12 }),
      ),
    ),
  );

  return h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "按 SAP 账号填充条件"),
      accountSelect,
      h(
        "p",
        { class: "form__hint" },
        "选择账号后会自动填入系统 ID、用户名与登录配置解析出的全部主机名/域名。",
      ),
    ),
    tokenEditor("系统 ID", "systemIds", "例如 PRD, DEV"),
    tokenEditor("用户名", "usernames", "例如 JDOE"),
    tokenEditor("主机名 / 域名", "hosts", "例如 prd.sap.corp.example, corp.example"),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "扫描目录（当前用户目录）"),
      h(
        "div",
        { class: "path-list" },
        roots.length ? roots : h("p", { class: "form__hint" }, "尚未设置目录"),
      ),
      h(
        "div",
        { style: { display: "flex", gap: "8px" } },
        h(
          "button",
          {
            class: "btn btn--sm",
            type: "button",
            onClick: guard(async () => {
              const picked = await api.pickFolder("选择要扫描的目录");
              if (!picked) return;
              const next = [...state.scanOptions.roots];
              if (!next.includes(picked)) next.push(picked);
              setState({ scanOptions: { ...state.scanOptions, roots: next } });
            }),
          },
          icon("plus", { size: 13 }),
          "添加目录",
        ),
        h(
          "button",
          {
            class: "btn btn--sm btn--ghost",
            type: "button",
            onClick: () =>
              setState({
                scanOptions: {
                  ...state.scanOptions,
                  roots: [state.paths?.scanRootDefault ?? "C:\\"],
                },
              }),
          },
          "恢复默认",
        ),
      ),
    ),
    h(
      "label",
      { class: "checkbox" },
      h("input", {
        type: "checkbox",
        checked: state.scanOptions.strict,
        onChange: (event) =>
          setState({ scanOptions: { ...state.scanOptions, strict: event.target.checked } }),
      }),
      h("span", null, "必须同时匹配 系统 ID + 用户名 + 主机名"),
    ),
    h(
      "div",
      { class: "form__grid" },
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "最大目录深度"),
        h("input", {
          class: "input input--mono",
          type: "number",
          min: "1",
          max: "64",
          value: String(state.scanOptions.maxDepth),
          onChange: (event) =>
            setState({
              scanOptions: { ...state.scanOptions, maxDepth: Number(event.target.value) || 10 },
            }),
        }),
      ),
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "最多检查文件数"),
        h("input", {
          class: "input input--mono",
          type: "number",
          min: "100",
          step: "1000",
          value: String(state.scanOptions.maxFiles),
          onChange: (event) =>
            setState({
              scanOptions: { ...state.scanOptions, maxFiles: Number(event.target.value) || 30000 },
            }),
        }),
      ),
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "单个文件上限 (MB)"),
        h("input", {
          class: "input input--mono",
          type: "number",
          min: "1",
          max: "64",
          value: String(Math.round(state.scanOptions.maxFileBytes / 1048576)),
          onChange: (event) =>
            setState({
              scanOptions: {
                ...state.scanOptions,
                maxFileBytes: (Number(event.target.value) || 2) * 1048576,
              },
            }),
        }),
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "只扫描这些扩展名（可选）"),
      h("input", {
        class: "input input--mono",
        value: (state.scanOptions.onlyExtensions ?? []).join(", "),
        placeholder: "例如 json, xml, ini, env",
        onInput: (event) =>
          setState({
            scanOptions: {
              ...state.scanOptions,
              onlyExtensions: event.target.value
                .split(/[,;\s]+/)
                .map((item) => item.trim().replace(/^\./, ""))
                .filter(Boolean),
            },
          }),
      }),
      h(
        "p",
        { class: "form__hint" },
        "留空时会自动跳过已知的二进制与办公文档格式。",
      ),
    ),
    h(
      "div",
      { style: { display: "flex", gap: "8px" } },
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          disabled: state.scanRunning,
          onClick: guard(() => runScan()),
        },
        icon("radar", { size: 14 }),
        state.scanRunning ? "扫描中…" : "开始扫描",
      ),
      state.scanRunning
        ? h(
            "button",
            {
              class: "btn btn--danger",
              type: "button",
              onClick: guard(() => cancelScan()),
            },
            icon("stop", { size: 13 }),
            "停止",
          )
        : null,
    ),
  );
}

function resultRow(hit) {
  const picked = state.scanPicked.has(hit.path);
  return h(
    "div",
    { class: `scan-result${picked ? " is-picked" : ""}` },
    h(
      "div",
      { class: "scan-result__head" },
      h("input", {
        type: "checkbox",
        checked: picked,
        "aria-label": `选择 ${hit.path}`,
        onChange: (event) => {
          const next = new Set(state.scanPicked);
          if (event.target.checked) next.add(hit.path);
          else next.delete(hit.path);
          setState({ scanPicked: next });
        },
      }),
      h("span", { class: "scan-result__path" }, hit.path),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "在资源管理器中显示",
          onClick: guard(() => api.openInExplorer(hit.path)),
        },
        icon("external", { size: 13 }),
      ),
    ),
    h(
      "div",
      { class: "scan-result__meta" },
      h("span", { class: `tag${hit.score >= 3 ? " tag--success" : " tag--warn"}` }, `匹配 ${hit.score}/3`),
      h("span", { class: "tag tag--mono" }, formatBytes(hit.size)),
      ...hit.matchedSystemIds.map((sid) => h("span", { class: "tag tag--accent tag--mono" }, sid)),
      ...hit.matchedUsernames.map((name) => h("span", { class: "tag tag--mono" }, name)),
      ...hit.matchedHosts.slice(0, 2).map((host) => h("span", { class: "tag tag--mono" }, host)),
      hit.firstLine ? h("span", { class: "subtle" }, `第 ${hit.firstLine} 行`) : null,
    ),
    hit.excerpt ? h("pre", { class: "evidence__excerpt" }, hit.excerpt) : null,
  );
}

function resultPane() {
  const report = state.scanReport;
  const targetEntry = sapEntries().find((entry) => entry.id === state.scanOptions?.targetEntryId);
  const picked = report ? report.hits.filter((hit) => state.scanPicked.has(hit.path)) : [];

  const toolbar = h(
    "div",
    { class: "pane__toolbar" },
    h(
      "span",
      { class: "section-title" },
      icon("radar", { size: 13 }),
      report ? `命中 ${report.hits.length} 个文件` : "扫描结果",
    ),
    h("div", { class: "modal__footer-spacer" }),
    report && report.hits.length
      ? h(
          "button",
          {
            class: "btn btn--ghost btn--sm",
            type: "button",
            onClick: () => {
              const all = state.scanPicked.size === report.hits.length;
              setState({
                scanPicked: all ? new Set() : new Set(report.hits.map((hit) => hit.path)),
              });
            },
          },
          state.scanPicked.size === report.hits.length ? "取消全选" : "全选",
        )
      : null,
    picked.length
      ? h(
          "button",
          {
            class: "btn btn--primary btn--sm",
            type: "button",
            disabled: !targetEntry,
            onClick: guard(async () => {
              if (!targetEntry) {
                toast("请先在上方选择一个 SAP 账号作为关联目标", "error");
                return;
              }
              await attachScan(targetEntry.id, picked, false);
              await refreshVault();
            }),
          },
          icon("link", { size: 13 }),
          `关联到 ${targetEntry ? targetEntry.title : "（未选择账号）"}`,
        )
      : null,
  );

  if (!report) {
    return h(
      "div",
      { class: "pane" },
      toolbar,
      h(
        "div",
        { class: "pane__scroll" },
        state.scanRunning
          ? h(
              "div",
              { class: "stack", style: { padding: "16px 0" } },
              h(
                "div",
                { class: "progress" },
                h(
                  "div",
                  { class: "progress__track" },
                  h("div", { class: "progress__bar is-indeterminate" }),
                ),
                h(
                  "span",
                  { class: "form__hint" },
                  `已检查 ${state.scanProgress.scanned} 个文件`,
                ),
              ),
              h("div", { class: "scan-log" }, state.scanProgress.path || "正在准备…"),
            )
          : h(
              "div",
              { class: "empty" },
              h("div", { class: "empty__icon" }, icon("radar", { size: 20 })),
              h("h3", { class: "empty__title" }, "扫描当前用户目录中的配置与脚本"),
              h(
                "p",
                { class: "empty__text" },
                "规则：先按系统 ID 在 SAPUILandscape.xml 中查出域名或 IP，再在用户目录中查找同时出现主机名、系统 ID 与用户名的文件。",
              ),
            ),
      ),
    );
  }

  return h(
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
          h("span", { class: "tag tag--mono" }, `检查 ${report.scannedFiles} 个文件`),
          h("span", { class: "tag tag--mono" }, `跳过 ${report.skippedFiles} 个`),
          h("span", { class: "tag tag--mono" }, formatDuration(report.elapsedMs)),
          report.cancelled ? h("span", { class: "tag tag--warn" }, "已中止") : null,
          report.truncated ? h("span", { class: "tag tag--warn" }, "已达到文件数上限") : null,
        ),
        report.errors.length
          ? h(
              "div",
              { class: "banner banner--warn" },
              h("span", { class: "banner__icon" }, icon("alert", { size: 16 })),
              h(
                "div",
                { class: "banner__body" },
                h("span", { class: "banner__title" }, `${report.errors.length} 条读取错误`),
                ...report.errors.slice(0, 5).map((error) => h("span", null, error)),
              ),
            )
          : null,
        report.hits.length
          ? h(
              "div",
              { class: "stack stack--tight" },
              report.hits.map((hit) => resultRow(hit)),
            )
          : h(
              "div",
              { class: "empty" },
              h("div", { class: "empty__icon" }, icon("filter", { size: 18 })),
              h("h3", { class: "empty__title" }, "没有找到符合条件的文件"),
              h(
                "p",
                { class: "empty__text" },
                "可以放宽匹配条件（关闭严格匹配）、扩大扫描目录，或减少限制的文件扩展名。",
              ),
            ),
      ),
    ),
  );
}

/** File scanner view: matcher on the left, results on the right. */
export function renderScan(container) {
  if (!state.scanOptions) return;
  mount(
    container,
    h(
      "div",
      { class: "scan-layout" },
      h(
        "div",
        { class: "pane" },
        h(
          "div",
          { class: "pane__toolbar" },
          h("span", { class: "section-title" }, icon("sliders", { size: 13 }), "匹配条件"),
        ),
        h("div", { class: "pane__scroll" }, optionForm()),
      ),
      resultPane(),
    ),
  );
}
