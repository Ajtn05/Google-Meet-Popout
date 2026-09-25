"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function element(tagName = "div") {
  const attrs = new Map();
  return {
    tagName: tagName.toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {} },
    setAttribute(name, value) { attrs.set(name, value); },
    getAttribute(name) { return attrs.get(name) || null; },
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    remove() {},
  };
}

test("a controls UI error keeps a video-only popout open", async () => {
  const pageListeners = {};
  const windowListeners = {};
  let onMessage;
  let closed = 0;
  let pipReady = false;
  const pipDocument = {
    documentElement: element("html"),
    body: element("body"),
    createElement: (tag) => element(tag),
    createElementNS: () => { throw Error("Meet blocked an icon"); },
  };
  const pipWindow = {
    document: pipDocument,
    closed: false,
    setTimeout() {},
    addEventListener(name) { if (name === "pagehide") pipReady = true; },
    close() { closed += 1; this.closed = true; },
  };
  const window = {
    documentPictureInPicture: { requestWindow: async () => pipWindow },
    addEventListener(name, callback) { windowListeners[name] = callback; },
  };
  window.top = window;
  const document = {
    visibilityState: "visible",
    querySelectorAll: () => [],
    addEventListener(name, callback) { pageListeners[name] = callback; },
  };
  const browser = {
    storage: {
      local: { get: async (defaults) => defaults },
      onChanged: { addListener() {} },
    },
    runtime: { onMessage: { addListener(callback) { onMessage = callback; } } },
  };
  const context = vm.createContext({
    browser, document, window,
    globalThis: {
      MeetPopoutMuteState: {},
      MeetPopoutParticipantTiles: { collect: () => [] },
    },
    console: { warn() {}, error() {}, log() {} },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8"),
    context,
    { filename: "content.js" }
  );
  await Promise.resolve();
  await onMessage({ type: "meet-popout:open-docpip" });
  pageListeners.click();
  for (let attempt = 0; !pipReady && attempt < 10; attempt += 1) await Promise.resolve();

  assert.equal(pipReady, true);
  assert.equal(closed, 0);
  assert.equal(pipDocument.body.children.length, 1);
  assert.equal(pipDocument.body.children[0].textContent, "Waiting for a Meet video");

  // A pagehide from the opener is not an instruction to close a newly opened
  // Document PiP window; Firefox manages its lifetime on real navigation.
  windowListeners.pagehide();
  assert.equal(closed, 0);
});
