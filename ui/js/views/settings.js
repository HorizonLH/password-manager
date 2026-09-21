import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, setState, saveSettings, refreshLandscape, refreshGuiStatus } from "../state.js";
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

function checkboxField(label, checked, onChange, hint) {
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
    "锁定与剪贴板",
    "shield",
    "锁屏或重启后都需要重新解锁；解锁前内存中没有明文密码。",
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
        onChange: guard((value) => saveSettings({ autoLockMinutes: value })),
      }),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "「复制用户名 + 密码」的换行符"),
      h(
        "div",
        { class: "segmented" },
        ...[
          ["\r\n", "CRLF"],
          ["\n", "LF"],
          [" ", "空格"],
        ].map(([value, label]) =>
          h(
            "button",
            {
              class: `segmented__item${settings.sapLineSeparator === value ? " is-active" : ""}`,
              type: "button",
              onClick: guard(() => saveSettings({ sapLineSeparator: value })),
            },
            label,
          ),
        ),
      ),
      h(
        "p",
        { class: "form__hint" },
        "SAP GUI 会把多行文本依次填进连续的输入框：选 CRLF 或 LF 时，粘贴后用户名进第一格、密码进第二格。",
      ),
    ),
    checkboxField(
      "系统锁屏（Win+L）时立即锁定",
      settings.lockOnSessionLock,
      guard((value) => saveSettings({ lockOnSessionLock: value })),
      "后端每 5 秒检测一次输入桌面，回到桌面后必须重新解锁。",
    ),
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "var(--s-4)" } },
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
      { style: { display: "flex", gap: "var(--s-2)", flexWrap: "wrap" } },
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: guard(async () => {
            await api.clipboardClear();
            toast("剪贴板已清空", "success");
          }),
        },
        icon("trash", { size: 13 }),
        "清空剪贴板",
      ),
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: guard(async () => {
            await api.vaultLock();
          }),
        },
        icon("lock", { size: 13 }),
        "立即锁定",
      ),
      h(
        "button",
        { class: "btn btn--sm", type: "button", onClick: () => changePasswordModal() },
        icon("key", { size: 13 }),
        state.mode === "windows" ? "设置主密码" : "修改主密码",
      ),
    ),
    h(
      "p",
      { class: "form__hint" },
      state.mode === "windows"
        ? "当前使用 Windows 账户密钥（DPAPI），解锁时不需要输入密码。若希望「锁屏 / 重启后必须输入密码」，请设置主密码。"
        : "主密码无法找回，请妥善保存。",
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
        { class: "stack stack--tight" },
        state.mode === "windows" ? null : current,
        next,
        confirm,
      ),
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

/** SAP GUI: the launcher, how the password travels, and where systems come from. */
function sapCard() {
  const container = h("div", { class: "stack stack--tight" });

  function paint() {
    const settings = state.settings;
    const mode = settings.sapPasswordMode ?? "clipboard";
    const gui = state.guiStatus;
    const landscape = state.landscape;
    const systems = landscape?.systems ?? [];
    const launchable = systems.filter(
      (system) =>
        system.systemId &&
        (system.kind === "applicationServer" || system.kind === "serverGroup"),
    );

    const modeOption = (value, label, iconName) =>
      h(
        "button",
        {
          class: `segmented__item${mode === value ? " is-active" : ""}`,
          type: "button",
          onClick: guard(async () => {
            await saveSettings({ sapPasswordMode: value });
            paint();
          }),
        },
        icon(iconName, { size: 14 }),
        label,
      );

    const pathInput = h("input", {
      id: "settings-sapshcut",
      class: "input input--mono",
      value: settings.sapshcutPath ?? "",
      placeholder:
        gui?.executable || "例如 C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPGUI\\sapshcut.exe",
      onChange: guard(async (event) => {
        await saveSettings({ sapshcutPath: event.target.value.trim() });
        await refreshGuiStatus();
        paint();
      }),
    });

    const extraInput = h("input", {
      id: "settings-sap-landscape",
      class: "input input--mono",
      value: (settings.sapLandscapePaths ?? []).join("; "),
      placeholder: "可选：额外的 SAPUILandscape.xml 路径，用 ; 分隔",
      onChange: guard(async (event) => {
        const paths = event.target.value
          .split(";")
          .map((path) => path.trim())
          .filter(Boolean);
        await saveSettings({ sapLandscapePaths: paths });
        await refreshLandscape();
        paint();
      }),
    });

    mount(
      container,
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "密码传递方式"),
        h(
          "div",
          { class: "segmented" },
          modeOption("clipboard", "剪贴板（推荐）", "shield"),
          modeOption("commandLine", "命令行明文", "key"),
        ),
        h(
          "p",
          { class: "form__hint" },
          mode === "commandLine"
            ? "启动 SAP GUI 时把用户名和密码都作为参数交给它：一次点击就登录，但密码会出现在进程命令行里，本机上其它程序在启动的一瞬间可能读到它。"
            : "打开 SAP GUI 的登录界面时只填用户名、不填密码，同时把密码放进剪贴板：界面出现后按一次 Ctrl+V 填入密码即可。",
        ),
      ),
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "SAP GUI 启动器"),
        h(
          "div",
          { class: "inline-row" },
          pathInput,
          h(
            "button",
            {
              class: "btn btn--sm",
              type: "button",
              onClick: guard(async () => {
                const picked = await api.pickFiles();
                if (!picked.length) return;
                await saveSettings({ sapshcutPath: picked[0] });
                await refreshGuiStatus();
                paint();
              }),
            },
            icon("folder", { size: 13 }),
            "浏览",
          ),
          h(
            "button",
            {
              class: "btn btn--sm",
              type: "button",
              onClick: guard(async () => {
                await refreshGuiStatus();
                const found = state.guiStatus?.executable;
                toast(
                  found ? "已找到 sapshcut.exe" : "没有检测到 sapshcut.exe",
                  found ? "success" : "error",
                );
                paint();
              }),
            },
            icon("refresh", { size: 13 }),
            "重新检测",
          ),
        ),
        h(
          "p",
          { class: "form__hint" },
          gui?.executable
            ? `当前使用：${gui.executable}`
            : "没有检测到 sapshcut.exe（未安装 SAP GUI for Windows 时就是这样）。可以手动指定它的完整路径。",
        ),
      ),
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "SAP Logon 配置"),
        h(
          "div",
          { class: "token-list" },
          h("span", { class: "tag tag--mono" }, `${systems.length} 个系统`),
          h("span", { class: "tag tag--mono" }, `${launchable.length} 个可登录`),
          landscape?.files?.length
            ? h("span", { class: "tag" }, `${landscape.files.length} 个配置文件`)
            : null,
          gui?.duplicateSystemIds?.length
            ? h(
                "span",
                { class: "tag tag--warn" },
                `${gui.duplicateSystemIds.length} 个重名系统 ID`,
              )
            : null,
        ),
        extraInput,
        landscape?.files?.length
          ? h("p", { class: "form__hint" }, `已读取：${landscape.files.join("；")}`)
          : h(
              "p",
              { class: "form__hint" },
              "没有找到 SAPUILandscape.xml。在 SAP GUI 里添加过系统之后它才会出现（通常在 %APPDATA%\\SAP\\Common\\SAPUILandscape.xml）。",
            ),
        h(
          "button",
          {
            class: "btn btn--sm",
            type: "button",
            onClick: guard(async () => {
              await refreshLandscape();
              toast("已重新读取 SAP Logon 配置", "success");
              paint();
            }),
          },
          icon("refresh", { size: 13 }),
          "重新读取系统列表",
        ),
      ),
    );
  }

  paint();
  return card(
    "SAP GUI 登录",
    "server",
    "SapVault 用 SAP 自带的 sapshcut.exe 启动 SAP GUI，并从 SAP Logon 的配置文件里读取系统列表；导出的 .sap 快捷方式不含密码。",
    container,
  );
}

function knoxCard() {
  return card(
    "全局 Knox ID",
    "fingerprint",
    "条目里勾选「使用全局 Knox ID」后，该条目就以这个值作为用户名，复制与同步时同样生效。",
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

/** Default password policy offered when creating a new entry. */
function ruleCard() {
  const container = h("div", { class: "stack stack--tight" });

  function patch(values) {
    const next = { ...(state.settings.defaultRule ?? defaultRule()), ...values };
    saveSettings({ defaultRule: next })
      .then(paint)
      .catch(() => {});
  }

  function paint() {
    const rule = state.settings.defaultRule;
    mount(
      container,
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "是否启用默认规则"),
        h(
          "div",
          { class: "segmented" },
          h(
            "button",
            {
              class: `segmented__item${rule ? "" : " is-active"}`,
              type: "button",
              onClick: guard(async () => {
                await saveSettings({ defaultRule: null });
                paint();
              }),
            },
            "不使用规则",
          ),
          h(
            "button",
            {
              class: `segmented__item${rule ? " is-active" : ""}`,
              type: "button",
              onClick: guard(async () => {
                await saveSettings({ defaultRule: { ...defaultRule(), ...(rule ?? {}) } });
                paint();
              }),
            },
            "使用规则",
          ),
        ),
      ),
    );

    if (!rule) return;

    const toggle = (key, label) =>
      h(
        "label",
        { class: "checkbox" },
        h("input", {
          type: "checkbox",
          checked: Boolean(rule[key]),
          onChange: (event) => patch({ [key]: event.target.checked }),
        }),
        h("span", null, label),
      );

    const numberInput = (key, min, max) =>
      h("input", {
        class: "input input--mono",
        type: "number",
        min: String(min),
        max: String(max),
        value: String(rule[key]),
        onChange: (event) => patch({ [key]: Number(event.target.value) }),
      });

    container.append(
      h(
        "div",
        { class: "form__grid" },
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "规则名称"),
          h("input", {
            class: "input",
            value: rule.description,
            placeholder: "例如：集团口令策略 2024",
            onChange: (event) => patch({ description: event.target.value }),
          }),
        ),
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "最小长度"),
          numberInput("minLength", 4, 128),
        ),
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "最大长度"),
          numberInput("maxLength", 4, 128),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "var(--s-4)" } },
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
            value: rule.symbolsSet,
            onChange: (event) => patch({ symbolsSet: event.target.value }),
          }),
        ),
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "禁用字符"),
          h("input", {
            class: "input input--mono",
            value: rule.forbidden,
            onChange: (event) => patch({ forbidden: event.target.value }),
          }),
        ),
      ),
    );
  }

  paint();
  return card(
    "默认密码规则",
    "sliders",
    "新建条目时会默认带上这条规则，仍可在条目里单独修改或取消。",
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
            await saveSettings({
              keyMapping: {
                ...mapping,
                [kind]: event.target.value
                  .split(/[,;\s]+/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
            });
          }),
        }),
        h("p", { class: "form__hint" }, hint),
      );

    mount(
      container,
      row(
        "password",
        "密码关键词",
        "例如 password、passwd、pwd、secret、passwort、kennwort、token",
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "var(--s-4)" } },
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
    );
  }

  paint();
  return card(
    "文件关键词",
    "filter",
    "决定文件里哪些键会被标成「疑似密码」，只是提示；任意键都能手动绑定账号。每个文件可单独覆盖。",
    container,
  );
}

function dataCard() {
  const rows = [
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
      : "全部数据只保存在本机用户目录；备份文件同样是加密的。",
    h(
      "div",
      { class: "path-list" },
      rows.map(([label, value]) =>
        h(
          "div",
          { class: "path-row" },
          h("span", { class: "subtle", style: { flex: "0 0 auto" } }, label),
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
      "p",
      { class: "form__hint" },
      `可同步的格式：${(state.paths?.supportedFormats ?? []).join("、")}`,
    ),
    h(
      "div",
      { style: { display: "flex", gap: "var(--s-2)", flexWrap: "wrap" } },
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: guard(async () => {
            const backup = await api.vaultBackupNow();
            toast(backup ? `已备份到 ${backup}` : "没有可备份的保险库", "success");
          }),
        },
        icon("save", { size: 13 }),
        "立即备份",
      ),
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: guard(async () => {
            const target = await api.pickSaveFile("sapvault-backup.sapvault", "sapvault");
            if (!target) return;
            toast(`已导出到 ${await api.vaultExport(target)}`, "success");
          }),
        },
        icon("download", { size: 13 }),
        "导出",
      ),
      h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          onClick: () =>
            confirmModal({
              title: "导入保险库",
              message: "导入会替换当前保险库，并先自动备份现有文件。",
              detail: "选择之前导出的 .sapvault 文件；主密码模式的保险库需要输入其主密码。",
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
            }),
        },
        icon("upload", { size: 13 }),
        "导入",
      ),
      h(
        "button",
        {
          class: "btn btn--sm btn--danger",
          type: "button",
          onClick: () =>
            confirmModal({
              title: "退出 SapVault",
              message: "确定要退出应用吗？",
              confirmLabel: "退出",
              danger: true,
              onConfirm: () => api.quit(),
            }),
        },
        icon("power", { size: 13 }),
        "退出",
      ),
    ),
    h(
      "p",
      { class: "form__hint" },
      `SapVault v${state.version}${state.portable ? " · 便携模式" : ""}：完全本地运行，无网络请求。` +
        "保险库使用 AES-256-GCM；主密码模式用 Argon2id 派生密钥，本机账户模式用 Windows DPAPI 封装随机密钥。",
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
      { class: "settings-columns" },
      appearanceCard(),
      securityCard(),
      sapCard(),
      knoxCard(),
      ruleCard(),
      keyMapCard(),
      dataCard(),
    ),
  );
}
