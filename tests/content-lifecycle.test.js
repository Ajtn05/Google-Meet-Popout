"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("hidden Meet tabs keep checking video sources and disabling stops the checks", async () => {
  const listeners = {};
  let onStorageChanged;
  let started = 0;
  let stopped = 0;
  const document = {
    visibilityState: "visible",
    querySelectorAll: () => [],
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const window = {
    addEventListener: (name, callback) => { listeners[`window:${name}`] = callback; },
  };
  window.top = window;
  const browser = {
    storage: {
      local: { get: async (defaults) => defaults },
      onChanged: { addListener: (callback) => { onStorageChanged = callback; } },
    },
    runtime: { onMessage: { addListener() {} } },
  };
  const context = vm.createContext({
    browser,
    document,
    window,
    globalThis: { MeetPopoutMuteState: {} },
    setInterval: () => { started += 1; return started; },
    clearInterval: () => { stopped += 1; },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });
  await Promise.resolve();

  assert.equal(started, 1);
  document.visibilityState = "hidden";
  listeners.visibilitychange();
  assert.equal(stopped, 0);

  onStorageChanged({ enabled: { newValue: false } }, "local");
  assert.equal(stopped, 1);
  onStorageChanged({ enabled: { newValue: true } }, "local");
  assert.equal(started, 2);
});
