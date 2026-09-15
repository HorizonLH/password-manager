import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api, describeError } from "../api.js";
import {
  state,
  saveEntry,
  deleteEntry,
  loadLandscape,
  addHistory,
  removeHistory,
  clearHistory,
  copyText,
} from "../state.js";
import { confirmModal, openModal } from "../modal.js";
import { toast } from "../toast.js";
import { formatTime, mask } from "../format.js";

const LANGUAGES = [
  ["", "默认"],
  ["ZH", "ZH 中文"],
  ["EN", "EN 英文"],
  ["DE", "DE 德文"],
  ["JA", "JA 日文"],
];

function field(label, control, hint) {
  return h(
    "div",
    { class: "form__row" },
    h("label", { class: "form__label" }, label),
    control,
    hint ? h("p", { class: "form__hint" }, hint) : null,
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

/** Password rule editor. A rule is optional: `null` means "no policy". */
function ruleSection(draft, onChange, getPassword) {
  const container = h("div", { class: "stack stack--tight" });

  function paint() {
    const rule = draft.rule;
    mount(
      container,
      h(
        "div",
        { class: "card__head" },
        h(
          "div",
          null,
          h(
            "h3",
            { class: "card__title" },
            icon("sliders", { size: 15 }),
            "密码规则",
          ),
          h(
            "p",
            { class: "card__hint" },
            rule
              ? "保存时会按此规则校验密码，并可一键生成合规密码。"
              : "当前未设置规则，任何密码都会被接受。",
          ),
        ),
        h(
          "label",
          { class: "checkbox" },
          h("input", {
            type: "checkbox",
            checked: Boolean(rule),
            onChange: (event) => {
              draft.rule = event.target.checked ? defaultRule() : null;
              onChange();
              paint();
            },
          }),
          h("span", null, "使用规则"),
        ),
      ),
    );

    if (!rule) return;

    const numberInput = (value, key, min, max) =>
      h("input", {
        class: "input input--mono",
        type: "number",
        min: String(min),
        max: String(max),
        value: String(value),
        onChange: (event) => {
          rule[key] = Number(event.target.value);
          onChange();
        },
      });

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

    mount(
      container,
      h(
        "div",
        { class: "form__grid" },
        field(
          "规则名称 / 备注",
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
        field("最小长度", numberInput(rule.minLength, "minLength", 4, 128)),
        field("最大长度", numberInput(rule.maxLength, "maxLength", 4, 128)),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "12px" } },
        toggle("lower", "小写字母"),
        toggle("upper", "大写字母"),
        toggle("digits", "数字"),
        toggle("symbols", "符号"),
        toggle("startWithLetter", "首字符必须是字母"),
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
        { style: { display: "flex", gap: "8px", alignItems: "center" } },
        h(
          "button",
          {
            class: "btn btn--soft btn--sm",
            type: "button",
            onClick: guard(async () => {
              const generated = await api.generateRulePassword(rule);
              onChange(generated);
              toast("已按规则生成密码", "success");
            }),
          },
          icon("sparkle", { size: 13 }),
          "按规则生成密码",
        ),
        h("span", { class: "form__hint" }, `当前规则：${describeRule(rule)}`),
      ),
    );
  }

  paint();
  void getPassword;
  return container;
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

function describeRule(rule) {
  const classes = [];
  if (rule.lower) classes.push("小写");
  if (rule.upper) classes.push("大写");
  if (rule.digits) classes.push("数字");
  if (rule.symbols) classes.push("符号");
  return `${rule.minLength}-${rule.maxLength} 位 · ${classes.join("+") || "无字符集"}`;
}

/** SAP password history: the system remembers the last N passwords and refuses
 *  to accept a repeat, so the list is what the user needs when rotating. */
function historySection(draft, repaint) {
  const container = h("div", { class: "stack stack--tight" });
  let revealed = new Set();
  const newPassword = { value: "" };
  const newNote = { value: "" };

  function paint() {
    const entryId = draft.id;
    mount(
      container,
      h(
        "div",
        { class: "card__head" },
        h(
          "div",
          null,
          h("h3", { class: "card__title" }, icon("clock", { size: 15 }), "密码循环与历史"),
          h(
            "p",
            { class: "card__hint" },
            "系统会记住最近若干个密码并拒绝重复，这里保留历史密码方便对照。",
          ),
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("span", { class: "form__label" }, "循环周期"),
          h("input", {
            class: "input input--mono",
            type: "number",
            min: "0",
            max: "50",
            style: { width: "76px" },
            value: String(draft.historyCycle ?? 0),
            onChange: (event) => {
              draft.historyCycle = Number(event.target.value) || 0;
            },
          }),
        ),
      ),
      h(
        "p",
        { class: "form__hint" },
        draft.historyCycle > 0
          ? `保存时会检查新密码是否与最近 ${draft.historyCycle} 个密码重复（0 表示不检查）。`
          : "循环周期为 0：不会做重复校验。",
      ),
      entryId
        ? h(
            "div",
            { class: "stack stack--tight" },
            h(
              "div",
              { class: "detail__section-head" },
              h(
                "span",
                { class: "section-title" },
                `已记录 ${draft.history.length} 个历史密码`,
              ),
              draft.history.length
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
                            const entry = await clearHistory(entryId);
                            draft.history = entry.passwordHistory ?? [];
                            repaint?.();
                            paint();
                          }),
                        }),
                    },
                    icon("trash", { size: 12 }),
                    "清空",
                  )
                : null,
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
                      item.note
                        ? h("span", { class: "subtle" }, item.note)
                        : h("span", { class: "subtle" }, formatTime(item.recordedAt)),
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
                          title: "复制该历史密码",
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
                            const entry = await removeHistory(entryId, item.id);
                            draft.history = entry.passwordHistory ?? [];
                            repaint?.();
                            paint();
                          }),
                        },
                        icon("x", { size: 13 }),
                      ),
                    ),
                  ),
                )
              : h("p", { class: "form__hint" }, "还没有历史密码；修改密码时会自动记录。"),
            h(
              "div",
              { class: "form__grid" },
              field(
                "手动补录历史密码",
                h("div", { class: "input-group" }, h("input", {
                  class: "input input--mono",
                  type: "text",
                  placeholder: "以前用过的密码",
                  onInput: (event) => {
                    newPassword.value = event.target.value;
                  },
                })),
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
            ),
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
                  const entry = await addHistory(entryId, newPassword.value, newNote.value);
                  draft.history = entry.passwordHistory ?? [];
                  newPassword.value = "";
                  newNote.value = "";
                  repaint?.();
                  paint();
                  toast("已补录历史密码", "success");
                }),
              },
              icon("plus", { size: 13 }),
              "添加历史密码",
            ),
          )
        : h(
            "p",
            { class: "form__hint" },
            "保存条目后即可记录历史密码。",
          ),
    );
  }

  paint();
  return container;
}

/** Modal editor for one entry. `entry` may be null to create a new record. */
export function openEntryEditor({ entry, defaultCategory, onSaved }) {
  const editing = Boolean(entry?.id);
  const isSapCategory = (categoryId) => categoryId === "sap";

  const draft = {
    id: entry?.id ?? null,
    title: entry?.title ?? "",
    categoryId: entry?.categoryId ?? defaultCategory ?? "sap",
    username: entry?.username ?? "",
    useKnoxId: entry?.useKnoxId ?? false,
    url: entry?.url ?? "",
    notes: entry?.notes ?? "",
    favorite: entry?.favorite ?? false,
    rule: entry?.rule ? { ...entry.rule } : null,
    historyCycle: entry?.historyCycle ?? 0,
    history: [...(entry?.passwordHistory ?? [])],
    sap: {
      systemId: entry?.sap?.systemId ?? "",
      client: entry?.sap?.client ?? "",
      language: entry?.sap?.language ?? "",
      systemName: entry?.sap?.systemName ?? "",
      hosts: [...(entry?.sap?.hosts ?? [])],
      landscapeSource: entry?.sap?.landscapeSource ?? "",
    },
  };
  const password = { value: "" };

  const passwordMeter = strengthMeter();
  const ruleFeedback = h("div", { class: "stack stack--tight" });
  const systemSelect = h("select", { class: "select" });
  const hostList = h("div", { class: "token-list" });
  const systemHint = h("p", { class: "form__hint" });

  const systemInput = h("input", {
    id: "editor-system",
    class: "input input--mono",
    value: draft.sap.systemId,
    maxlength: "8",
    placeholder: "例如 PRD",
    onInput: (event) => {
      draft.sap.systemId = event.target.value.toUpperCase();
      event.target.value = draft.sap.systemId;
    },
    onChange: (event) => resolveSystem(event.target.value),
  });

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

  const passwordInput = h("input", {
    id: "editor-password",
    class: "input input--mono",
    type: "password",
    placeholder: editing ? "留空表示保留原密码" : "密码",
    onInput: (event) => {
      password.value = event.target.value;
      updateMeter(passwordMeter, password.value);
      scheduleValidation();
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

  let validationTimer = null;
  function scheduleValidation() {
    if (validationTimer) clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      validationTimer = null;
      runValidation();
    }, 220);
  }

  function runValidation() {
    const value = password.value;
    if (!draft.rule || !value) {
      mount(ruleFeedback);
      return;
    }
    api
      .validatePassword(value, draft.rule)
      .then((problems) => {
        mount(
          ruleFeedback,
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
  }

  const sapSection = h(
    "div",
    { class: "stack", hidden: !isSapCategory(draft.categoryId) },
    h("div", { class: "section-title" }, icon("server", { size: 13 }), "SAP 系统信息"),
    h(
      "div",
      { class: "form__grid" },
      field("系统 ID", systemInput),
      field(
        "客户端",
        h("input", {
          class: "input input--mono",
          value: draft.sap.client,
          placeholder: "例如 100",
          onInput: (event) => {
            draft.sap.client = event.target.value;
          },
        }),
      ),
      field(
        "登录语言",
        h(
          "select",
          {
            class: "select",
            onChange: (event) => {
              draft.sap.language = event.target.value;
            },
          },
          LANGUAGES.map(([value, label]) =>
            h("option", { value, selected: value === draft.sap.language }, label),
          ),
        ),
      ),
      field(
        "从登录配置选择",
        systemSelect,
        "依据 SAPUILandscape.xml 解析；同一系统 ID 的多个连接会全部合并",
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "登录配置中的主机名"),
      hostList,
      systemHint,
    ),
  );

  const categorySelect = h("select", {
    class: "select",
    onChange: (event) => {
      draft.categoryId = event.target.value;
      sapSection.hidden = !isSapCategory(draft.categoryId);
    },
  });
  mount(
    categorySelect,
    (state.vault?.categories ?? []).map((category) =>
      h("option", { value: category.id }, category.name),
    ),
  );
  categorySelect.value = draft.categoryId;

  function paintSystems() {
    const bySid = new Map();
    for (const system of state.landscape?.systems ?? []) {
      if (!system.systemId) continue;
      if (!bySid.has(system.systemId)) bySid.set(system.systemId, []);
      bySid.get(system.systemId).push(system);
    }
    const options = [h("option", { value: "" }, "（从登录配置中选择）")];
    for (const sid of [...bySid.keys()].sort()) {
      const systems = bySid.get(sid);
      options.push(
        h(
          "option",
          { value: sid },
          `${sid} · ${systems[0].name || systems[0].systemId}${systems.length > 1 ? ` (+${systems.length - 1})` : ""}`,
        ),
      );
    }
    mount(systemSelect, options);
    systemSelect.value = draft.sap.systemId;
  }

  function paintHosts() {
    mount(
      hostList,
      draft.sap.hosts.length
        ? draft.sap.hosts.map((host) => h("span", { class: "token" }, host))
        : h("span", { class: "form__hint" }, "登录配置中没有该系统的记录"),
    );
  }

  const resolveSystem = guard(async (sid) => {
    const value = (sid ?? "").trim().toUpperCase();
    draft.sap.systemId = value;
    if (!value) {
      draft.sap.hosts = [];
      systemHint.textContent = "";
      paintHosts();
      return;
    }
    const systems = await api.sapResolve(value);
    if (!systems.length) {
      draft.sap.hosts = [];
      systemHint.textContent = "登录配置中没有该系统 ID，仍可保存";
      paintHosts();
      return;
    }
    const hosts = new Set();
    for (const system of systems) {
      for (const host of system.hosts ?? []) hosts.add(host);
    }
    draft.sap.hosts = [...hosts];
    draft.sap.systemName = systems[0].name || systems[0].description || "";
    draft.sap.landscapeSource = systems[0].sourceFile || "";
    if (!draft.sap.client && systems[0].client) draft.sap.client = systems[0].client;
    systemHint.textContent =
      systems.length > 1
        ? `系统 ID ${value} 出现 ${systems.length} 次，已合并全部主机名`
        : `解析到 ${draft.sap.hosts.length} 个主机名`;
    paintHosts();
  });

  systemSelect.addEventListener("change", () => {
    if (!systemSelect.value) return;
    systemInput.value = systemSelect.value;
    resolveSystem(systemSelect.value);
  });

  function buildInput(force) {
    return {
      id: draft.id,
      title: draft.title,
      categoryId: draft.categoryId,
      username: draft.username,
      useKnoxId: draft.useKnoxId,
      password: password.value,
      url: draft.url,
      notes: draft.notes,
      favorite: draft.favorite,
      rule: draft.rule,
      historyCycle: draft.historyCycle,
      force: Boolean(force),
      sap: isSapCategory(draft.categoryId)
        ? {
            systemId: draft.sap.systemId,
            client: draft.sap.client,
            language: draft.sap.language,
            systemName: draft.sap.systemName,
            hosts: draft.sap.hosts,
            landscapeSource: draft.sap.landscapeSource,
          }
        : null,
    };
  }

  async function submit(close) {
    if (!draft.title.trim()) {
      toast("请先填写标题", "error");
      return;
    }
    try {
      const saved = await saveEntry(buildInput(false));
      close();
      toast(editing ? "已保存修改" : "已创建条目", "success");
      onSaved?.(saved);
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
            close();
            toast("已按你的选择保存", "success");
            onSaved?.(saved);
          }),
        });
        return;
      }
      toast(problem.message, "error");
    }
  }

  const body = h(
    "div",
    { class: "form" },
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
      field("分类", categorySelect, "SAP 账号会参与全局配置同步"),
    ),
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
    ruleFeedback,
    ruleSection(draft, (generated) => {
      if (typeof generated === "string") {
        password.value = generated;
        passwordInput.value = generated;
        passwordInput.type = "text";
        updateMeter(passwordMeter, generated);
      }
      runValidation();
    }),
    sapSection,
    historySection(draft, () => onSaved?.()),
    h(
      "div",
      { class: "form__grid" },
      field(
        "链接 / URL",
        h("input", {
          class: "input",
          value: draft.url,
          placeholder: "可选；留空时同步会使用关联文件中解析到的 URL",
          onInput: (event) => {
            draft.url = event.target.value;
          },
        }),
      ),
      field(
        "备注",
        h("textarea", {
          class: "textarea",
          value: draft.notes,
          onInput: (event) => {
            draft.notes = event.target.value;
          },
        }),
      ),
    ),
  );

  async function prepare() {
    if (editing) {
      const full = await api.entryGet(draft.id);
      password.value = full.password ?? "";
      updateMeter(passwordMeter, password.value);
      draft.rule = full.rule ? { ...full.rule } : null;
      draft.historyCycle = full.historyCycle ?? 0;
      draft.history = [...(full.passwordHistory ?? [])];
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
      updateMeter(passwordMeter, generated);
    }
    if (state.landscape) paintSystems();
    else loadLandscape(false).then(paintSystems).catch(() => {});
    paintHosts();
    if (draft.sap.systemId) resolveSystem(draft.sap.systemId);
  }

  prepare().catch(() => {});

  openModal({
    title: editing ? "编辑条目" : "新建条目",
    size: "wide",
    render: () => body,
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "8px", width: "100%", alignItems: "center" } },
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
          {
            class: "btn btn--primary",
            type: "button",
            onClick: () => submit(close),
          },
          icon("check", { size: 15 }),
          "保存",
        ),
      ),
  });
}
