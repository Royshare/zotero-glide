// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

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
  closest(): null { return null; }
  contains(other: unknown): boolean { return other === this; }
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

test("right-clicking a reference in the citation panel keeps the panel open under the menu", () => {
  const { view, popup } = fixture();
  const actions: string[] = [];
  view.showCitationPopup(300, 300, [{ label: "[1]", text: "Smith 2020" }, { label: "[2]", text: "Jones 2021" }], () => {}, (i, x, y) => {
    view.showMenuAt(x, y, [{ label: "Copy reference", run: () => { actions.push(`copy ${i}`); } }], true);
  });
  const rows = popup.children[0]!.children;
  assert.equal(rows.length, 2);
  rows[1]!.dispatchEvent(Object.assign(new Event("contextmenu", { cancelable: true }), { clientX: 320, clientY: 330 }));

  // the panel is untouched and the menu lives on its own layer above it
  assert.equal(popup.dataset.open, "true");
  assert.equal(popup.children.length, 1);
  assert.equal(popup.children[0]!.children.length, 2);
  const root = (view as unknown as { root: ElementStub }).root;
  const menu = root.children[0]!;
  assert.equal(menu.dataset.open, "true");
  assert.deepEqual(menu.children.map(label), ["Copy reference"]);

  // choosing an item runs it and closes both
  menu.children[0]!.dispatchEvent(new Event("click"));
  assert.deepEqual(actions, ["copy 1"]);
  assert.equal(view.popupOpen, false);
  assert.equal(popup.children.length, 0);
});

test("clearing popups also closes the overlay menu", () => {
  const { view, popup } = fixture();
  view.showCitationPopup(300, 300, [{ label: "[1]", text: "Smith 2020" }], () => {}, (_i, x, y) => {
    view.showMenuAt(x, y, [{ label: "Copy reference" }], true);
  });
  popup.children[0]!.children[0]!.dispatchEvent(new Event("contextmenu", { cancelable: true }));
  assert.equal(view.popupOpen, true);
  view.hidePopups();
  assert.equal(view.popupOpen, false);
});

test("pressing a toolbar button whose popup is open closes it instead of reopening it", () => {
  const { view } = fixture();
  const anchor = new ElementStub("button") as unknown as HTMLElement;
  const press = (t: unknown) => (view as unknown as { onRootPress(t: unknown): void }).onRootPress(t);
  const open = () => view.showMenu(anchor, [{ label: "Item" }]);

  open();
  assert.equal(view.popupOpen, true);
  // mousedown on the button closes the popup, and the click that follows must not open it again
  press(anchor);
  assert.equal(view.popupOpen, false);
  open();
  assert.equal(view.popupOpen, false, "the click after the closing mousedown is swallowed");
  // the next click is an ordinary one
  open();
  assert.equal(view.popupOpen, true);

  // pressing elsewhere closes it, and the button then opens it normally
  press(new ElementStub("div"));
  assert.equal(view.popupOpen, false);
  open();
  assert.equal(view.popupOpen, true);
});
