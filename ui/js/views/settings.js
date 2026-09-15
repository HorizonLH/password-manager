import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, saveSettings, loadLandscape } from "../state.js";
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

function checkbox(label, checked, onChange, hint) {
  return h(
    "div",
    { class: "form__row" },
    h(
      "label",
      { class: "checkbox" },
      h("input", {
        type: "checkbox",
        checked,
        onChange: (event) => onChange(event.target.checked),
      }),
      h("span", null, label),
    ),
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
    "安全、锁定与剪贴板",
    "shield",
    "锁屏或重启后都需要重新解锁；解锁前所有密码都不会出现在内存里。",
    h(
      "div",
      { class: "form__grid" },
      numberField("剪贴板自动清空（秒，0 = 关闭）", settings.clipboardClearSeconds, {
        min: 0,
        max: 600,
        step: 5,
        onChange: guard((value) => saveSettings({ clipboardClearSeconds: value })),
      }),
      numberField("空闲自动锁定（分钟，0 = 关闭）", settings.autoLockMinutes, {
        min: 0,
        max: 240,
        step: 1,
        onChange: guard((value) => saveSettings({ autoLockMinutes: value })),
      }),
    ),
    checkbox(
      "系统锁屏（Win+L）时立即锁定保险库",
      settings.lockOnSessionLock,
      guard((value) => saveSettings({ lockOnSessionLock: value })),
      "锁屏后每 5 秒检测一次，回到桌面时必须重新解锁。",
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
      { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
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
      h("label", { class: "form__label" }, "主密码"),
      h(
        "p",
        { class: "form__hint" },
        state.mode === "windows"
          ? "当前使用 Windows 账户密钥（DPAPI），解锁时不需要输入密码。若希望「锁屏/重启后必须输入密码」，请设置主密码。"
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
      h("div", { class: "form" }, state.mode === "windows" ? null : current, next, confirm),
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
            await saveSettings({ landscapePaths: paths.filter((item) => item !== path) });
          }),
        },
        icon("x", { size: 12 }),
      ),
    ),
  );

  return card(
    "SAP 与 Knox ID",
    "server",
    "系统 ID 会在登录配置中解析出系统名称与主机名，用于展示与同步输出。",
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "全局 Knox ID"),
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
      h(
        "p",
        { class: "form__hint" },
        "条目里勾选「使用全局 Knox ID」后，该条目就以这个值作为用户名，复制与同步时同样生效。",
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
              await saveSettings({ landscapePaths: await api.sapDefaultPaths() });
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

/** Default password policy offered when creating a new entry. */
function ruleCard() {
  const rule = state.settings.defaultRule;
  const container = h("div", { class: "stack stack--tight" });

  function patch(values) {
    const next = { ...(state.settings.defaultRule ?? defaultRule()), ...values };
    saveSettings({ defaultRule: next }).then(paint).catch(() => {});
  }

  const numberInput = (value, key, min, max) =>
    h("input", {
      class: "input input--mono",
      type: "number",
      min: String(min),
      max: String(max),
      value: String(value),
      onChange: (event) => patch({ [key]: Number(event.target.value) }),
    });

  const toggle = (key, label) =>
    h(
      "label",
      { class: "checkbox" },
      h("input", {
        type: "checkbox",
        checked: Boolean(state.settings.defaultRule?.[key]),
        onChange: (event) => patch({ [key]: event.target.checked }),
      }),
      h("span", null, label),
    );

  function paint() {
    const current = state.settings.defaultRule;
    mount(
      container,
      h(
        "div",
        { class: "card__head" },
        h(
          "p",
          { class: "card__hint" },
          current
            ? "新建条目时会默认带上这条规则，仍可在条目里单独修改或取消。"
            : "当前没有默认规则；新建条目时也不会有规则。",
        ),
        h(
          "label",
          { class: "checkbox" },
          h("input", {
            type: "checkbox",
            checked: Boolean(current),
            onChange: guard(async (event) => {
              await saveSettings({ defaultRule: event.target.checked ? defaultRule() : null });
              paint();
            }),
          }),
          h("span", null, "启用默认规则"),
        ),
      ),
      current
        ? h(
            "div",
            { class: "stack stack--tight" },
            h(
              "div",
              { class: "form__grid" },
              h(
                "div",
                { class: "form__row" },
                h("label", { class: "form__label" }, "规则名称 / 备注"),
                h("input", {
                  class: "input",
                  value: current.description,
                  placeholder: "例如：集团口令策略 2024",
                  onChange: (event) => patch({ description: event.target.value }),
                }),
              ),
              h(
                "div",
                { class: "form__row" },
                h("label", { class: "form__label" }, "最小长度"),
                numberInput(current.minLength, "minLength", 4, 128),
              ),
              h(
                "div",
                { class: "form__row" },
                h("label", { class: "form__label" }, "最大长度"),
                numberInput(current.maxLength, "maxLength", 4, 128),
              ),
            ),
            h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: "12px" } },
              toggle("lower", "小写"),
              toggle("upper", "大写"),
              toggle("digits", "数字"),
              toggle("symbols", "符号"),
              toggle("startWithLetter", "首字符为字母"),
              toggle("avoidAmbiguous", "排除易混淆字符"),
            ),
            h(
              "div",
              { class: "form__grid" },
              h(
                "div",
                { class: "form__row" },
                h("label", { class: "form__label" }, "可用符号"),
                h("input", {
                  class: "input input--mono",
                  value: current.symbolsSet,
                  onChange: (event) => patch({ symbolsSet: event.target.value }),
                }),
              ),
              h(
                "div",
                { class: "form__row" },
                h("label", { class: "form__label" }, "禁用字符"),
                h("input", {
                  class: "input input--mono",
                  value: current.forbidden,
                  onChange: (event) => patch({ forbidden: event.target.value }),
                }),
              ),
            ),
          )
        : null,
    );
  }

  paint();
  return card(
    "默认密码规则",
    "sliders",
    "规则可以校验密码并生成合规密码；不设置规则时任何密码都能保存。",
    container,
  );
}

/** Default key words used when a content file is attached. */
function keyMapCard() {
  const container = h("div", { class: "stack stack--tight" });

  function paint() {
    const mapping = state.settings.keyMapping;
    const row = (kind, label, hint) =>
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, label),
        h("input", {
          class: "input input--mono",
          value: (mapping[kind] ?? []).join(", "),
          onChange: guard(async (event) => {
            const next = {
              ...mapping,
              [kind]: event.target.value
                .split(/[,;\s]+/)
                .map((value) => value.trim())
                .filter(Boolean),
            };
            await saveSettings({ keyMapping: next });
          }),
        }),
        h("p", { class: "form__hint" }, hint),
      );

    mount(
      container,
      row("url", "URL 关键词", "例如 url、server、host、endpoint；文件中出现这些键名时会被当作 URL"),
      row("username", "用户名关键词", "例如 username、user、login、sap_user"),
      row("password", "密码关键词", "例如 password、passwd、pwd、secret"),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "16px" } },
        h(
          "label",
          { class: "checkbox" },
          h("input", {
            type: "checkbox",
            checked: mapping.exact,
            onChange: guard((event) =>
              saveSettings({ keyMapping: { ...mapping, exact: event.target.checked } }),
            ),
          }),
          h("span", null, "键名必须完全一致"),
        ),
        h(
          "label",
          { class: "checkbox" },
          h("input", {
            type: "checkbox",
            checked: mapping.ignoreCase,
            onChange: guard((event) =>
              saveSettings({ keyMapping: { ...mapping, ignoreCase: event.target.checked } }),
            ),
          }),
          h("span", null, "忽略大小写"),
        ),
      ),
      h(
        "button",
        {
          class: "btn btn--sm btn--ghost",
          type: "button",
          onClick: guard(async () => {
            await saveSettings({ keyMapping: await api.keyMappingDefault() });
            paint();
            toast("已恢复默认关键词", "success");
          }),
        },
        icon("refresh", { size: 13 }),
        "恢复默认关键词",
      ),
      h(
        "p",
        { class: "form__hint" },
        "这些是「添加文件」时的初始关键词；每个文件都可以单独覆盖。",
      ),
    );
  }

  paint();
  return card("文件关键词", "filter", "决定如何在关联文件中识别 URL、用户名与密码。", container);
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
    state.portable
      ? "便携模式：所有数据都保存在程序目录下的 SapVaultData 文件夹中。"
      : "全部数据只保存在本机用户目录。备份文件同样是加密的。",
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
              detail: "选择之前导出的 .sapvault 文件；如果它是主密码模式，导入后需要重新解锁。",
              confirmLabel: "选择文件",
              onConfirm: guard(async () => {
                const files = await api.pickFiles();
                if (!files.length) return;
                let password = null;
                try {
                  await api.vaultImport(files[0], null);
                } catch {
                  password = window.prompt("该保险库需要主密码，请输入：");
                  if (password === null) return;
                  await api.vaultImport(files[0], password);
                }
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
      `SapVault v${state.version}${state.portable ? " · 便携模式" : ""}：完全本地运行，无网络请求、无遥测。` +
        "保险库使用 AES-256-GCM 加密；主密码模式使用 Argon2id 派生密钥，本机账户模式使用 Windows DPAPI 封装随机密钥。",
    ),
    h(
      "div",
      { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
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

function defaultRule() {
  return {
    enabled: true,
    description: "",
    minLength: 8,
    maxLength: 40,
    lower: true,
    upper: true,
    digits: true,
    symbols: false,
    symbolsSet: "!@#$%^&*()-_=+[]{};:,.?",
    forbidden: "",
    startWithLetter: false,
    avoidAmbiguous: false,
  };
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
      ruleCard(),
      keyMapCard(),
      dataCard(),
      aboutCard(),
    ),
  );
}
