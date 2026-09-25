"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("expected background operation did not start");
}

test("focus returning during tab creation does not leave a parked tab", async () => {
  const created = deferred();
  const state = { parked: null, activeTab: 1, removed: [] };
  let onFocusChanged;
  let timer;
  let createStarted = false;
  const storage = {
    get: async (defaults) => ({ ...defaults, appSwitch: true, parked: state.parked }),
    set: async ({ parked }) => { state.parked = parked; },
  };
  const browser = {
    runtime: { getURL: (name) => `moz-extension://test/${name}` },
    storage: {
      session: storage,
      local: storage,
      onChanged: { addListener() {} },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ id: 7, focused: false }),
      onFocusChanged: { addListener(listener) { onFocusChanged = listener; } },
    },
    tabs: {
      query: async () => [{
        id: state.activeTab,
        index: 0,
        url: state.activeTab === 1
          ? "https://meet.google.com/abc-defg-hij"
          : "moz-extension://test/src/parked.html",
      }],
      sendMessage: async () => ({ enabled: true, hasSource: true }),
      create: async () => {
        createStarted = true;
        const tab = await created.promise;
        state.activeTab = tab.id;
        return tab;
      },
      update: async (id) => { state.activeTab = id; },
      remove: async (id) => { state.removed.push(id); },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    commands: { onCommand: { addListener() {} } },
  };
  const context = vm.createContext({
    browser,
    setTimeout: (callback) => { timer = callback; return 1; },
    clearTimeout: () => { timer = null; },
  });
  vm.runInContext(source, context, { filename: "background.js" });

  onFocusChanged(-1);
  timer();
  await waitFor(() => createStarted);
  onFocusChanged(7);
  created.resolve({ id: 2 });
  await waitFor(() => state.removed.length === 1);

  assert.deepEqual(state.removed, [2]);
  assert.equal(state.activeTab, 1);
  assert.equal(state.parked, null);
});
