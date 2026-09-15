import { h, mount } from "./dom.js";
import { icon } from "./icons.js";

const root = () => document.getElementById("modal-root");

let activeClose = null;

/** Opens the shared modal shell. `render` returns the body node. */
export function openModal({ title, render, footer, size = "default", onClose }) {
  const host = root();
  if (!host) return () => {};
  const slot = h("div", { class: "modal__body" });

  const close = () => {
    host.hidden = true;
    mount(host);
    document.removeEventListener("keydown", keyHandler);
    activeClose = null;
    onClose?.();
  };

  const widthClass =
    size === "wide" ? " modal--wide" : size === "narrow" ? " modal--narrow" : "";

  const panel = h(
    "div",
    { class: `modal${widthClass}`, role: "dialog", "aria-modal": "true" },
    h(
      "div",
      { class: "modal__header" },
      h("h2", { class: "modal__title" }, title),
      h(
        "button",
        { class: "btn btn--icon", type: "button", "aria-label": "关闭", onClick: close },
        icon("x", { size: 15 }),
      ),
    ),
    slot,
    footer ? h("div", { class: "modal__footer" }, footer(close)) : null,
  );

  function keyHandler(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  host.replaceChildren(panel);
  host.hidden = false;
  host.onclick = (event) => {
    if (event.target === host) close();
  };
  mount(slot, render(close));
  document.addEventListener("keydown", keyHandler);
  activeClose = close;
  return close;
}

export function closeModal() {
  activeClose?.();
}

export function isModalOpen() {
  const host = root();
  return Boolean(host && !host.hidden);
}

export function confirmModal({
  title,
  message,
  detail,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
}) {
  openModal({
    title,
    size: "narrow",
    render: () =>
      h(
        "div",
        { class: "stack" },
        h("p", { style: { margin: "0" } }, message),
        detail ? h("p", { class: "form__hint" }, detail) : null,
      ),
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "8px", width: "100%", justifyContent: "flex-end" } },
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, cancelLabel),
        h(
          "button",
          {
            class: danger ? "btn btn--danger-solid" : "btn btn--primary",
            type: "button",
            onClick: async () => {
              close();
              await onConfirm?.();
            },
          },
          confirmLabel,
        ),
      ),
  });
}

export function promptModal({ title, label, value = "", placeholder = "", onSubmit }) {
  const input = h("input", { class: "input", value, placeholder });
  const submit = async (close) => {
    const next = input.value.trim();
    close();
    await onSubmit(next);
  };
  openModal({
    title,
    size: "narrow",
    render: () =>
      h(
        "div",
        { class: "form__row" },
        h("label", { class: "form__label" }, label),
        input,
      ),
    footer: (close) =>
      h(
        "div",
        { style: { display: "flex", gap: "8px", width: "100%", justifyContent: "flex-end" } },
        h("button", { class: "btn btn--ghost", type: "button", onClick: close }, "取消"),
        h(
          "button",
          { class: "btn btn--primary", type: "button", onClick: () => submit(close) },
          "保存",
        ),
      ),
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const close = activeClose;
      close?.();
      onSubmit(input.value.trim());
    }
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}
