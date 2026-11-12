// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReaderView, type MenuItem } from "../src/tabView.ts";

/** Only the DOM surface used by sidebar figures and menus; no browser globals. */
class ElementStub extends EventTarget {
  children: ElementStub[] = [];
  className = "";
  textContent = "";
  disabled = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  offsetWidth = 240;
  offsetHeight = 100;
  classList = {
    add: (name: string) => { this.className += ` ${name}`; },
    remove: (name: string) => { this.className = this.className.split(" ").filter((c) => c !== name).join(" "); },
  };
  readonly tagName: string;
  constructor(tagName: string) { super(); this.tagName = tagName; }
  append(...children: ElementStub[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementStub[]): void { this.children = children; }
  setAttribute(): void {}
  getBoundingClientRect() { return { left: 100, top: 50, right: 1100, bottom: 850, width: 1000, height: 800 }; }
}

function fixture() {
  const popup = new ElementStub("div");
  const sideBody = new ElementStub("div");
  // Exercise the real view methods without constructing the unrelated toolbar,
  // page canvases or ResizeObserver, which need a full browser window.
  const view = Object.assign(Object.create(ReaderView.prototype), {
    doc: {
      createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
      createTextNode: (text: string) => Object.assign(new ElementStub("#text"), { textContent: text }),
    },
    root: new ElementStub("div"), popup, sideBody,
  }) as ReaderView;
  return { view, popup, sideBody };
}

function label(element: ElementStub): string {
  return element.textContent + element.children.map(label).join("");
}

test("pointer menus open without a global DOMRect and run the selected action", () => {
  assert.equal(typeof globalThis.DOMRect, "undefined", "match Zotero's non-window plugin scope");
  const { view, popup } = fixture();
  const actions: string[] = [];
  const items: MenuItem[] = [
    { label: "Copy image", icon: "copy", run: () => { actions.push("copy"); } },
    { label: "Save image as…", icon: "download", run: () => { actions.push("save"); } },
  ];

  view.showMenuAt(180, 200, items);
  assert.equal(view.popupOpen, true);
  assert.deepEqual(popup.children.map(label), ["Copy image", "Save image as…"]);
  assert.equal(popup.style.left, "80px");
  assert.equal(popup.style.top, "150px");
  popup.children[0]!.dispatchEvent(new Event("click"));
  assert.deepEqual(actions, ["copy"]);
  assert.equal(view.popupOpen, false);

  view.showMenuAt(180, 200, items);
  popup.children[1]!.dispatchEvent(new Event("click"));
  assert.deepEqual(actions, ["copy", "save"]);
});

test("right-clicking a sidebar figure opens actions for that single figure", () => {
  const { view, popup, sideBody } = fixture();
  const selected: number[] = [];
  let navigated = false;
  view.renderFigures([{ page: 0, aspect: 1 }, { page: 2, aspect: 0.5 }], () => { navigated = true; }, (i, x, y) => {
    view.showMenuAt(x, y, [{ label: "Save image as…", run: () => { selected.push(i); } }]);
  });
  view.setFigureImage(1, "blob:second-figure");
  const figures = sideBody.children[0]!.children.filter((e) => e.className === "fr-fig");
  const event = Object.assign(new Event("contextmenu", { cancelable: true }), { clientX: 180, clientY: 200 });
  figures[1]!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(view.popupOpen, true);
  assert.equal(navigated, false);
  popup.children[0]!.dispatchEvent(new Event("click"));
  assert.deepEqual(selected, [1]);
});

test("toolbar menus still align to their anchor and keep disabled actions", () => {
  const { view, popup } = fixture();
  view.showMenu(new ElementStub("button") as unknown as HTMLElement, [
    { label: "Unavailable", disabled: true }, { label: "", separator: true }, { label: "Available", checked: true },
  ]);
  assert.equal(view.popupOpen, true);
  assert.equal(popup.style.left, "756px");
  assert.equal(popup.children[0]!.disabled, true);
  assert.equal(popup.children[1]!.tagName, "hr");
  assert.equal(label(popup.children[2]!), "Available");
});
