"use strict";

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const enabled = document.getElementById("enabled");
const appSwitch = document.getElementById("appSwitch");
const controlsHint = document.getElementById("controlsHint");
const showButton = document.getElementById("showButton");
const popout = document.getElementById("popout");
const popoutHint = document.getElementById("popoutHint");
const videoSource = document.getElementById("videoSource");

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
  .get({ enabled: true, appSwitch: true, showButton: true, videoSource: "stage" })
  .then((s) => {
    enabled.checked = s.enabled;
    appSwitch.checked = s.appSwitch;
    appSwitch.disabled = !s.enabled;
    showButton.checked = s.showButton;
    videoSource.value = s.videoSource;
  });

videoSource.addEventListener("change", () => {
  browser.storage.local.set({ videoSource: videoSource.value });
});

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

  if (status.docPipSupported) {
    popout.hidden = false;
    popoutHint.hidden = false;
    if (status.docPipOpen) {
      popout.textContent = "Focus the floating window";
    }
    popout.onclick = async () => {
      const result = await browser.tabs.sendMessage(tab.id, {
        type: "meet-popout:open-docpip",
      });
      if (result?.already) {
        window.close();
      } else if (result?.armed) {
        // requestWindow() needs a gesture in the page itself, which a click in
        // this popup is not.
        popoutHint.textContent = "Now click anywhere in the meeting.";
        popout.disabled = true;
      }
    };
    popoutHint.textContent = status.docPipOpen
      ? "Floating window is open."
      : "Opens a window with mic, camera and hang-up buttons.";
  }

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
