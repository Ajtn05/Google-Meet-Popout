"use strict";

/**
 * App-switch support.
 *
 * Firefox only opens Picture-in-Picture automatically when a tab's document
 * becomes hidden ("PictureInPicture:VideoTabHidden" in PictureInPicture.sys.mjs).
 * Switching to another application does not hide the document — the tab is
 * still the selected one — so nothing fires.
 *
 * The only lever available to an extension is to genuinely deselect the Meet
 * tab. So when Firefox loses focus we park a placeholder tab in front of the
 * meeting, which hides the Meet document and lets Firefox's own auto-PiP take
 * over. When Firefox regains focus we select the meeting again and drop the
 * placeholder, which is the "VideoTabShown" signal that closes the PiP window.
 *
 * The PiP window itself is created by Firefox with the "alwaysontop" chrome
 * flag, so it floats above other applications with no help from us.
 */

const PARK_URL = browser.runtime.getURL("src/parked.html");
const MEET_RE = /^https:\/\/meet\.google\.com\//;

// Switching between two Firefox windows briefly reports "no window focused".
// Wait long enough to tell that apart from a real app switch.
const BLUR_GRACE_MS = 400;

// The event page can be unloaded between losing and regaining focus, so the
// parked state has to outlive it.
const session = browser.storage.session ?? browser.storage.local;

let blurTimer = null;

const getParked = async () => (await session.get({ parked: null })).parked;
const setParked = (parked) => session.set({ parked });

async function browserIsUnfocused() {
  try {
    const win = await browser.windows.getLastFocused();
    return !win.focused;
  } catch {
    return false;
  }
}

async function park() {
  if (await getParked()) return;

  const settings = await browser.storage.local.get({
    enabled: true,
    appSwitch: true,
  });
  if (!settings.enabled || !settings.appSwitch) return;

  // Confirm this is a real app switch and not a window-to-window hop.
  if (!(await browserIsUnfocused())) return;

  let win;
  try {
    win = await browser.windows.getLastFocused();
  } catch {
    return;
  }

  const [tab] = await browser.tabs.query({ active: true, windowId: win.id });
  // tab.url is only readable because of our meet.google.com host permission,
  // which conveniently means non-Meet tabs fall out here on their own.
  if (!tab || !MEET_RE.test(tab.url || "")) return;

  // Don't park for a tab that has nothing worth popping out.
  let status;
  try {
    status = await browser.tabs.sendMessage(tab.id, {
      type: "meet-popout:status",
    });
  } catch {
    return;
  }
  if (!status?.enabled || !status.hasSource) return;
  // The popout window is already always-on-top and has its own controls, so
  // parking a placeholder tab in front of the meeting would achieve nothing.
  if (status.docPipOpen) return;

  let parkTab;
  try {
    parkTab = await browser.tabs.create({
      windowId: win.id,
      index: tab.index + 1,
      active: true,
      url: PARK_URL,
    });
  } catch {
    return;
  }

  await setParked({
    parkTabId: parkTab.id,
    meetTabId: tab.id,
    windowId: win.id,
  });
}

async function unpark() {
  const parked = await getParked();
  if (!parked) return;
  await setParked(null);

  // Only steal the selection back if our placeholder is still what's showing.
  // If they switched tabs while away, leave them where they are.
  try {
    const [active] = await browser.tabs.query({
      active: true,
      windowId: parked.windowId,
    });
    if (active && active.id === parked.parkTabId) {
      // Select the meeting first: removing the placeholder on its own would
      // let Firefox pick whichever neighbour it likes.
      await browser.tabs.update(parked.meetTabId, { active: true });
    }
  } catch {}

  try {
    await browser.tabs.remove(parked.parkTabId);
  } catch {}
}

browser.windows.onFocusChanged.addListener((windowId) => {
  if (blurTimer !== null) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }

  if (windowId === browser.windows.WINDOW_ID_NONE) {
    blurTimer = setTimeout(() => {
      blurTimer = null;
      park().catch(() => {});
    }, BLUR_GRACE_MS);
  } else {
    unpark().catch(() => {});
  }
});

// Keep our bookkeeping honest if either tab disappears on its own.
browser.tabs.onRemoved.addListener(async (tabId) => {
  const parked = await getParked();
  if (!parked) return;

  if (tabId === parked.parkTabId) {
    await setParked(null);
  } else if (tabId === parked.meetTabId) {
    await setParked(null);
    try {
      await browser.tabs.remove(parked.parkTabId);
    } catch {}
  }
});

// If the meeting tab navigates away from Meet, stop holding a placeholder.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const parked = await getParked();
  if (!parked || tabId !== parked.meetTabId) return;
  if (!MEET_RE.test(changeInfo.url)) {
    await setParked(null);
    try {
      await browser.tabs.remove(parked.parkTabId);
    } catch {}
  }
});

/**
 * Keyboard shortcuts. browser.commands fires while Firefox has focus, which
 * includes clicking the floating Picture-in-Picture window to focus it. It does
 * not reach us while another application is focused — an extension cannot
 * register OS-global hotkeys without a native messaging host.
 */
const COMMAND_CONTROLS = {
  "toggle-mic": "mic",
  "toggle-camera": "camera",
  "leave-call": "leave",
};

browser.commands.onCommand.addListener(async (command) => {
  const control = COMMAND_CONTROLS[command];
  if (!control) return;

  const { enabled } = await browser.storage.local.get({ enabled: true });
  if (!enabled) return;

  let tabs;
  try {
    tabs = await browser.tabs.query({ url: "https://meet.google.com/*" });
  } catch {
    return;
  }
  if (!tabs.length) return;

  // Prefer the meeting we parked, then whichever is active, then the rest.
  const parked = await getParked();
  const rank = (tab) =>
    tab.id === parked?.meetTabId ? 0 : tab.active ? 1 : 2;
  tabs.sort((a, b) => rank(a) - rank(b));

  for (const tab of tabs) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, {
        type: "meet-popout:control",
        control,
      });
      if (result?.ok) return;
    } catch {}
  }
});
