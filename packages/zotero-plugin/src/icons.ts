// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Toolbar icons: inlined SVG geometry from Lucide (https://lucide.dev, ISC License; portions Feather, MIT --
 * see THIRD_PARTY_NOTICES.md). 24x24 viewBox, 2px round strokes, `currentColor` so they follow the theme.
 * Each icon is a list of [tag, attributes] shapes.
 */

type Shape = [tag: "path" | "circle" | "line" | "rect" | "polyline", attrs: Record<string, string | number>];

export const ICONS = {
  "panel-left": [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ["path", { d: "M9 3v18" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  "chevron-up": [["path", { d: "m18 15-6-6-6 6" }]],
  "chevrons-down-up": [["path", { d: "m7 20 5-5 5 5" }], ["path", { d: "m7 4 5 5 5-5" }]],
  "chevrons-up-down": [["path", { d: "m7 15 5 5 5-5" }], ["path", { d: "m7 9 5-5 5 5" }]],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  minus: [["path", { d: "M5 12h14" }]],
  "move-horizontal": [["polyline", { points: "18 8 22 12 18 16" }], ["polyline", { points: "6 8 2 12 6 16" }], ["line", { x1: 2, x2: 22, y1: 12, y2: 12 }]],
  maximize: [["path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }], ["path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }], ["path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }], ["path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" }]],
  search: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", { d: "m21 21-4.3-4.3" }]],
  highlighter: [["path", { d: "m9 11-6 6v3h9l3-3" }], ["path", { d: "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" }]],
  underline: [["path", { d: "M6 4v6a6 6 0 0 0 12 0V4" }], ["line", { x1: 4, x2: 20, y1: 20, y2: 20 }]],
  "sticky-note": [["path", { d: "M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" }], ["path", { d: "M15 3v6h6" }]],
  copy: [["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
  trash: [["path", { d: "M3 6h18" }], ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }], ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }], ["line", { x1: 10, x2: 10, y1: 11, y2: 17 }], ["line", { x1: 14, x2: 14, y1: 11, y2: 17 }]],
  "rotate-cw": [["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }]],
  "rotate-ccw": [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2" }], ["path", { d: "M12 20v2" }], ["path", { d: "m4.93 4.93 1.41 1.41" }], ["path", { d: "m17.66 17.66 1.41 1.41" }], ["path", { d: "M2 12h2" }], ["path", { d: "M20 12h2" }], ["path", { d: "m6.34 17.66-1.41 1.41" }], ["path", { d: "m19.07 4.93-1.41 1.41" }]],
  moon: [["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }]],
  "arrow-left": [["path", { d: "m12 19-7-7 7-7" }], ["path", { d: "M19 12H5" }]],
  "book-open": [["path", { d: "M12 7v14" }], ["path", { d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" }]],
  "box-select": [["path", { d: "M5 3a2 2 0 0 0-2 2" }], ["path", { d: "M19 3a2 2 0 0 1 2 2" }], ["path", { d: "M21 19a2 2 0 0 1-2 2" }], ["path", { d: "M5 21a2 2 0 0 1-2-2" }], ["path", { d: "M9 3h1" }], ["path", { d: "M9 21h1" }], ["path", { d: "M14 3h1" }], ["path", { d: "M14 21h1" }], ["path", { d: "M3 9v1" }], ["path", { d: "M21 9v1" }], ["path", { d: "M3 14v1" }], ["path", { d: "M21 14v1" }]],
  crop: [["path", { d: "M6 2v14a2 2 0 0 0 2 2h14" }], ["path", { d: "M18 22V8a2 2 0 0 0-2-2H2" }]],
  download: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["polyline", { points: "7 10 12 15 17 10" }], ["line", { x1: 12, x2: 12, y1: 15, y2: 3 }]],
  printer: [["path", { d: "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" }], ["path", { d: "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" }], ["rect", { x: 6, y: 14, width: 12, height: 8, rx: 1 }]],
  list: [["path", { d: "M3 12h.01" }], ["path", { d: "M3 18h.01" }], ["path", { d: "M3 6h.01" }], ["path", { d: "M8 12h13" }], ["path", { d: "M8 18h13" }], ["path", { d: "M8 6h13" }]],
  "layout-grid": [["rect", { width: 7, height: 7, x: 3, y: 3, rx: 1 }], ["rect", { width: 7, height: 7, x: 14, y: 3, rx: 1 }], ["rect", { width: 7, height: 7, x: 14, y: 14, rx: 1 }], ["rect", { width: 7, height: 7, x: 3, y: 14, rx: 1 }]],
  image: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ["circle", { cx: 9, cy: 9, r: 2 }], ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }]],
  "message-square": [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  more: [["circle", { cx: 12, cy: 12, r: 1 }], ["circle", { cx: 19, cy: 12, r: 1 }], ["circle", { cx: 5, cy: 12, r: 1 }]],
  x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  "external-link": [["path", { d: "M15 3h6v6" }], ["path", { d: "M10 14 21 3" }], ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]],
  quote: [["path", { d: "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" }], ["path", { d: "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" }]],
  "file-text": [["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }], ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }], ["path", { d: "M10 9H8" }], ["path", { d: "M16 13H8" }], ["path", { d: "M16 17H8" }]],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Builds the `<svg>` element for an icon (size in px). */
export function createIcon(doc: Document, name: IconName, size = 16): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of ICONS[name] as Shape[]) {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

/** Static markup for an icon, used by the icon gallery page and tests. */
export function iconMarkup(name: IconName, size = 24): string {
  const shapes = (ICONS[name] as Shape[])
    .map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
    .join("");
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
}

/** The Zotero Glide product icon (same artwork as addon/content/icons/zotero-glide.svg): open book with text lines and a tinted right page. Shown in the reader's toolbar so it is clear this is the plugin. */
export function createGlideMark(doc: Document, size = 16): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const tint = doc.createElementNS(NS, "path");
  tint.setAttribute("d", "M232,56L232,200L160,200C142.445,200 128,214.445 128,232L128,88C128,70.445 142.445,56 160,56L232,56Z");
  tint.setAttribute("fill", "rgb(204,41,54)");
  tint.setAttribute("fill-opacity", "0.2");
  const path = doc.createElementNS(NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M232,48L160,48C147.419,48 135.548,53.935 128,64C120.452,53.935 108.581,48 96,48L24,48C19.611,48 16,51.611 16,56L16,200C16,204.389 19.611,208 24,208L96,208C109.166,208 120,218.834 120,232C120,236.389 123.611,240 128,240C132.389,240 136,236.389 136,232C136,218.834 146.834,208 160,208L232,208C236.389,208 240,204.389 240,200L240,56C240,51.611 236.389,48 232,48ZM96,192L32,192L32,64L96,64C109.166,64 120,74.834 120,88L120,200C113.084,194.796 104.656,191.986 96,192ZM224,192L160,192C151.344,191.986 142.916,194.796 136,200L136,88C136,74.834 146.834,64 160,64L224,64L224,192ZM160,88L200,88C204.389,88 208,91.611 208,96C208,100.389 204.389,104 200,104L160,104C155.611,104 152,100.389 152,96C152,91.611 155.611,88 160,88ZM208,128C208,132.389 204.389,136 200,136L160,136C155.611,136 152,132.389 152,128C152,123.611 155.611,120 160,120L200,120C204.389,120 208,123.611 208,128ZM208,160C208,164.389 204.389,168 200,168L160,168C155.611,168 152,164.389 152,160C152,155.611 155.611,152 160,152L200,152C204.389,152 208,155.611 208,160Z");
  path.setAttribute("fill-rule", "nonzero");
  svg.append(tint, path);
  return svg;
}
