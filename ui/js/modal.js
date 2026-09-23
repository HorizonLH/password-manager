import { h, mount } from "./dom.js";
import { icon } from "./icons.js";

const root = () => document.getElementById("modal-root");

let activeClose = null;
/** Where focus returns when the modal closes. Recorded on the first open, so a
 *  dialog opened from inside another one still restores to the original
 *  trigger (the inner dialog replaces the outer one in the host). */
let restoreFocusTo = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `display:none` subtrees (collapsed editor sections) have no client rects, so
 *  they are skipped even though they still match the selector above. */
const focusables = (panel) =>
  [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.getClientRects().length > 0);

/** Opens the shared modal shell. `render` returns the body node. */
export function openModal({ title, render, footer, size = "default", onClose }) {
  const host = root();
  if (!host) return () => {};
  const slot = h("div", { class: "modal__body" });
  if (!restoreFocusTo) restoreFocusTo = document.activeElement;

  const close = () => {
    host.hidden = true;
    mount(host);
    document.removeEventListener("keydown", keyHandler);
    activeClose = null;
    const target = restoreFocusTo;
    restoreFocusTo = null;
    // Back to whatever opened the dialog: the keyboard keeps its place instead
    // of falling back to <body>.
    if (target && target.isConnected && typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
    onClose?.();
  };

  const widthClass =
    size === "wide" ? " modal--wide" : size === "narrow" ? " modal--narrow" : "";

  const panel = h(
    "div",
    { class: `modal${widthClass}`, role: "dialog", "aria-modal": "true", tabindex: "-1" },
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
      return;
    }
    // Focus trap: Tab cycles inside the dialog instead of walking into the
    // page behind it.
    if (event.key === "Tab") {
      const list = focusables(panel);
      if (!list.length) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (!panel.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  host.replaceChildren(panel);
  host.hidden = false;
  host.onclick = (event) => {
    if (event.target === host) close();
  };
  mount(slot, render(close));
  document.addEventListener("keydown", keyHandler);
  if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
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

/**
 * Ask for one value with the app's own modal.
 *
 * `window.prompt` is a system dialog: it ignores the app theme, cannot show a
 * retry hint and cannot be styled, which is why importing an encrypted vault
 * looked like a different program. Here `onSubmit` is awaited while the dialog
 * stays open, so a rejected value (wrong master password) shows its message and
 * the user corrects it in place instead of starting over.
 *
 * @param {object}   config
 * @param {Function} config.onSubmit receives the value; throwing keeps the
 *                                   dialog open and displays the message
 */
export function promptModal({
  title,
  label,
  value = "",
  placeholder = "",
  hint = "",
  type = "text",
  trim = true,
  submitLabel = "保存",
  cancelLabel = "取消",
  onSubmit,
}) {
  const input = h("input", { class: "input", type, value, placeholder });
  const problem = h("p", { class: "form__hint form__hint--danger", hidden: true });
  const submitButton = h("button", { class: "btn btn--primary", type: "button" }, submitLabel);
  let busy = false;
  let close = () => {};

  async function submit() {
    if (busy) return;
    busy = true;
    submitButton.disabled = true;
    problem.hidden = true;
    try {
      await onSubmit?.(trim ? input.value.trim() : input.value);
      busy = false;
      submitButton.disabled = false;
      close();
    } catch (error) {
      busy = false;
      submitButton.disabled = false;
      problem.textContent =
        typeof error === "string" ? error : error?.message ?? String(error);
      problem.hidden = false;
      input.focus();
      input.select();
    }
  }

  submitButton.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  });

  close = openModal({
    title,
    size: "narrow",
    render: () =>
      h(
        "div",
        { class: "stack stack--tight" },
        h("div", { class: "form__row" }, h("label", { class: "form__label" }, label), input),
        hint ? h("p", { class: "form__hint" }, hint) : null,
        problem,
      ),
    footer: () =>
      h(
        "div",
        { class: "modal__actions" },
        h("button", { class: "btn btn--ghost", type: "button", onClick: () => close() }, cancelLabel),
        submitButton,
      ),
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}
