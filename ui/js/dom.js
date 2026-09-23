/** Tiny DOM helpers. Everything renders through these, so no view needs to
 *  touch innerHTML and no user-supplied string can ever become markup. */

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "html") el.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) el.setAttribute(key, "");
      // `<textarea>` has no `value` content attribute: `setAttribute("value", …)`
      // leaves the box empty (and the next save then wipes what was there, which
      // is how the notes field lost its text). Assign the property instead.
      else if (key === "value" && "value" in el) el.value = String(value);
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/** Optional slot: renders nothing (not even the wrapper) for empty input. */
export function when(condition, factory) {
  return condition ? factory() : null;
}

/** Wraps a promise-returning handler so a rejected call cannot break the view. */
export function guard(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      const message =
        typeof error === "string" ? error : error?.message ?? String(error);
      const { toast } = await import("./toast.js");
      toast(message, "error");
    }
  };
}

export function debounce(fn, wait = 160) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}
