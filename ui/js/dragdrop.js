/** Upload by drag and drop.
 *
 *  On Windows the webview hands file drops to Tauri instead of the DOM
 *  (`dragDropEnabled`, on by default), so the window events are the real path.
 *  The DOM listeners below are the fallback for the browser-based UI audit,
 *  where a drop has no real file path to hand over. */

import { listen } from "./api.js";
import { setState, state } from "./state.js";

let installed = false;

/** `active()` decides whether drops are welcome right now, `onDrop(paths)`
 *  receives the dropped file paths. */
export function installFileDrop({ active, onDrop }) {
  if (installed) return;
  installed = true;

  const show = (next) => {
    if (state.dragActive !== next) setState({ dragActive: next });
  };

  const accept = (paths) => {
    show(false);
    if (!active()) return;
    const unique = [...new Set(paths.filter(Boolean))];
    if (unique.length) onDrop(unique);
  };

  const wire = (name, handler) => {
    try {
      listen(name, handler).catch(() => {});
    } catch {
      // No Tauri bridge; the DOM fallback below still drives the overlay.
    }
  };

  wire("tauri://drag-enter", () => {
    if (active()) show(true);
  });
  wire("tauri://drag-over", () => {
    if (active()) show(true);
  });
  wire("tauri://drag-leave", () => show(false));
  wire("tauri://drag-drop", (event) => accept(event?.payload?.paths ?? []));

  const isFileDrag = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  let depth = 0;

  window.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth += 1;
    if (active()) show(true);
  });
  window.addEventListener("dragover", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener("drop", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    // Browsers expose File objects without a path, so a DOM drop only clears
    // the overlay; the desktop build arrives through the Tauri event above.
    accept(
      Array.from(event.dataTransfer?.files ?? [])
        .map((file) => file.path)
        .filter(Boolean),
    );
  });
}
