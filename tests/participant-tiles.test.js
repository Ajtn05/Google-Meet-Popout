"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ globalThis: {} });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "src", "participant-tiles.js"), "utf8"),
  context,
  { filename: "participant-tiles.js" }
);
const tiles = context.globalThis.MeetPopoutParticipantTiles;

function node(doc, { id, width = 200, height = 140, video, photo, name } = {}) {
  const attrs = id ? { "data-participant-id": id } : {};
  const item = {
    ownerDocument: doc,
    getBoundingClientRect: () => ({ width, height, top: 0, left: 0, right: width, bottom: height }),
    getAttribute: (key) => attrs[key] || null,
    hasAttribute: (key) => key in attrs,
    querySelectorAll: (selector) => selector === "video" ? (video ? [video] : [])
      : selector === "img" ? (photo ? [photo] : []) : [],
    querySelector: () => name ? { textContent: name, hasAttribute: () => false } : null,
  };
  return item;
}

test("gallery discovers a live camera and a camera-off profile photo", () => {
  const doc = { defaultView: { innerWidth: 1000, innerHeight: 700 } };
  const track = { id: "camera-1", readyState: "live" };
  const video = node(doc, { width: 200, height: 140 });
  video.track = track;
  const photo = node(doc, { width: 64, height: 64 });
  photo.src = "https://lh3.googleusercontent.com/photo";
  photo.alt = "Robin";
  const cameraTile = node(doc, { id: "camera", video, name: "Alex" });
  const profileTile = node(doc, { id: "profile", photo });
  doc.querySelectorAll = (selector) => selector === "video"
    ? [video]
    : [cameraTile, profileTile];

  const found = tiles.collect(doc, {
    liveTrack: (element) => element.track || null,
    isSelf: () => false,
    isScreen: () => false,
    shadowAttribute: "data-meet-popout-shadow",
  });
  assert.equal(found.length, 2);
  assert.equal(found.find((item) => item.id === "profile").photo, photo.src);
  assert.equal(found.find((item) => item.id === "profile").name, "Robin");
  assert.deepEqual(Array.from(tiles.select(found, video), (item) => item.id), ["camera", "profile"]);
});

test("gallery limits the view to four tiles with the selected stage first", () => {
  const all = Array.from({ length: 6 }, (_, index) => ({
    id: `person-${index}`,
    video: { index },
    track: { id: index },
    area: 100,
    self: false,
    screen: false,
  }));
  const selected = tiles.select(all, all[5].video);
  assert.equal(selected.length, 4);
  assert.equal(selected[0].id, "person-5");
});

test("gallery keeps a named camera-off tile and deduplicates a repeated stream", () => {
  const doc = { defaultView: { innerWidth: 1000, innerHeight: 700 } };
  const track = { id: "shared", readyState: "live" };
  const firstVideo = node(doc, { width: 200, height: 140 });
  const secondVideo = node(doc, { width: 100, height: 90 });
  firstVideo.track = track;
  secondVideo.track = track;
  const large = node(doc, { id: "large", width: 400, height: 250, video: firstVideo });
  const small = node(doc, { id: "small", width: 120, height: 90, video: secondVideo });
  const cameraOff = node(doc, { id: "off", name: "Taylor" });
  doc.querySelectorAll = (selector) => selector === "video"
    ? [firstVideo, secondVideo]
    : [large, small, cameraOff];
  const found = tiles.collect(doc, {
    liveTrack: (element) => element.track || null,
    isSelf: () => false,
    isScreen: () => false,
    shadowAttribute: "data-meet-popout-shadow",
  });
  assert.deepEqual(Array.from(found, (item) => item.id), ["large", "off"]);
  assert.equal(found[1].name, "Taylor");
  assert.equal(found[1].photo, null);
});

test("gallery recognizes an initials-only participant tile", () => {
  const doc = { defaultView: { innerWidth: 1000, innerHeight: 700 } };
  const initialTile = node(doc, { id: "initials" });
  const name = node(doc, { width: 80, height: 20 });
  name.textContent = "Morgan";
  name.closest = () => null;
  name.getBoundingClientRect = () => ({
    width: 80, height: 20, top: 110, left: 0, right: 80, bottom: 130,
  });
  initialTile.querySelectorAll = (selector) => selector === "span" ? [name] : [];
  doc.querySelectorAll = (selector) => selector === "video" ? [] : [initialTile];
  const found = tiles.collect(doc, {
    liveTrack: () => null,
    isSelf: () => false,
    isScreen: () => false,
    shadowAttribute: "data-meet-popout-shadow",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Morgan");
  assert.equal(found[0].photo, null);
});
