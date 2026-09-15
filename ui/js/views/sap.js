import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { state, setState, loadLandscape } from "../state.js";
import { openEntryEditor } from "./editor.js";

function systemRow(system, duplicates) {
  const dup = duplicates.get(system.systemId);
  return h(
    "div",
    { class: "table__row", style: { "--table-cols": "110px 1.4fr 90px 80px 1.6fr 90px" } },
    h(
      "span",
      { class: "table__cell" },
      h("span", { class: "tag tag--accent tag--mono" }, system.systemId || "—"),
    ),
    h(
      "span",
      { class: "table__cell" },
      h("div", { class: "nowrap" }, system.name || system.description || "（未命名）"),
      system.workspace
        ? h("div", { class: "subtle nowrap", style: { fontSize: "11.5px" } }, system.workspace)
        : null,
    ),
    h(
      "span",
      { class: "table__cell" },
      h(
        "span",
        { class: `tag${system.serviceType === "SAPGUI" ? " tag--success" : ""}` },
        system.serviceType || "—",
      ),
    ),
    h("span", { class: "table__cell table__cell--mono" }, system.client || "—"),
    h(
      "span",
      { class: "table__cell" },
      system.hosts?.length
        ? h(
            "div",
            { class: "token-list" },
            system.hosts.slice(0, 3).map((host) => h("span", { class: "token" }, host)),
            system.hosts.length > 3
              ? h("span", { class: "token" }, `+${system.hosts.length - 3}`)
              : null,
          )
        : h("span", { class: "subtle" }, "未解析到主机"),
    ),
    h(
      "span",
      { class: "table__cell", style: { display: "flex", gap: "6px", alignItems: "center" } },
      dup ? h("span", { class: "tag tag--warn", title: "同一系统 ID 出现多次" }, `×${dup.count}`) : null,
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: () =>
            openEntryEditor({
              defaultCategory: "sap",
              entry: {
                id: null,
                title: system.name || system.systemId,
                categoryId: "sap",
                username: "",
                useKnoxId: false,
                url: system.url || "",
                notes: "",
                favorite: false,
                sap: {
                  systemId: system.systemId,
                  client: system.client,
                  language: system.language,
                  systemName: system.name,
                  hosts: [...(system.domains ?? []), ...(system.hosts ?? [])],
                  landscapeSource: system.sourceFile,
                },
              },
            }),
        },
        icon("plus", { size: 13 }),
        "建账号",
      ),
    ),
  );
}

/** SAP logon list browser. This is the bridge between the landscape file and the
 *  accounts: it is where a system id becomes a credential with hosts attached. */
export function renderSap(container) {
  const report = state.landscape;
  const term = state.sapFilter.trim().toLowerCase();

  const header = h(
    "div",
    { class: "pane__toolbar" },
    h(
      "div",
      { class: "search" },
      h("span", { class: "search__icon" }, icon("search", { size: 14 })),
      h("input", {
        id: "sap-filter",
        class: "search__input",
        placeholder: "按系统 ID、名称或主机名筛选",
        value: state.sapFilter,
        onInput: (event) => setState({ sapFilter: event.target.value }),
      }),
    ),
    h(
      "button",
      {
        class: "btn btn--ghost btn--sm",
        type: "button",
        onClick: guard(() => loadLandscape(true)),
      },
      icon("refresh", { size: 13 }),
      "重新解析",
    ),
  );

  if (!report) {
    mount(
      container,
      header,
      h(
        "div",
        { class: "pane__scroll" },
        state.landscapeLoading
          ? h("div", { class: "empty" }, h("div", { class: "boot__spinner" }), h("p", null, "正在解析登录配置…"))
          : h(
              "div",
              { class: "empty" },
              h("div", { class: "empty__icon" }, icon("server", { size: 20 })),
              h("h3", { class: "empty__title" }, "尚未读取 SAP 登录配置"),
              h(
                "p",
                { class: "empty__text" },
                "点击右上角“重新解析”，SapVault 会读取 SAP GUI 的 SAPUILandscape.xml（含全局文件）并列出所有系统。",
              ),
              h(
                "button",
                {
                  class: "btn btn--primary",
                  type: "button",
                  onClick: guard(() => loadLandscape(true)),
                },
                icon("refresh", { size: 14 }),
                "开始解析",
              ),
            ),
      ),
    );
    return;
  }

  const duplicates = new Map(
    (report.duplicates ?? []).map((item) => [item.systemId, item]),
  );
  const systems = report.systems.filter((system) => {
    if (!term) return true;
    return [system.systemId, system.name, system.description, ...(system.hosts ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  const summary = h(
    "div",
    { class: "stack stack--tight", style: { padding: "0 0 4px" } },
    h(
      "div",
      { class: "token-list" },
      h("span", { class: "tag tag--mono" }, `${report.systems.length} 个系统连接`),
      h("span", { class: "tag tag--mono" }, `${report.files.length} 个配置文件`),
      duplicates.size
        ? h(
            "span",
            { class: "tag tag--warn" },
            `${duplicates.size} 个系统 ID 重复出现`,
          )
        : null,
    ),
    report.files.length
      ? h(
          "p",
          { class: "form__hint" },
          `已解析：${report.files.join("   ·   ")}`,
        )
      : null,
    report.warnings.length
      ? h(
          "div",
          { class: "banner banner--warn" },
          h("span", { class: "banner__icon" }, icon("alert", { size: 16 })),
          h(
            "div",
            { class: "banner__body" },
            h("span", { class: "banner__title" }, "解析提示"),
            ...report.warnings.map((warning) => h("span", null, warning)),
          ),
        )
      : null,
    duplicates.size
      ? h(
          "p",
          { class: "form__hint" },
          "系统 ID 在 SAPUILandscape.xml 中并不唯一（同一系统的生产/沙箱/负载均衡入口会共用 ID）。SapVault 会把所有同 ID 连接的主机名合并后再做扫描匹配。",
        )
      : null,
  );

  const table = h(
    "div",
    { class: "table" },
    h(
      "div",
      {
        class: "table__row table__head",
        style: { "--table-cols": "110px 1.4fr 90px 80px 1.6fr 90px" },
      },
      h("span", { class: "table__cell" }, "系统 ID"),
      h("span", { class: "table__cell" }, "名称 / 工作区"),
      h("span", { class: "table__cell" }, "类型"),
      h("span", { class: "table__cell" }, "客户端"),
      h("span", { class: "table__cell" }, "主机 / 域名"),
      h("span", { class: "table__cell" }, "操作"),
    ),
    systems.map((system) => systemRow(system, duplicates)),
  );

  mount(
    container,
    header,
    h(
      "div",
      { class: "pane__scroll" },
      h(
        "div",
        { class: "stack" },
        summary,
        systems.length
          ? table
          : h(
              "div",
              { class: "empty" },
              h("div", { class: "empty__icon" }, icon("filter", { size: 18 })),
              h("h3", { class: "empty__title" }, "没有匹配的系统"),
            ),
      ),
    ),
  );
}
