import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, saveEntry, deleteEntry, loadLandscape } from "../state.js";
import { confirmModal, openModal } from "../modal.js";
import { toast } from "../toast.js";

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
          ? `${report.label} · ${Math.round(report.entropyBits)} bit`
          : report.label;
      }
    })
    .catch(() => {});
}

/** Password generator block. SAP caps most passwords at 40 characters and some
 *  systems reject punctuation, so the cap is applied by default. */
function generatorPanel(getPassword, setPassword) {
  const options = {
    length: 20,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: false,
    maxLength: 40,
  };

  const lengthLabel = h("span", { class: "mono" }, String(options.length));
  const lengthInput = h("input", {
    class: "input",
    type: "range",
    min: "8",
    max: "64",
    value: String(options.length),
    onInput: (event) => {
      options.length = Number(event.target.value);
      lengthLabel.textContent = String(options.length);
    },
  });

  const toggle = (key, label) =>
    h(
      "label",
      { class: "checkbox" },
      h("input", {
        type: "checkbox",
        checked: options[key],
        onChange: (event) => {
          options[key] = event.target.checked;
        },
      }),
      h("span", null, label),
    );

  return h(
    "div",
    { class: "card card--flat" },
    h(
      "div",
      { class: "card__head" },
      h(
        "div",
        null,
        h("h3", { class: "card__title" }, icon("sparkle", { size: 15 }), "生成密码"),
        h(
          "p",
          { class: "card__hint" },
          "会保证选中的每类字符至少出现一次；SAP 系统通常限制为 40 字符以内。",
        ),
      ),
    ),
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "长度 ", lengthLabel),
      lengthInput,
    ),
    h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: "12px" } },
      toggle("upper", "大写"),
      toggle("lower", "小写"),
      toggle("digits", "数字"),
      toggle("symbols", "符号"),
      toggle("avoidAmbiguous", "排除易混字符"),
    ),
    h(
      "div",
      { style: { display: "flex", gap: "8px", alignItems: "center" } },
      h(
        "button",
        {
          class: "btn btn--soft",
          type: "button",
          onClick: guard(async () => {
            const value = await api.generatePassword(options);
            setPassword(value);
            toast("已生成新密码", "success");
          }),
        },
        icon("refresh", { size: 14 }),
        "生成并使用",
      ),
      h("span", { class: "form__hint" }, `当前长度 ${String(getPassword() ?? "").length}`),
    ),
  );
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
      h("label", { class: "form__label" }, "可匹配的主机名 / 域名"),
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
        : h(
            "span",
            { class: "form__hint" },
            "尚未解析到主机名；可在“SAP 系统”页刷新登录配置",
          ),
    );
  }

  function applyResolved(systems) {
    if (!systems.length) {
      draft.sap.hosts = [];
      draft.sap.systemName = "";
      draft.sap.landscapeSource = "";
      systemHint.textContent =
        "登录配置中没有该系统 ID，仍可保存；扫描时将只依据用户名与主机名匹配";
      paintHosts();
      return;
    }
    const hosts = new Set();
    for (const system of systems) {
      for (const host of system.domains ?? []) hosts.add(host);
      for (const host of system.hosts ?? []) hosts.add(host);
    }
    draft.sap.hosts = [...hosts];
    draft.sap.systemName = systems[0].name || systems[0].description || "";
    draft.sap.landscapeSource = systems[0].sourceFile || "";
    if (!draft.sap.client && systems[0].client) draft.sap.client = systems[0].client;
    systemHint.textContent =
      systems.length > 1
        ? `系统 ID ${draft.sap.systemId} 在登录配置中出现 ${systems.length} 次，已合并全部主机名`
        : `已解析到 ${draft.sap.hosts.length} 个可匹配的主机名 / 域名`;
    paintHosts();
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
    applyResolved(await api.sapResolve(value));
  });

  systemSelect.addEventListener("change", () => {
    if (!systemSelect.value) return;
    systemInput.value = systemSelect.value;
    resolveSystem(systemSelect.value);
  });

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
      field("分类", categorySelect, "SAP 账号会参与全局配置同步与文件扫描"),
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
            h(
              "span",
              null,
              `使用全局 Knox ID（${state.vault?.knoxId || "未设置"}）`,
            ),
          ),
        ),
      ),
      field("密码", h("div", { class: "input-group" }, passwordInput, revealButton), editing ? "留空表示保留原密码" : null),
    ),
    passwordMeter,
    sapSection,
    generatorPanel(
      () => password.value,
      (value) => {
        password.value = value;
        passwordInput.value = value;
        passwordInput.type = "text";
        updateMeter(passwordMeter, value);
      },
    ),
    h(
      "div",
      { class: "form__grid" },
      field(
        "链接 / URL",
        h("input", {
          class: "input",
          value: draft.url,
          placeholder: "可选",
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
    } else {
      const generated = await api.generatePassword({
        length: 16,
        upper: true,
        lower: true,
        digits: true,
        symbols: true,
        avoidAmbiguous: false,
        maxLength: 40,
      });
      password.value = generated;
      passwordInput.value = generated;
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
            onClick: guard(async () => {
              if (!draft.title.trim()) {
                toast("请先填写标题", "error");
                return;
              }
              const saved = await saveEntry({
                id: draft.id,
                title: draft.title,
                categoryId: draft.categoryId,
                username: draft.username,
                useKnoxId: draft.useKnoxId,
                password: password.value,
                url: draft.url,
                notes: draft.notes,
                favorite: draft.favorite,
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
              });
              close();
              toast(editing ? "已保存修改" : "已创建条目", "success");
              onSaved?.(saved);
            }),
          },
          icon("check", { size: 15 }),
          "保存",
        ),
      ),
  });
}
