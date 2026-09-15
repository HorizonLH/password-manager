/** Theme resolution. Settings store `system | light | dark`, while the DOM only
 *  ever sees a concrete `light` or `dark`, so each token needs one rule. */

const query = window.matchMedia("(prefers-color-scheme: dark)");
let mode = "system";
let listener = null;

function resolve() {
  return mode === "system" ? (query.matches ? "dark" : "light") : mode;
}

function apply() {
  document.documentElement.dataset.theme = resolve();
}

export function setTheme(next) {
  mode = next === "light" || next === "dark" ? next : "system";
  apply();
  listener?.(mode, resolve());
}

export function currentTheme() {
  return mode;
}

export function resolvedTheme() {
  return resolve();
}

export function onThemeChange(handler) {
  listener = handler;
}

query.addEventListener("change", () => {
  if (mode === "system") {
    apply();
    listener?.(mode, resolve());
  }
});

apply();
