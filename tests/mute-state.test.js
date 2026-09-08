"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "src", "mute-state.js"), "utf8"),
  context,
  { filename: "mute-state.js" }
);

const mute = context.globalThis.MeetPopoutMuteState;
const assertDecision = (actual, expected) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test("a shadow starts with Meet's known mute state", () => {
  assert.equal(mute.initialShadowMuted(true), true);
  assert.equal(mute.initialShadowMuted(false), false);
  assert.equal(mute.initialShadowMuted(null), true);
});

test("a Meet state change updates the PiP icon", () => {
  assertDecision(
    mute.fromMeetState({ shadowMuted: true, meetMuted: false, pendingTarget: null }),
    { action: "set-shadow", muted: false, clearPending: false }
  );
});

test("a PiP click toggles Meet once and waits for Meet to confirm", () => {
  assertDecision(
    mute.fromShadowVolumeChange({
      shadowMuted: true,
      expectedShadowMuted: null,
      pendingTarget: null,
      meetMuted: false,
    }),
    { action: "toggle-meet", target: true }
  );
  assertDecision(
    mute.fromMeetState({ shadowMuted: true, meetMuted: false, pendingTarget: true }),
    { action: "wait" }
  );
  assertDecision(
    mute.fromMeetState({ shadowMuted: true, meetMuted: true, pendingTarget: true }),
    { action: "none", muted: true, clearPending: true }
  );
});

test("our own PiP icon update never toggles Meet back", () => {
  assertDecision(
    mute.fromShadowVolumeChange({
      shadowMuted: false,
      expectedShadowMuted: false,
      pendingTarget: null,
      meetMuted: false,
    }),
    { action: "ignore", clearExpected: true }
  );
});

test("a second event while a PiP toggle is pending is ignored", () => {
  assertDecision(
    mute.fromShadowVolumeChange({
      shadowMuted: true,
      expectedShadowMuted: null,
      pendingTarget: true,
      meetMuted: false,
    }),
    { action: "ignore" }
  );
});
