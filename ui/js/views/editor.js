import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api, describeError } from "../api.js";
import {
  state,
  saveEntry,
  deleteEntry,
  addHistory,
  removeHistory,
  clearHistory,
  copyText,
  bindingsFor,
  filesForEntry,
  syncFiles,
  refreshLandscape,
} from "../state.js";
import { confirmModal, openModal } from "../modal.js";
import { toast } from "../toast.js";
import { formatTime, mask, ruleSummary, systemLabel, systemTarget } from "../format.js";

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

function describeRule(rule) {
  return ruleSummary(rule, { includeDescription: false });
}

function field(label, control, hint) {
  return h(
    "div",
    { class: "form__row" },
    h("label", { class: "form__label" }, label),
    control,
    hint ? h("p", { class: "form__hint" }, hint) : null,
  );
}

function section(title, iconName, hint, ...children) {
  return h(
    "section",
    { class: "card card--flat" },
    h(
      "div",
      { class: "card__head" },
      h(
        "div",
        null,
        h("h3", { class: "card__title" }, icon(iconName, { size: 15 }), title),
        hint ? h("p", { class: "card__hint" }, hint) : null,
      ),
    ),
    ...children,
  );
}

function strengthMeter() {
  return h(
    "div",
    { class: "strength", dataset: { score: "0" } },
    h(
      "div",
      { class: "strength__track" },
      ...[0, 1, 2, 3, 4].map(() => h("div", { class: "strength__bar" })),
    ),
    h("span", { class: "strength__label" }, "强度"),
  );
}

function updateMeter(meter, password) {
  api
    .strength(password ?? "")
    .then((report) => {
      meter.dataset.score = String(report.score);
      meter
        .querySelectorAll(".strength__bar")
        .forEach((bar, index) => bar.classList.toggle("is-on", index < report.score));
      const label = meter.querySelector(".strength__label");
      if (label) {
        label.textContent = report.entropyBits
          ? `${report.label} · ${Math.round(report.entropyBits)} bits`
          : report.label;
      }
    })
    .catch(() => {});
}

/** Password rule block. The mode switch is a segmented control so "不使用规则"
 *  is always reachable, and `repaint` lets the caller re-sync it after loading
 *  the entry (or the default rule) asynchronously. */
function ruleSection(draft, onChange) {
  const node = h("div", { class: "stack stack--tight" });
  const feedback = h("div", { class: "stack stack--tight" });
  let validationTimer = null;

  function validate(password) {
    if (validationTimer) clearTimeout(validationTimer);
    if (!draft.rule || !password) {
      mount(feedback);
      return;
    }
    validationTimer = setTimeout(() => {
      api
        .validatePassword(password, draft.rule)
        .then((problems) => {
          mount(
            feedback,
            problems.length
              ? h(
                  "div",
                  { class: "banner banner--warn" },
                  h("span", { class: "banner__icon" }, icon("alert", { size: 15 })),
                  h(
                    "div",
                    { class: "banner__body" },
                    h("span", { class: "banner__title" }, "密码不符合当前规则"),
                    ...problems.map((problem) => h("span", null, problem)),
                  ),
                )
              : h(
                  "div",
                  { class: "banner" },
                  h("span", { class: "banner__icon" }, icon("checkCircle", { size: 15 })),
                  h("span", null, "密码符合当前规则"),
                ),
          );
        })
        .catch(() => {});
    }, 250);
  }

  function repaint() {
    const rule = draft.rule;
    mount(
      node,
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "是否启用规则"),
        h(
          "div",
          { class: "segmented" },
          h(
            "button",
            {
              class: `segmented__item${rule ? "" : " is-active"}`,
              type: "button",
              onClick: () => {
                draft.rule = null;
                onChange();
                repaint();
              },
            },
            "不使用规则",
          ),
          h(
            "button",
            {
              class: `segmented__item${rule ? " is-active" : ""}`,
              type: "button",
              onClick: () => {
                draft.rule = { ...defaultRule(), ...(draft.rule ?? {}) };
                onChange();
                repaint();
              },
            },
            "使用规则",
          ),
        ),
        h(
          "p",
          { class: "form__hint" },
          rule
            ? "保存时会按此规则校验密码，并可一键生成合规密码。"
            : "当前不校验密码，任何密码都可以保存。",
        ),
      ),
    );

    if (!rule) {
      mount(feedback);
      return;
    }

    const toggle = (key, label) =>
      h(
        "label",
        { class: "checkbox" },
        h("input", {
          type: "checkbox",
          checked: Boolean(rule[key]),
          onChange: (event) => {
            rule[key] = event.target.checked;
            onChange();
          },
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
        onChange: (event) => {
          rule[key] = Number(event.target.value);
          onChange();
        },
      });

    node.append(
      h(
        "div",
        { class: "form__grid" },
        field(
          "规则名称",
          h("input", {
            class: "input",
            value: rule.description,
            placeholder: "例如：集团口令策略 2024",
            onInput: (event) => {
              rule.description = event.target.value;
              onChange();
            },
          }),
        ),
        field("最小长度", numberInput("minLength", 4, 128)),
        field("最大长度", numberInput("maxLength", 4, 128)),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "var(--s-4)" } },
        toggle("lower", "小写字母"),
        toggle("upper", "大写字母"),
        toggle("digits", "数字"),
        toggle("symbols", "符号"),
        toggle("startWithLetter", "首字符为字母"),
        toggle("avoidAmbiguous", "排除易混淆字符"),
      ),
      h(
        "div",
        { class: "form__grid" },
        field(
          "可用符号",
          h("input", {
            class: "input input--mono",
            value: rule.symbolsSet,
            onInput: (event) => {
              rule.symbolsSet = event.target.value;
              onChange();
            },
          }),
        ),
        field(
          "禁用字符",
          h("input", {
            class: "input input--mono",
            value: rule.forbidden,
            placeholder: "例如 @\\/",
            onInput: (event) => {
              rule.forbidden = event.target.value;
              onChange();
            },
          }),
        ),
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "var(--s-3)", flexWrap: "wrap" } },
        h(
          "button",
          {
            class: "btn btn--soft btn--sm",
            type: "button",
            onClick: guard(async () => {
              const generated = await api.generateRulePassword(draft.rule);
              onChange(generated);
              validate(generated);
              toast("已按规则生成密码", "success");
            }),
          },
          icon("sparkle", { size: 13 }),
          "按规则生成密码",
        ),
        h("span", { class: "form__hint" }, `当前规则：${describeRule(rule)}`),
      ),
      feedback,
    );
  }

  repaint();
  return { node, repaint, validate };
}

/** Password history: the target system remembers the last N passwords, so the
 *  list is what the user needs when rotating. */
function historySection(draft, repaintEditor) {
  const node = h("div", { class: "stack stack--tight" });
  const revealed = new Set();
  const newPassword = { value: "" };
  const newNote = { value: "" };

  function paint() {
    const entryId = draft.id;
    mount(
      node,
      h(
        "div",
        { class: "form__grid" },
        field(
          "循环周期",
          h("input", {
            class: "input input--mono",
            type: "number",
            min: "0",
            max: "50",
            value: String(draft.historyCycle ?? 0),
            onChange: (event) => {
              draft.historyCycle = Number(event.target.value) || 0;
            },
          }),
        ),
        field(
          "已记录",
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "var(--s-2)" } },
            h("span", { class: "tag tag--mono" }, `${draft.history.length} 个历史密码`),
            draft.history.length && entryId
              ? h(
                  "button",
                  {
                    class: "btn btn--ghost btn--sm",
                    type: "button",
                    onClick: () =>
                      confirmModal({
                        title: "清空历史密码",
                        message: "确定删除该条目的全部历史密码吗？",
                        detail: "密码循环校验将不再有参考对象。",
                        confirmLabel: "清空",
                        danger: true,
                        onConfirm: guard(async () => {
                          const updated = await clearHistory(entryId);
                          draft.history = updated.passwordHistory ?? [];
                          repaintEditor?.();
                          paint();
                        }),
                      }),
                  },
                  "清空",
                )
              : null,
          ),
          draft.historyCycle > 0
            ? `保存时检查新密码是否与最近 ${draft.historyCycle} 个密码重复。`
            : "循环周期为 0：不做重复校验。",
        ),
      ),
      draft.history.length
        ? h(
            "div",
            { class: "stack stack--tight" },
            draft.history.map((item, index) =>
              h(
                "div",
                { class: "assoc__file" },
                h(
                  "span",
                  { class: "tag tag--mono" },
                  draft.historyCycle > 0 && index < draft.historyCycle ? "循环内" : "更早",
                ),
                h(
                  "span",
                  { class: "field__text", style: { flex: "1" } },
                  revealed.has(item.id) ? item.password : mask(item.password, false),
                ),
                h("span", { class: "subtle nowrap" }, item.note || formatTime(item.recordedAt)),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "显示 / 隐藏",
                    onClick: () => {
                      if (revealed.has(item.id)) revealed.delete(item.id);
                      else revealed.add(item.id);
                      paint();
                    },
                  },
                  icon(revealed.has(item.id) ? "eyeOff" : "eye", { size: 13 }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "复制",
                    onClick: guard(() => copyText(item.password, "历史密码")),
                  },
                  icon("copy", { size: 13 }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "删除",
                    onClick: guard(async () => {
                      const updated = await removeHistory(entryId, item.id);
                      draft.history = updated.passwordHistory ?? [];
                      repaintEditor?.();
                      paint();
                    }),
                  },
                  icon("x", { size: 13 }),
                ),
              ),
            ),
          )
        : h(
            "p",
            { class: "form__hint" },
            entryId
              ? "还没有历史密码；修改密码时会自动记录，也可以在下面手动补录。"
              : "保存条目后即可记录历史密码。",
          ),
      entryId
        ? h(
            "div",
            { class: "form__grid" },
            field(
              "手动补录",
              h("input", {
                class: "input input--mono",
                placeholder: "以前用过的密码",
                onInput: (event) => {
                  newPassword.value = event.target.value;
                },
              }),
            ),
            field(
              "备注",
              h("input", {
                class: "input",
                placeholder: "例如：2024Q1 使用",
                onInput: (event) => {
                  newNote.value = event.target.value;
                },
              }),
            ),
            h(
              "div",
              { class: "form__row" },
              h("label", { class: "form__label" }, " "),
              h(
                "button",
                {
                  class: "btn btn--sm",
                  type: "button",
                  onClick: guard(async () => {
                    if (!newPassword.value) {
                      toast("请先填写历史密码", "error");
                      return;
                    }
                    const updated = await addHistory(entryId, newPassword.value, newNote.value);
                    draft.history = updated.passwordHistory ?? [];
                    newPassword.value = "";
                    newNote.value = "";
                    paint();
                    toast("已补录历史密码", "success");
                  }),
                },
                icon("plus", { size: 13 }),
                "添加",
              ),
            ),
          )
        : null,
    );
  }

  paint();
  return { node, repaint: paint };
}

/** SAP GUI launch settings.
 *
 *  The picker is filled from `SAPUILandscape.xml`, so the normal case is
 *  "choose the system, keep the defaults". Everything can also be typed by hand
 *  for machines where SapVault cannot read SAP Logon's configuration. */
function sapLoginBlock(draft) {
  const node = h("div", { class: "stack stack--tight" });

  const launchable = () =>
    (state.landscape?.systems ?? []).filter(
      (system) =>
        system.systemId &&
        (system.kind === "applicationServer" || system.kind === "serverGroup"),
    );

  function duplicateIds(systems) {
    const counts = new Map();
    for (const system of systems) {
      counts.set(system.systemId, (counts.get(system.systemId) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
    );
  }

  /** Picking a system pins the exact landscape entry, which matters because a
   *  system ID may be configured more than once in SAP Logon. */
  function pickSystem(serviceUuid) {
    const system = launchable().find((item) => item.serviceUuid === serviceUuid);
    if (!system) {
      draft.sap.serviceUuid = "";
      return;
    }
    draft.sap.serviceUuid = system.serviceUuid;
    draft.sap.systemId = system.systemId;
    if (system.guiparm) draft.sap.guiparm = system.guiparm;
    if (!draft.sap.client) draft.sap.client = system.client || "";
    if (!draft.sap.language) draft.sap.language = system.language || "";
  }

  function textField(label, key, options = {}) {
    return field(
      label,
      h("input", {
        id: options.id ?? null,
        class: options.mono ? "input input--mono" : "input",
        value: draft.sap[key] ?? "",
        placeholder: options.placeholder ?? null,
        onInput: (event) => {
          draft.sap[key] = event.target.value;
        },
      }),
      options.hint,
    );
  }

  function repaint() {
    if (draft.categoryId !== "sap") {
      mount(
        node,
        h(
          "p",
          { class: "form__hint" },
          "只有「SAP 账号」分类的条目可以配置 SAP GUI 登录。",
        ),
      );
      return;
    }

    const systems = launchable();
    const duplicates = duplicateIds(systems);
    const selected = systems.some((item) => item.serviceUuid === draft.sap.serviceUuid)
      ? draft.sap.serviceUuid
      : "";
    const picker = h(
      "select",
      { id: "editor-sap-system", class: "select" },
      h(
        "option",
        { value: "" },
        systems.length ? "（从 SAP Logon 选择系统）" : "（没有读到 SAP Logon 的系统）",
      ),
      systems.map((system) =>
        h(
          "option",
          { value: system.serviceUuid, selected: system.serviceUuid === selected },
          `${systemLabel(system)}${duplicates.has(system.systemId) ? "（同名）" : ""} · ${systemTarget(system)}`,
        ),
      ),
    );
    picker.addEventListener("change", () => {
      pickSystem(picker.value);
      repaint();
    });

    const landscape = state.landscape;
    const landscapeHint = landscape?.files?.length
      ? `已从 ${landscape.files.length} 个配置文件里读到 ${landscape.systems.length} 个系统；同名系统需要选具体的那一个。`
      : "没有找到 SAPUILandscape.xml（SAP Logon 的配置文件），可以手动填写系统 ID 与连接串。";
    const gui = state.guiStatus;
    const guiHint = gui?.executable
      ? `启动器：${gui.executable}`
      : "没有找到 sapshcut.exe —— 可在「设置 → SAP GUI 登录」里手动指定 SAP GUI 的安装位置。";

    mount(
      node,
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, "SAP Logon 系统"),
        h(
          "div",
          { class: "inline-row" },
          picker,
          h(
            "button",
            {
              class: "btn btn--sm",
              type: "button",
              onClick: guard(async () => {
                await refreshLandscape();
                toast("已重新读取 SAP Logon 配置", "success");
                repaint();
              }),
            },
            icon("refresh", { size: 13 }),
            "重新读取",
          ),
        ),
        h("p", { class: "form__hint" }, landscapeHint),
      ),
      h(
        "div",
        { class: "form__grid" },
        textField("系统 ID", "systemId", {
          id: "editor-sap-system-id",
          mono: true,
          placeholder: "例如 PRD",
        }),
        textField("客户端", "client", { mono: true, placeholder: "例如 100" }),
        textField("登录语言", "language", { mono: true, placeholder: "例如 ZH" }),
      ),
      textField("连接串（GuiParm）", "guiparm", {
        mono: true,
        placeholder: "/H/sap-prd.example/S/3200",
        hint:
          "从 SAP Logon 选系统时会自动带出。手动填写：应用服务器用 /H/主机/S/端口；" +
          "登录组用 /R/系统ID/G/组名，或 /M/消息服务器/S/端口/G/组名。" +
          "系统 ID 会一并传给 SAP GUI —— 服务组连接缺了它会被判为「缺少系统 ID」。",
      }),
      h(
        "div",
        { class: "form__grid" },
        textField("登录后执行事务码", "transaction", {
          mono: true,
          placeholder: "可留空，例如 SE80",
        }),
        h(
          "div",
          { class: "form__row" },
          h("label", { class: "form__label" }, "启动方式"),
          h(
            "label",
            { class: "checkbox" },
            h("input", {
              type: "checkbox",
              checked: Boolean(draft.sap.maximize),
              onChange: (event) => {
                draft.sap.maximize = event.target.checked;
              },
            }),
            h("span", null, "启动后最大化窗口（-maxgui）"),
          ),
          h(
            "p",
            { class: "form__hint" },
            "登录成功却看不到 SAP GUI 窗口时勾上它 —— SAP GUI 会记住窗口位置，" +
              "偶尔会把新窗口创建到屏幕外；这个参数（SAP 官方参数）会让它最大化显示。",
          ),
        ),
      ),
      h("p", { class: "form__hint" }, guiHint),
    );
  }

  repaint();
  return { node, repaint };
}

/** A rotated password leaves every bound file holding the old one, so the user
 *  is told right away and can sync from the same dialog. */
function notifyBoundFiles(entry) {
  const files = filesForEntry(entry.id);
  if (!files.length) return;
  const keys = files.reduce((sum, file) => sum + bindingsFor(entry.id, file).length, 0);

  openModal({
    title: "文件里的密码还是旧的",
    render: () =>
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "banner banner--warn" },
          h("span", { class: "banner__icon" }, icon("alert", { size: 16 })),
          h(
            "div",
            { class: "banner__body" },
            h("span", { class: "banner__title" }, `「${entry.title}」的新密码还没写进文件`),
            h(
              "span",
              null,
              `这个账号绑定了 ${files.length} 个文件里的 ${keys} 个键，它们现在仍然是旧密码。` +
                "同步只替换这些键的值，其它内容、注释与格式保持不变。",
            ),
          ),
        ),
        h(
          "div",
          { class: "stack stack--tight" },
          files.map((file) =>
            h(
              "div",
              { class: "assoc__file" },
              icon(file.exists ? "file" : "alert", { size: 13 }),
              h("span", { class: "assoc__file-path", title: file.path }, file.path),
              ...bindingsFor(entry.id, file).map((binding) =>
                h("span", { class: "tag tag--mono", title: binding.keyPath }, binding.keyPath),
              ),
            ),
          ),
        ),
      ),
    footer: (close) =>
      h(
        "div",
        {
          style: {
            display: "flex",
            gap: "var(--s-2)",
            width: "100%",
            justifyContent: "flex-end",
          },
        },
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "稍后处理"),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: guard(async () => {
              close();
              await syncFiles(files.map((file) => file.id));
            }),
          },
          icon("download", { size: 14 }),
          "现在同步",
        ),
      ),
  });
}

/** Modal editor for one entry. `entry` may be null to create a new record. */
export function openEntryEditor({ entry, defaultCategory, onSaved }) {
  const editing = Boolean(entry?.id);

  const draft = {
    id: entry?.id ?? null,
    title: entry?.title ?? "",
    categoryId: entry?.categoryId ?? defaultCategory ?? "sap",
    username: entry?.username ?? "",
    useKnoxId: entry?.useKnoxId ?? false,
    notes: entry?.notes ?? "",
    favorite: entry?.favorite ?? false,
    rule: entry?.rule ? { ...entry.rule } : null,
    historyCycle: entry?.historyCycle ?? 0,
    history: [...(entry?.passwordHistory ?? [])],
    sap: {
      systemId: entry?.sap?.systemId ?? "",
      client: entry?.sap?.client ?? "",
      language: entry?.sap?.language ?? "",
      guiparm: entry?.sap?.guiparm ?? "",
      serviceUuid: entry?.sap?.serviceUuid ?? "",
      transaction: entry?.sap?.transaction ?? "",
      maximize: entry?.sap?.maximize ?? false,
    },
  };
  const password = { value: "" };
  /** The password as loaded, so "did this save rotate it?" is answerable. */
  let storedPassword = "";

  const passwordMeter = strengthMeter();
  const passwordInput = h("input", {
    id: "editor-password",
    class: "input input--mono",
    type: "password",
    placeholder: editing ? "留空表示保留原密码" : "密码",
    onInput: (event) => {
      password.value = event.target.value;
      updateMeter(passwordMeter, password.value);
      rule.validate(password.value);
    },
  });

  const revealButton = h(
    "button",
    {
      class: "btn btn--icon",
      type: "button",
      "aria-label": "显示密码",
      onClick: () => {
        const showing = passwordInput.type === "text";
        passwordInput.type = showing ? "password" : "text";
        mount(revealButton, icon(showing ? "eye" : "eyeOff", { size: 15 }));
      },
    },
    icon("eye", { size: 15 }),
  );

  const usernameInput = h("input", {
    id: "editor-username",
    class: "input input--mono",
    value: draft.username,
    placeholder: draft.useKnoxId
      ? `使用 Knox ID：${state.vault?.knoxId || "（未设置）"}`
      : "用户名",
    disabled: draft.useKnoxId,
    onInput: (event) => {
      draft.username = event.target.value;
    },
  });

  const knoxToggle = h("input", {
    type: "checkbox",
    checked: draft.useKnoxId,
    onChange: (event) => {
      draft.useKnoxId = event.target.checked;
      usernameInput.disabled = draft.useKnoxId;
      usernameInput.placeholder = draft.useKnoxId
        ? `使用 Knox ID：${state.vault?.knoxId || "（未设置）"}`
        : "用户名";
    },
  });

  const categorySelect = h("select", {
    class: "select",
    onChange: (event) => {
      draft.categoryId = event.target.value;
      // The SAP block only applies to SAP accounts, and a new entry may be
      // switched into that category while the editor is open.
      sapLogin.repaint();
    },
  });
  mount(
    categorySelect,
    (state.vault?.categories ?? []).map((category) =>
      h("option", { value: category.id }, category.name),
    ),
  );
  categorySelect.value = draft.categoryId;

  const history = historySection(draft, () => onSaved?.());
  const sapLogin = sapLoginBlock(draft);
  const rule = ruleSection(draft, (generated) => {
    if (typeof generated === "string") {
      password.value = generated;
      passwordInput.value = generated;
      passwordInput.type = "text";
      updateMeter(passwordMeter, generated);
    }
  });

  const body = h(
    "div",
    { class: "form" },
    section(
      "基本信息",
      "key",
      null,
      h(
        "div",
        { class: "form__grid" },
        field(
          "标题",
          h("input", {
            id: "editor-title",
            class: "input",
            value: draft.title,
            placeholder: "例如 生产机 PRD",
            onInput: (event) => {
              draft.title = event.target.value;
            },
          }),
        ),
        field("分类", categorySelect, "SAP 分类的账号会参与全局配置同步"),
      ),
    ),
    section(
      "凭据",
      "user",
      null,
      h(
        "div",
        { class: "form__grid" },
        field(
          "用户名",
          h(
            "div",
            { class: "stack stack--tight" },
            usernameInput,
            h(
              "label",
              { class: "checkbox" },
              knoxToggle,
              h("span", null, `使用全局 Knox ID（${state.vault?.knoxId || "未设置"}）`),
            ),
          ),
        ),
        field(
          "密码",
          h("div", { class: "input-group" }, passwordInput, revealButton),
          editing ? "留空表示保留原密码" : null,
        ),
      ),
      passwordMeter,
    ),
    section(
      "SAP GUI 登录",
      "server",
      "把系统、客户端与语言存进条目后，账号列表和详情页就能一键打开 SAP GUI。",
      sapLogin.node,
    ),
    section(
      "密码规则",
      "sliders",
      "可以选择使用规则，也可以完全不加规则。",
      rule.node,
    ),
    section(
      "密码循环与历史",
      "clock",
      "SAP 系统会记住最近若干个密码并拒绝重复，这里保留历史密码方便对照。",
      history.node,
    ),
    section(
      "备注",
      "file",
      null,
      h("textarea", {
        class: "textarea",
        value: draft.notes,
        placeholder: "可选",
        onInput: (event) => {
          draft.notes = event.target.value;
        },
      }),
    ),
  );

  function buildInput(force) {
    return {
      id: draft.id,
      title: draft.title,
      categoryId: draft.categoryId,
      username: draft.username,
      useKnoxId: draft.useKnoxId,
      password: password.value,
      notes: draft.notes,
      favorite: draft.favorite,
      rule: draft.rule,
      historyCycle: draft.historyCycle,
      force: Boolean(force),
      sap: draft.categoryId === "sap" ? { ...draft.sap } : null,
    };
  }

  /** Only a real password change is worth telling the files about. */
  function passwordRotated() {
    return editing && Boolean(password.value) && password.value !== storedPassword;
  }

  async function submit(close) {
    if (!draft.title.trim()) {
      toast("请先填写标题", "error");

      return;
    }
    try {
      const saved = await saveEntry(buildInput(false));
      const rotated = passwordRotated();
      close();
      toast(editing ? "已保存修改" : "已创建条目", "success");
      onSaved?.(saved);
      if (rotated) notifyBoundFiles(saved);
    } catch (error) {
      const problem = describeError(error);
      if (problem.kind === "password-rule" || problem.kind === "password-cycle") {
        confirmModal({
          title: problem.message,
          message: "检测到以下问题：",
          detail: problem.details.join("；"),
          confirmLabel: "仍然保存",
          cancelLabel: "返回修改",
          danger: true,
          onConfirm: guard(async () => {
            const saved = await saveEntry(buildInput(true));
            const rotated = passwordRotated();
            close();
            toast("已按你的选择保存", "success");
            onSaved?.(saved);
            if (rotated) notifyBoundFiles(saved);
          }),
        });
        return;
      }
      toast(problem.message, "error");
    }
  }

  async function prepare() {
    if (editing) {
      const full = await api.entryGet(draft.id);
      password.value = full.password ?? "";
      storedPassword = password.value;
      updateMeter(passwordMeter, password.value);
      draft.rule = full.rule ? { ...full.rule } : null;
      draft.historyCycle = full.historyCycle ?? 0;
      draft.history = [...(full.passwordHistory ?? [])];
      draft.sap = {
        systemId: full.sap?.systemId ?? "",
        client: full.sap?.client ?? "",
        language: full.sap?.language ?? "",
        guiparm: full.sap?.guiparm ?? "",
        serviceUuid: full.sap?.serviceUuid ?? "",
        transaction: full.sap?.transaction ?? "",
        maximize: full.sap?.maximize ?? false,
      };
    } else {
      const generated = await api.generatePassword({
        length: 16,
        upper: true,
        lower: true,
        digits: true,
        symbols: false,
        avoidAmbiguous: false,
        maxLength: 40,
      });
      password.value = generated;
      passwordInput.value = generated;
      draft.rule = state.settings?.defaultRule ? { ...state.settings.defaultRule } : null;
      updateMeter(passwordMeter, password.value);
    }
    // The loaded rule / history may differ from what was rendered first.
    rule.repaint();
    history.repaint();
    sapLogin.repaint();
  }

  prepare().catch(() => {});

  openModal({
    title: editing ? "编辑条目" : "新建条目",
    size: "wide",
    render: () => body,
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "var(--s-2)", width: "100%", alignItems: "center" } },
        editing
          ? h(
              "button",
              {
                class: "btn btn--danger",
                type: "button",
                onClick: () => {
                  confirmModal({
                    title: "删除条目",
                    message: `确定要删除「${draft.title || "未命名"}」吗？`,
                    detail: "该操作会同时移除它与关联文件的绑定关系。",
                    confirmLabel: "删除",
                    danger: true,
                    onConfirm: guard(async () => {
                      close();
                      await deleteEntry(draft.id);
                      toast("条目已删除", "success");
                      onSaved?.();
                    }),
                  });
                },
              },
              icon("trash", { size: 14 }),
              "删除",
            )
          : null,
        h("div", { class: "modal__footer-spacer" }),
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
        h(
          "button",
          { class: "btn btn--primary", type: "button", onClick: () => submit(close) },
          icon("check", { size: 15 }),
          "保存",
        ),
      ),
  });
}
