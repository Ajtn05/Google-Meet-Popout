"use strict";

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const enabled = document.getElementById("enabled");
const appSwitch = document.getElementById("appSwitch");
const controlsHint = document.getElementById("controlsHint");
const showButton = document.getElementById("showButton");
const videoSources = document.querySelectorAll("input[name='videoSource']");
const sourceHint = document.getElementById("sourceHint");

const SOURCE_HINTS = {
  stage: "Meeting stage avoids your self-view when possible.",
  screen: "Shared screen falls back to the meeting stage if no one is presenting.",
  self: "Shows your mirrored self-view, even when it is not the active tile.",
  largest: "Follows whichever visible tile Meet has made largest.",
};

function show(level, text, hint) {
  dot.className = "dot" + (level ? " " + level : "");
  statusText.textContent = text;
  statusHint.textContent = hint || "";
}

/** Meet's markup is obfuscated, so say plainly when a button was not found. */
function showControls(controls) {
  if (!controls) {
    controlsHint.textContent = "";
    return;
  }
  const missing = Object.entries(controls)
    .filter(([, found]) => !found)
    .map(([name]) => name);
  controlsHint.textContent = missing.length
    ? "Controls not found: " + missing.join(", ")
    : "Mic, camera and hang-up controls found.";
}

browser.storage.local
  .get({ enabled: true, appSwitch: false, showButton: true, videoSource: "stage" })
  .then((s) => {
    enabled.checked = s.enabled;
    appSwitch.checked = s.appSwitch;
    appSwitch.disabled = !s.enabled;
    showButton.checked = s.showButton;
    const selected = Array.from(videoSources).find((input) => input.value === s.videoSource);
    (selected || videoSources[0]).checked = true;
    sourceHint.textContent = SOURCE_HINTS[s.videoSource] || SOURCE_HINTS.stage;
  });

videoSources.forEach((input) => input.addEventListener("change", () => {
  if (!input.checked) return;
  browser.storage.local.set({ videoSource: input.value });
  sourceHint.textContent = SOURCE_HINTS[input.value] || "";
}));

showButton.addEventListener("change", () => {
  browser.storage.local.set({ showButton: showButton.checked });
});

enabled.addEventListener("change", () => {
  browser.storage.local.set({ enabled: enabled.checked });
  appSwitch.disabled = !enabled.checked;
});

appSwitch.addEventListener("change", () => {
  browser.storage.local.set({ appSwitch: appSwitch.checked });
});

async function refresh() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab || !/^https:\/\/meet\.google\.com\//.test(tab.url || "")) {
    show("", "Not a Google Meet tab", "Open a meeting to see status.");
    return;
  }

  let status;
  try {
    status = await browser.tabs.sendMessage(tab.id, {
      type: "meet-popout:status",
    });
  } catch {
    show("warn", "Not loaded on this tab", "Reload the Meet tab.");
    return;
  }

  if (!status) {
    show("warn", "No response from the page", "Reload the Meet tab.");
    return;
  }
  if (!status.enabled) {
    show("", "Turned off", "Enable it above to pop out on tab switch.");
    return;
  }
  if (!status.hasSource) {
    show("warn", "Waiting for a meeting", "No playing video found yet.");
    return;
  }
  showControls(status.controls);

  if (status.shadowReady) {
    show("ok", "Ready", "Switch tabs and the meeting will pop out.");
    return;
  }
  show(
    "warn",
    "Ready (fallback mode)",
    "Needs the video-toggle.always-show pref — see below."
  );
}

refresh();
