import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import { state, createVault, unlock, saveSettings } from "../state.js";
import { toast } from "../toast.js";

let draft = { mode: "password", password: "", confirm: "", hint: "", show: false };

function strengthMeter(container, password) {
  if (!container) return;
  api
    .strength(password)
    .then((report) => {
      container.dataset.score = String(report.score);
      const bars = container.querySelectorAll(".strength__bar");
      bars.forEach((bar, index) => bar.classList.toggle("is-on", index < report.score));
      const label = container.querySelector(".strength__label");
      if (label) {
        label.textContent = report.entropyBits
          ? `${report.label} · ${Math.round(report.entropyBits)} bit`
          : report.label;
      }
    })
    .catch(() => {});
}

function createForm() {
  const meter = h(
    "div",
    { class: "strength", dataset: { score: "0" } },
    h(
      "div",
      { class: "strength__track" },
      ...[0, 1, 2, 3, 4].map(() => h("div", { class: "strength__bar" })),
    ),
    h("span", { class: "strength__label" }, "强度"),
  );

  const passwordInput = h("input", {
    id: "lock-password",
    class: "input",
    type: "password",
    placeholder: "至少 8 个字符",
    autocomplete: "new-password",
    onInput: (event) => {
      draft.password = event.target.value;
      strengthMeter(meter, draft.password);
    },
  });
  const confirmInput = h("input", {
    id: "lock-confirm",
    class: "input",
    type: "password",
    placeholder: "再次输入",
    autocomplete: "new-password",
    onInput: (event) => {
      draft.confirm = event.target.value;
    },
  });
  const hintInput = h("input", {
    id: "lock-hint",
    class: "input",
    placeholder: "例如：公司域密码（仅本地保存明文提示）",
    onInput: (event) => {
      draft.hint = event.target.value;
    },
  });

  const submit = guard(async () => {
    if (draft.password !== draft.confirm) {
      toast("两次输入的主密码不一致", "error");
      return;
    }
    if (draft.mode === "password" && draft.password.length < 8) {
      toast("主密码至少需要 8 个字符", "error");
      return;
    }
    await createVault(draft.mode, draft.password, draft.hint);
    draft = { mode: "password", password: "", confirm: "", hint: "", show: false };
  });

  const panel = h(
    "div",
    { class: "form" },
    h(
      "div",
      { class: "form__row" },
      h("label", { class: "form__label" }, "解锁方式"),
      h(
        "div",
        { class: "segmented" },
        h(
          "button",
          {
            class: "segmented__item is-active",
            type: "button",
            dataset: { mode: "password" },
            onClick: (event) => {
              draft.mode = "password";
              panel.querySelectorAll(".segmented__item").forEach((item) => {
                item.classList.toggle("is-active", item.dataset.mode === "password");
              });
              fields.hidden = false;
            },
          },
          icon("key", { size: 14 }),
          "主密码",
        ),
        h(
          "button",
          {
            class: "segmented__item",
            type: "button",
            dataset: { mode: "windows" },
            onClick: (event) => {
              draft.mode = "windows";
              panel.querySelectorAll(".segmented__item").forEach((item) => {
                item.classList.toggle("is-active", item.dataset.mode === "windows");
              });
              fields.hidden = true;
            },
          },
          icon("shield", { size: 14 }),
          "仅本机账户",
        ),
      ),
      h(
        "p",
        { class: "form__hint" },
        "主密码模式使用 Argon2id 派生密钥；仅本机账户模式把随机密钥交给 Windows DPAPI 保管，无需记忆密码。",
      ),
    ),
    h(
      "div",
      { class: "form__row", id: "lock-fields" },
      h("label", { class: "form__label" }, "主密码"),
      passwordInput,
      meter,
      h("label", { class: "form__label" }, "确认主密码"),
      confirmInput,
      h("label", { class: "form__label" }, "提示（可选）"),
      hintInput,
    ),
    h(
      "div",
      { class: "form__row" },
      h(
        "label",
        { class: "checkbox" },
        h("input", {
          type: "checkbox",
          checked: state.settings?.confirmDelete ?? true,
          onChange: (event) => {
            saveSettings({ confirmDelete: event.target.checked }).catch(() => {});
          },
        }),
        h("span", null, "删除条目时二次确认"),
      ),
    ),
  );

  const fields = panel.querySelector("#lock-fields");

  const form = h(
    "form",
    {
      class: "form",
      onSubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    panel,
    h(
      "button",
      { class: "btn btn--primary btn--lg btn--block", type: "submit" },
      icon("shield", { size: 16 }),
      "创建保险库",
    ),
  );
  setTimeout(() => passwordInput.focus(), 0);
  return form;
}

function unlockForm() {
  const isWindows = state.mode === "windows";
  let password = "";
  const input = h("input", {
    id: "lock-unlock-password",
    class: "input",
    type: "password",
    placeholder: "输入主密码",
    autocomplete: "current-password",
    onInput: (event) => {
      password = event.target.value;
    },
  });

  const submit = guard(async () => {
    await unlock(isWindows ? null : password);
    password = "";
  });

  const form = h(
    "form",
    {
      class: "form",
      onSubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    isWindows ? null : input,
    state.hint
      ? h(
          "div",
          { class: "lock__hint" },
          icon("info", { size: 14 }),
          h("span", null, `提示：${state.hint}`),
        )
      : null,
    h(
      "button",
      { class: "btn btn--primary btn--lg btn--block", type: "submit" },
      icon(isWindows ? "shield" : "key", { size: 16 }),
      isWindows ? "使用 Windows 账户解锁" : "解锁",
    ),
  );
  if (!isWindows) setTimeout(() => input.focus(), 0);
  return form;
}

/** Renders the whole lock screen. Called whenever the shell decides the vault
 *  is closed, so it is also the first-run setup screen. */
export function renderLock(container) {
  const card = h(
    "div",
    { class: "lock__card" },
    h(
      "div",
      { class: "lock__head" },
      h("div", { class: "lock__logo" }, icon("key", { size: 26 })),
      h("h1", { class: "lock__title" }, state.hasVault ? "解锁 SapVault" : "创建 SapVault"),
      h(
        "p",
        { class: "lock__sub" },
        state.hasVault
          ? "所有数据只保存在这台电脑上，不会上传到任何服务器。"
          : "首次使用需要创建一个本地保险库，用于加密保存所有密码。",
      ),
    ),
    state.startupError
      ? h(
          "div",
          { class: "banner banner--danger" },
          h("span", { class: "banner__icon" }, icon("alert", { size: 16 })),
          h(
            "div",
            { class: "banner__body" },
            h("span", { class: "banner__title" }, "保险库无法读取"),
            h("span", null, state.startupError),
            h(
              "span",
              { class: "form__hint" },
              "请先备份数据目录中的 vault.sapvault 文件，再决定是否重建保险库。",
            ),
          ),
        )
      : null,
    state.hasVault ? unlockForm() : createForm(),
    h(
      "div",
      { class: "lock__footer" },
      h("span", null, `v${state.version ?? ""} · 完全本地`),
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          onClick: guard(async () => {
            const path = state.paths?.dataDir;
            if (path) await api.openPath(path);
          }),
        },
        icon("folder", { size: 13 }),
        "数据目录",
      ),
    ),
  );

  mount(container, h("div", { class: "lock" }, card));
}
