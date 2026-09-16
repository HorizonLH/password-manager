/** Single-source icon set: every icon is one SVG recoloured through
 *  currentColor, with a filled variant reserved for the active state. */

const PATHS = {
  // A key that stays readable at 11 px: ring with a hole, straight shaft and
  // two teeth on the lower edge, drawn on the same 24 px grid as the rest.
  key: {
    outline: [
      "M6.6 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z",
      "M6.6 10.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
      "M10.4 12H19a1.2 1.2 0 0 1 1.2 1.2V15",
      "M16.9 12v2.2",
    ],
    solid: [
      "M6.6 7.9a4.1 4.1 0 1 0 0 8.2 4.1 4.1 0 0 0 0-8.2Zm0 2.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
      "M10.4 10.9h9.6a1.2 1.2 0 0 1 1.2 1.2v1.3a1.2 1.2 0 0 1-1.2 1.2h-9.6a1.2 1.2 0 0 1-1.2-1.2v-1.3a1.2 1.2 0 0 1 1.2-1.2Z",
      "M16.1 13.4h1.6v2.1h-1.6z",
      "M19 13.4h1.6v2.6H19z",
    ],
  },

  server: {
    outline: ["M4 4.5h16v5H4z", "M4 14.5h16v5H4z", "M7.5 7h.01", "M7.5 17h.01"],
    solid: [
      "M3.5 4h17a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 10.4h17a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-3.6a1 1 0 0 1 1-1Z",
    ],
  },
  link: {
    outline: [
      "M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5",
      "M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5l1.5-1.5",
    ],
    solid: [
      "M9.3 6.4 10.7 5a4.5 4.5 0 1 1 6.4 6.4L15.7 12.8 9.3 6.4Z",
      "M14.7 17.6 13.3 19a4.5 4.5 0 0 1-6.4-6.4l1.4-1.4 6.4 6.4Z",
    ],
  },
  radar: {
    outline: [
      "M12 3a9 9 0 1 0 9 9",
      "M12 7.5a4.5 4.5 0 1 0 4.5 4.5",
      "M12 12 17 7",
      "M12 11.2h.01",
    ],
    solid: [
      "M12 2.5a9.5 9.5 0 1 0 9.5 9.5h-2.2A7.3 7.3 0 1 1 12 4.7Z",
      "M12 7a5 5 0 1 1-5 5h2.1A2.9 2.9 0 1 0 12 9.1Z",
      "M13 11 18.2 5.8l1.4 1.4L14.4 12.4Z",
    ],
  },
  refresh: {
    outline: ["M20.5 12a8.5 8.5 0 1 1-2.5-6", "M20.5 4.5V10h-5.5"],
  },
  sliders: {
    outline: ["M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9", "M15 4.8v4.4", "M9 14.8v4.4"],
    solid: [
      "M14.2 4.2a1.3 1.3 0 0 1 1.3 1.3v3.6a1.3 1.3 0 0 1-1.3 1.3h-.6a1.3 1.3 0 0 1-1.3-1.3V5.5a1.3 1.3 0 0 1 1.3-1.3Z",
      "M8.2 13.6a1.3 1.3 0 0 1 1.3 1.3v3.6a1.3 1.3 0 0 1-1.3 1.3h-.6a1.3 1.3 0 0 1-1.3-1.3v-3.6a1.3 1.3 0 0 1 1.3-1.3Z",
      "M3 6.4h9.3v1.6H3zM17 6.4h4v1.6h-4zM3 16.4h2.6v1.6H3zM10 16.4h11v1.6H10z",
    ],
  },
  lock: {
    outline: ["M5 10.5h14v9.5H5z", "M8 10.5V7.5a4 4 0 0 1 8 0v3", "M12 14.5v2.5"],
    solid: [
      "M5 10h14a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1Zm3-2.5a4 4 0 0 1 8 0V9h-1.8V7.5a2.2 2.2 0 0 0-4.4 0V9H8Z",
    ],
  },
  shield: {
    outline: [
      "M12 3l7 2.8v5.4c0 4.3-2.9 7.9-7 9.3-4.1-1.4-7-5-7-9.3V5.8z",
      "M9.2 12l2 2 3.6-3.8",
    ],
  },
  eye: {
    outline: [
      "M2.5 12S6.2 6.5 12 6.5 21.5 12 21.5 12 17.8 17.5 12 17.5 2.5 12 2.5 12z",
      "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
    ],
  },
  eyeOff: {
    outline: [
      "M9.8 6.9A9.6 9.6 0 0 1 12 6.5c5.8 0 9.5 5.5 9.5 5.5a17 17 0 0 1-3.4 3.7",
      "M6.4 8.3A17 17 0 0 0 2.5 12S6.2 17.5 12 17.5c1.2 0 2.3-.2 3.2-.6",
      "M4 4l16 16",
    ],
  },
  copy: { outline: ["M9.5 9.5h9v9h-9z", "M6 15H4.5V4.5H15V6"] },
  check: { outline: ["M5 12.8l4.6 4.6L19 6.5"] },
  checkCircle: {
    outline: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8.2 12.4l2.6 2.6 5-5.2"],
  },
  closeCircle: {
    outline: [
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      "M9.2 9.2l5.6 5.6",
      "M14.8 9.2l-5.6 5.6",
    ],
  },
  plus: { outline: ["M12 5.5v13", "M5.5 12h13"] },
  trash: { outline: ["M4.5 7h15", "M9.5 7V4.5h5V7", "M6.5 7l1 13h9l1-13"] },
  pencil: { outline: ["M4 20h4L19 9l-4-4L4 16z", "M14.5 5.5l4 4"] },
  folder: {
    outline: [
      "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z",
    ],
  },
  file: { outline: ["M6.5 3.5h6.8l4.2 4.2v12.8h-11z", "M13 3.5v4.5h4.5"] },
  external: {
    outline: [
      "M14 4h6v6",
      "M20 4l-8.5 8.5",
      "M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h4.5",
    ],
  },
  chevronRight: { outline: ["M9.5 5.5l6.5 6.5-6.5 6.5"] },
  chevronDown: { outline: ["M5.5 9.5l6.5 6.5 6.5-6.5"] },
  x: { outline: ["M6 6l12 12", "M18 6L6 18"] },
  alert: { outline: ["M12 3.5l9 17H3z", "M12 9.5v4.5", "M12 17.2h.01"] },
  info: {
    outline: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5.5", "M12 7.8h.01"],
  },
  sparkle: {
    outline: [
      "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z",
      "M18.5 3v3",
      "M17 4.5h3",
    ],
  },
  sun: {
    outline: [
      "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z",
      "M12 2.5v2",
      "M12 19.5v2",
      "M2.5 12h2",
      "M19.5 12h2",
      "M5.2 5.2l1.4 1.4",
      "M17.4 17.4l1.4 1.4",
      "M18.8 5.2l-1.4 1.4",
      "M6.6 17.4l-1.4 1.4",
    ],
  },
  moon: { outline: ["M20.5 14.8A8.8 8.8 0 0 1 9.2 3.5a8.8 8.8 0 1 0 11.3 11.3z"] },
  monitor: { outline: ["M3.5 4.5h17v11h-17z", "M9 19.5h6", "M12 15.5v4"] },
  star: {
    outline: [
      "M12 4l2.4 5 5.6.8-4.1 4 1 5.5-4.9-2.7-4.9 2.7 1-5.5-4.1-4 5.6-.8z",
    ],
    solid: [
      "M12 3.4l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.9-5.2 2.9 1-5.9L3.5 9.6l5.9-.8z",
    ],
  },
  user: {
    outline: [
      "M12 4.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
      "M4.5 20a7.5 7.5 0 0 1 15 0",
    ],
  },
  clock: {
    outline: [
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      "M12 7.5V12l3.2 2",
    ],
  },
  stop: { outline: ["M7 7h10v10H7z"] },
  drive: {
    outline: [
      "M3.5 13h17v5.5h-17z",
      "M3.5 13l2.4-7h12.2l2.4 7",
      "M6.8 15.8h.01",
    ],
  },
  download: { outline: ["M12 4v10", "M8 11l4 4 4-4", "M5 19.5h14"] },
  upload: { outline: ["M12 20V10", "M8 13l4-4 4 4", "M5 4.5h14"] },
  power: { outline: ["M12 4v7", "M7 7.2a7 7 0 1 0 10 0"] },
  filter: { outline: ["M4 5.5h16l-6.2 7.2v5.8L10.2 20v-7.3z"] },
  save: {
    outline: [
      "M5 4.5h11l3 3v12H5z",
      "M8.5 4.5v5h7v-5",
      "M8.5 19.5v-5h7v5",
    ],
  },
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** Builds an icon element. `solid` falls back to the outline when a filled
 *  variant does not exist, so callers never have to check. */
export function icon(name, options = {}) {
  const spec = PATHS[name] ?? PATHS.info;
  const solid = Boolean(options.solid) && Array.isArray(spec.solid);
  const paths = solid ? spec.solid : spec.outline;
  const size = options.size ?? 16;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (options.class) svg.setAttribute("class", options.class);
  if (solid) {
    svg.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(options.stroke ?? 1.5));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    if (solid) path.setAttribute("fill-rule", "evenodd");
    svg.append(path);
  }
  return svg;
}

/** Nav rows swap outline to solid when active, so both variants live in the DOM
 *  and CSS decides which one is displayed. */
export function iconPair(name, size = 16) {
  const wrap = document.createElementNS(SVG_NS, "svg");
  wrap.setAttribute("width", String(size));
  wrap.setAttribute("height", String(size));
  wrap.setAttribute("viewBox", "0 0 24 24");
  wrap.setAttribute("aria-hidden", "true");
  wrap.setAttribute("focusable", "false");
  wrap.setAttribute("fill", "currentColor");
  wrap.append(
    icon(name, { size, class: "icon-outline" }),
    icon(name, { size, solid: true, class: "icon-solid" }),
  );
  return wrap;
}

export const ICON_NAMES = Object.keys(PATHS);
