import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, saveSettings, loadLandscape, buildScanDefaults } from "../state.js";
import { confirmModal, openModal } from "../modal.js";
import { toast } from "../toast.js";

function card(title, iconName, hint, ...children) {
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__head" },
      h(
        "div",
        null,
        h("h2", { class: "card__title" }, icon(iconName, { size: 16 }), title),
        hint ? h("p", { class: "card__hint" }, hint) : null,
      ),
    ),
    ...children,
  );
}

function numberField(label, value, { min, max, step, hint, onChange }) {
  return h(
    "div",
    { class: "form__row" },
    h("label", { class: "form__label" }, label),
    h("input", {
      class: "input input--mono",
      type: "number",
      value: String(value),
      min: min === undefined ? null : String(min),
      max: max === undefined ? null : String(max),
      step: step === undefined ? null : String(step),
      onChange: (event) => onChange(Number(event.target.value)),
    }),
    hint ? h("p", { class: "form__hint" }, hint) : null,
  );
}

function appearanceCard() {
  const theme = state.settings.theme;
  const option = (value, label, iconName) =>
    h(
      "button",
      {
        class: `segmented__item${theme === value ? " is-active" : ""}`,
        type: "button",
        onClick: guard(() => saveSettings({ theme: value })),
      },
      icon(iconName, { size: 14 }),
      label,
    );

  return card(
    "外观",
    "sun",
    "跟随系统会随 Windows 的浅色 / 深色设置自动切换。",
    h(
      "div",
      { class: "segmented" },
      option("system", "跟随系统", "monitor"),
      option("light", "亮色", "sun"),
      option("dark", "暗色", "moon"),
    ),
  );
}

function securityCard() {
  const settings = state.settings;
  return card(
    "安全与剪贴板",
    "shield",
    "复制后的内容会在指定时间后自动清空，避免残留在剪贴板历史里。",
    h(
      "div",
      { class: "form__grid" },
      numberField(
        "剪贴板自动清空（秒，0 = 关闭）",
        settings.clipboardClearSeconds,
        {
          min: 0,
          max: 600,
          step: 5,
          onChange: guard((value) => saveSettings({ clipboardClearSeconds: value })),
        },
      ),
      numberField("空闲自动锁定（分钟，0 = 关闭）", settings.autoLockMinutes, {
        min: 0,
        max: 240,
        step: 1,
        onChange: guard((value) => saveSettings({ autoLockMinutes: value })),
      }),
    ),
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "16px" } },
      h(
        "label",
        { class: "checkbox" },
        h("input", {
          type: "checkbox",
          checked: settings.confirmDelete,
          onChange: guard((event) => saveSettings({ confirmDelete: event.target.checked })),
        }),
        h("span", null, "删除前二次确认"),
      ),
      h(
        "label",
        { class: "checkbox" },
        h("input", {
          type: "checkbox",
          checked: settings.maskPasswords,
          onChange: guard((event) => saveSettings({ maskPasswords: event.target.checked })),
        }),
        h("span", null, "默认以圆点显示密码"),
      ),
    ),
    h(
      "div",
      { style: { display: "flex", gap: "8px" } },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(async () => {
            await api.clipboardClear();
            toast("剪贴板已清空", "success");
          }),
        },
        icon("trash", { size: 14 }),
        "立即清空剪贴板",
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(async () => {
            await api.vaultLock();
          }),
        },
        icon("lock", { size: 14 }),
        "立即锁定",
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "修改主密码"),
      h(
        "p",
        { class: "form__hint" },
        state.mode === "windows"
          ? "当前保险库使用 Windows 账户密钥。设置主密码后会切换为 Argon2id 派生密钥。"
          : "修改后请牢记新密码，SapVault 无法找回。",
      ),
      h(
        "button",
        { class: "btn btn--sm", type: "button", onClick: () => changePasswordModal() },
        icon("key", { size: 13 }),
        state.mode === "windows" ? "设置主密码" : "修改主密码",
      ),
    ),
  );
}

function changePasswordModal() {
  const current = h("input", { class: "input", type: "password", placeholder: "当前主密码" });
  const next = h("input", { class: "input", type: "password", placeholder: "新主密码（至少 8 位）" });
  const confirm = h("input", { class: "input", type: "password", placeholder: "再次输入新密码" });
  openModal({
    title: state.mode === "windows" ? "设置主密码" : "修改主密码",
    size: "narrow",
    render: () =>
      h(
        "div",
        { class: "form" },
        state.mode === "windows" ? null : current,
        next,
        confirm,
      ),
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
              if (next.value !== confirm.value) {
                toast("两次输入的新密码不一致", "error");
                return;
              }
              await api.vaultChangePassword(
                state.mode === "windows" ? null : current.value,
                next.value,
              );
              await api.settingsSave(state.settings);
              close();
              setState({ mode: "password" });
              toast("主密码已更新", "success");
            }),
          },
          "保存",
        ),
      ),
  });
}

function sapCard() {
  const settings = state.settings;
  const paths = settings.landscapePaths?.length
    ? settings.landscapePaths
    : state.paths?.landscapeDefaults ?? [];

  const rows = paths.map((path) =>
    h(
      "div",
      { class: "path-row" },
      icon("file", { size: 13 }),
      h("span", { class: "path-row__text", title: path }, path),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "移除",
          onClick: guard(async () => {
            const next = paths.filter((item) => item !== path);
            await saveSettings({ landscapePaths: next });
          }),
        },
        icon("x", { size: 12 }),
      ),
    ),
  );

  return card(
    "SAP 与 Knox ID",
    "server",
    "系统 ID 会先在登录配置中查出域名或 IP，再用于扫描与同步。",
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "全局 Knox ID"),
      h(
        "div",
        { class: "input-group" },
        h("input", {
          id: "settings-knox",
          class: "input input--mono",
          value: state.vault?.knoxId ?? "",
          placeholder: "例如 K1234567",
          onChange: guard(async (event) => {
            const vault = await api.knoxSet(event.target.value);
            setState({ vault });
            toast("Knox ID 已更新", "success");
          }),
        }),
      ),
      h(
        "p",
        { class: "form__hint" },
        "维护条目时勾选“使用全局 Knox ID”，该条目就会以这个值作为用户名，同步与复制时同样生效。",
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "SAP 登录配置路径"),
      h("div", { class: "path-list" }, rows.length ? rows : h("p", { class: "form__hint" }, "将使用默认路径")),
      h(
        "div",
        { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        h(
          "button",
          {
            class: "btn btn--sm",
            type: "button",
            onClick: guard(async () => {
              const picked = await api.pickFiles();
              if (!picked.length) return;
              await saveSettings({ landscapePaths: [...paths, ...picked] });
            }),
          },
          icon("plus", { size: 13 }),
          "添加文件",
        ),
        h(
          "button",
          {
            class: "btn btn--sm btn--ghost",
            type: "button",
            onClick: guard(async () => {
              const defaults = await api.sapDefaultPaths();
              await saveSettings({ landscapePaths: defaults });
              toast("已恢复默认路径", "success");
            }),
          },
          "使用默认路径",
        ),
        h(
          "button",
          {
            class: "btn btn--sm btn--ghost",
            type: "button",
            onClick: guard(async () => {
              await loadLandscape(true);
              toast("登录配置已重新解析", "success");
            }),
          },
          icon("refresh", { size: 13 }),
          "重新解析",
        ),
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "SAP 用户名 + 密码的换行符"),
      h(
        "select",
        {
          class: "select",
          onChange: guard((event) => saveSettings({ sapLineSeparator: event.target.value })),
        },
        h("option", { value: "\r\n", selected: settings.sapLineSeparator === "\r\n" }, "CRLF（Windows，推荐）"),
        h("option", { value: "\n", selected: settings.sapLineSeparator === "\n" }, "LF"),
        h("option", { value: " ", selected: settings.sapLineSeparator === " " }, "空格"),
      ),
      h(
        "p",
        { class: "form__hint" },
        "SAP GUI 登录界面支持粘贴多行文本：第一行填入用户名字段，第二行自动填入密码字段。",
      ),
    ),
  );
}

function scanCard() {
  const settings = state.settings;
  const roots = settings.scanRoots ?? [];
  return card(
    "扫描默认值",
    "radar",
    "扫描范围越大耗时越长。默认只读取文本类文件，并跳过缓存与依赖目录。",
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "默认扫描目录"),
      h(
        "div",
        { class: "path-list" },
        roots.map((root) =>
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
                onClick: guard(async () =>
                  saveSettings({ scanRoots: roots.filter((item) => item !== root) }),
                ),
              },
              icon("x", { size: 12 }),
            ),
          ),
        ),
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
              const picked = await api.pickFolder("选择默认扫描目录");
              if (!picked) return;
              await saveSettings({ scanRoots: [...roots, picked] });
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
            onClick: guard(async () => {
              const defaults = buildScanDefaults(
                { ...settings, scanRoots: [] },
                state.paths?.scanRootDefault,
              );
              await saveSettings({ scanRoots: defaults.roots });
            }),
          },
          "恢复当前用户目录",
        ),
      ),
    ),
    h(
      "div",
      { class: "form__grid" },
      numberField("最大目录深度", settings.scanMaxDepth, {
        min: 1,
        max: 64,
        onChange: guard((value) => saveSettings({ scanMaxDepth: value })),
      }),
      numberField("最多检查文件数", settings.scanMaxFiles, {
        min: 100,
        step: 1000,
        onChange: guard((value) => saveSettings({ scanMaxFiles: value })),
      }),
      numberField(
        "单个文件上限 (MB)",
        Math.round(settings.scanMaxFileBytes / 1048576),
        {
          min: 1,
          max: 64,
          onChange: guard((value) => saveSettings({ scanMaxFileBytes: value * 1048576 })),
        },
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
          checked: settings.scanStrict,
          onChange: guard((event) => saveSettings({ scanStrict: event.target.checked })),
        }),
        h("span", null, "默认要求同时匹配 系统 ID + 用户名 + 主机名"),
      ),
    ),
  );
}

function dataCard() {
  const paths = [
    ["数据目录", state.paths?.dataDir],
    ["保险库文件", state.paths?.vaultPath],
    ["设置文件", state.paths?.dataDir ? `${state.paths.dataDir}\\settings.json` : ""],
    ["备份目录", state.paths?.dataDir ? `${state.paths.dataDir}\\backups` : ""],
  ];

  return card(
    "数据与备份",
    "drive",
    "全部数据只保存在本机。备份文件同样是加密的。",
    h(
      "div",
      { class: "path-list" },
      paths.map(([label, value]) =>
        h(
          "div",
          { class: "path-row" },
          h("span", { class: "subtle", style: { minWidth: "76px" } }, label),
          h("span", { class: "path-row__text", title: value ?? "" }, value || "—"),
          value
            ? h(
                "button",
                {
                  class: "btn btn--icon btn--sm",
                  type: "button",
                  title: "打开",
                  onClick: guard(() => api.openPath(value)),
                },
                icon("external", { size: 12 }),
              )
            : null,
        ),
      ),
    ),
    h(
      "div",
      { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(async () => {
            const backup = await api.vaultBackupNow();
            toast(backup ? `已备份到 ${backup}` : "没有可备份的保险库", "success");
          }),
        },
        icon("save", { size: 14 }),
        "立即备份",
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: guard(async () => {
            const target = await api.pickSaveFile("sapvault-backup.sapvault", "sapvault");
            if (!target) return;
            const written = await api.vaultExport(target);
            toast(`已导出到 ${written}`, "success");
          }),
        },
        icon("download", { size: 14 }),
        "导出保险库",
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onClick: () => {
            confirmModal({
              title: "导入保险库",
              message: "导入会替换当前保险库，并先自动备份现有文件。",
              detail: "选择之前导出的 .sapvault 文件。",
              confirmLabel: "选择文件",
              onConfirm: guard(async () => {
                const file = await api.pickFiles();
                if (!file.length) return;
                await api.vaultImport(file[0]);
                window.location.reload();
              }),
            });
          },
        },
        icon("upload", { size: 14 }),
        "导入保险库",
      ),
    ),
  );
}

function aboutCard() {
  return card(
    "关于",
    "info",
    null,
    h(
      "p",
      { class: "form__hint" },
      "SapVault 是一个完全本地化的密码管理工具：Tauri + Rust 后端，无远程请求，无遥测。加密使用 AES-256-GCM，主密码模式使用 Argon2id 派生密钥，仅本机账户模式使用 Windows DPAPI 封装随机密钥。",
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
            await api.openPath(state.paths?.dataDir);
          }),
        },
        icon("folder", { size: 13 }),
        "打开数据目录",
      ),
      h(
        "button",
        {
          class: "btn btn--sm btn--danger",
          type: "button",
          onClick: () => {
            confirmModal({
              title: "退出 SapVault",
              message: "确定要退出应用吗？",
              confirmLabel: "退出",
              danger: true,
              onConfirm: () => api.quit(),
            });
          },
        },
        icon("power", { size: 13 }),
        "退出应用",
      ),
    ),
  );
}

/** Settings view. Every control persists immediately on change. */
export function renderSettings(container) {
  if (!state.settings) return;
  mount(
    container,
    h(
      "div",
      { class: "settings-grid" },
      appearanceCard(),
      securityCard(),
      sapCard(),
      scanCard(),
      dataCard(),
      aboutCard(),
    ),
  );
}
