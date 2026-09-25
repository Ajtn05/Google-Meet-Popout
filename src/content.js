"use strict";

/**
 * Meet Popout — drives Firefox's built-in "auto Picture-in-Picture on tab
 * switch" feature so that it fires on Google Meet.
 *
 * Firefox already does the popping out and popping back in. Its chrome-side
 * logic (toolkit/actors/PictureInPictureChild.sys.mjs) works like this when a
 * tab is backgrounded:
 *
 *   findVideoToPiP(doc):
 *     1. document.activeElement, if that is a <video>
 *     2. otherwise the first non-paused <video> with a non-NaN duration
 *
 *   ...then it requires videoIsPlaying(v)      -> !paused && !ended && readyState > 2
 *          and       videoIsPiPEligible(v)     -> duration >= 45s
 *                                                 clientWidth/Height >= 140
 *                                                 v.mozHasAudio
 *
 * Meet fails that last check: its tiles are video-only MediaStreams, so
 * mozHasAudio is false and nothing is ever eligible. mozHasAudio is latched the
 * first time an element reaches HAVE_METADATA, so adding an audio track to
 * Meet's own <video> afterwards would not help.
 *
 * So we keep our own "shadow" <video>, effectively invisible but 144x144 in
 * layout, whose MediaStream carries the current speaker's video track *and* a
 * silent audio track present from the very start. That satisfies every gate.
 * MediaStream-backed elements report duration === Infinity, so the length check
 * passes too.
 *
 * All we then have to do is focus it at the moment the tab hides, so that
 * findVideoToPiP picks it. Firefox does the rest, including closing the PiP
 * window when you switch back.
 */

(() => {
  // Firefox wants >= 140px in both directions; leave a little headroom.
  const MIN_DIM = 144;
  const POLL_MS = 1000;
  const MAX_MISSES = 3;
  const HIDDEN_MAX_MISSES = 10;
  const SHADOW_ATTR = "data-meet-popout-shadow";
  const muteState = globalThis.MeetPopoutMuteState;
  const participantTiles = globalThis.MeetPopoutParticipantTiles;

  const state = {
    enabled: true,
    shadowVideo: null,
    shadowStream: null,
    audio: null, // { ctx, track }
    videoTrack: null,
    pollId: null,
    lastFocused: null,
    borrowed: false,
    misses: 0,
    controlsObserver: null,
    controlsRefreshId: null,
    // A programmatic mirror of Meet's state also emits volumechange. Remember
    // it briefly so that we never interpret our own update as a PiP click.
    expectedShadowMuted: null,
    expectedShadowMutedTimer: null,
    // A PiP click needs a moment for Meet to apply its state change. Do not
    // mirror the old Meet state back into PiP during that short interval.
    pendingMicTarget: null,
    pendingMicTimer: null,
    pipWindow: null,
    pipOpening: false,
    pipFallback: false,
    pipError: null,
    pipExpectedClose: false,
    pipVideo: null,
    pipGallery: null,
    pipTiles: new Map(),
    pipGalleryMisses: 0,
    pipOverflow: null,
    pipView: "gallery",
    pipStatus: null,
    pipButtons: null,
    launchButton: null,
    launchMessageTimer: null,
    armed: false,
    showButton: true,
    videoSource: "stage", // "stage" | "screen" | "self" | "largest"
    debug: false,
    patchedVideo: null, // real Meet <video> we temporarily made focusable
    targetKind: "none", // "shadow" | "fallback" | "none"
  };

  const log = (...args) => {
    if (state.debug) console.log("[meet-popout]", ...args);
  };

  /* ---------------------------------------------------------------- picking */

  /** Meet mirrors your own camera preview, which is how we spot the self-view. */
  function isMirrored(video) {
    try {
      const t = getComputedStyle(video).transform;
      if (!t || t === "none") return false;
      return new DOMMatrixReadOnly(t).a < 0;
    } catch {
      return false;
    }
  }

  // Depending on Meet's current layout, the transform can live on a wrapper
  // rather than the <video> itself. Looking a few levels up covers both forms
  // without treating a transform on the whole page as a self-view signal.
  function isLikelySelfView(video) {
    let el = video;
    for (let depth = 0; el && depth < 5; depth += 1, el = el.parentElement) {
      if (isMirrored(el)) return true;
    }
    return false;
  }

  function liveVideoTrack(video) {
    const stream = video.srcObject;
    if (!stream || typeof stream.getVideoTracks !== "function") return null;
    return (
      stream.getVideoTracks().find((t) => t.enabled && t.readyState === "live") ||
      null
    );
  }

  function isScreenTrack(track) {
    const settings = track.getSettings?.() || {};
    if (settings.displaySurface) return true;
    // Remote display-capture tracks do not consistently retain
    // displaySurface in Firefox. Labels are supplied by the sender and are a
    // useful fallback without guessing based only on a video's aspect ratio.
    return /\b(screen|window|display|monitor|tab)\b/i.test(track.label || "");
  }

  /** The visible, playing, MediaStream-backed tiles that could go into PiP. */
  function availableVideos() {
    const candidates = [];
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(SHADOW_ATTR)) continue;
      if (video.paused || video.ended || video.readyState < 3) continue;
      if (!liveVideoTrack(video)) continue;

      const r = video.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) continue;
      // Skip tiles parked outside the viewport.
      if (r.bottom <= 0 || r.right <= 0) continue;
      if (r.top >= innerHeight || r.left >= innerWidth) continue;

      const track = liveVideoTrack(video);
      candidates.push({
        video,
        area: r.width * r.height,
        self: isLikelySelfView(video),
        screen: isScreenTrack(track),
      });
    }
    return candidates;
  }

  function largestVideo(candidates) {
    return candidates.reduce(
      (best, candidate) => (!best || candidate.area > best.area ? candidate : best),
      null
    )?.video || null;
  }

  /**
   * Pick the requested content. "stage" intentionally excludes a detected
   * self-view before comparing sizes, so an enlarged local preview cannot win
   * over another participant or a presentation. Every mode has a useful
   * fallback for solo meetings and the brief DOM churn during layout changes.
   */
  function pickBestVideo() {
    const candidates = availableVideos();
    if (!candidates.length) return null;

    if (state.videoSource === "self") {
      return largestVideo(candidates.filter((candidate) => candidate.self)) || largestVideo(candidates);
    }
    if (state.videoSource === "screen") {
      return largestVideo(candidates.filter((candidate) => candidate.screen)) ||
        largestVideo(candidates.filter((candidate) => !candidate.self)) ||
        largestVideo(candidates);
    }
    if (state.videoSource === "largest") return largestVideo(candidates);

    return largestVideo(candidates.filter((candidate) => !candidate.self)) || largestVideo(candidates);
  }

  /* -------------------------------------------------------------- controls */

  /**
   * Firefox's Picture-in-Picture window is browser chrome — there is no API to
   * put Meet's own buttons in it. What there *is*, is a mute button that ends
   * up calling `video.muted = shouldMute` on the source element (setMuted() in
   * PictureInPictureChild.sys.mjs falls back to that when no site wrapper
   * exists). That lands in content as a plain volumechange, so we can treat the
   * PiP window's mute button as the meeting's microphone toggle, and mirror the
   * real mic state back so the icon matches.
   *
   * Meet's markup is obfuscated and its labels are localised, so finding the
   * buttons is best-effort. data-is-muted is the stable part; the rest is label
   * matching.
   */
  const CONTROL_MATCHERS = {
    mic: [/microphone/i, /\bmic\b/i],
    camera: [/camera/i, /\bvideo\b/i],
    leave: [/leave call/i, /end call/i, /hang ?up/i],
  };
  // These markers do not depend on English labels. Meet currently uses
  // data-mute-button for the microphone; retain the camera variants for Meet
  // deployments that expose them.
  const CONTROL_MARKERS = {
    mic: ["[data-mute-button]"],
    camera: ["[data-camera-button]", "[data-video-button]"],
  };
  const CONTROL_SELECTOR = [
    "[data-is-muted]",
    "button[aria-label]",
    "[role='button'][aria-label]",
    "[data-tooltip]",
  ].join(",");
  const INTERACTIVE_SELECTOR = "button, [role='button'], input[type='button']";

  function labelOf(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("data-tooltip") ||
      el.getAttribute("title") ||
      ""
    );
  }

  function controlContainer(el) {
    if (el.matches?.(INTERACTIVE_SELECTOR)) return el;
    return el.closest?.(INTERACTIVE_SELECTOR) || el;
  }

  /**
   * data-is-muted lives on different descendants of the Meet button as its UI
   * changes. Keep the labelled, clickable ancestor together with the element
   * that owns the state attribute instead of assuming they are the same node.
   */
  function infoForControlNode(stateNode, matchers, markerMatched = false) {
    const button = controlContainer(stateNode);
    if (!button) return null;

    // Meet sometimes labels a child (or the state-bearing node) rather than
    // the button itself. Check both, plus labelled descendants.
    const labels = [labelOf(stateNode), labelOf(button)];
    for (const child of button.querySelectorAll?.("[aria-label], [data-tooltip], [title]") || []) {
      labels.push(labelOf(child));
    }
    const labelMatched = labels.some(
      (label) => label && matchers.some((matcher) => matcher.test(label))
    );
    if (!markerMatched && !labelMatched) return null;

    const mutedNode = stateNode.hasAttribute("data-is-muted")
      ? stateNode
      : button.querySelector("[data-is-muted]");
    return { button, stateNode: mutedNode || stateNode };
  }

  function controlInfo(kind) {
    const matchers = CONTROL_MATCHERS[kind];
    if (!matchers) return null;

    // Prefer the stable state-bearing controls. A generic labelled button may
    // appear earlier in Meet's DOM and otherwise make us read its label while
    // missing the real data-is-muted value on the actual toggle.
    for (const selector of CONTROL_MARKERS[kind] || []) {
      for (const node of document.querySelectorAll(selector)) {
        const info = infoForControlNode(node, matchers, true);
        if (info) return info;
      }
    }
    for (const node of document.querySelectorAll("[data-is-muted]")) {
      const info = infoForControlNode(node, matchers);
      if (info) return info;
    }
    for (const node of document.querySelectorAll(CONTROL_SELECTOR)) {
      const info = infoForControlNode(node, matchers);
      if (info) return info;
    }
    return null;
  }

  function findControl(kind) {
    return controlInfo(kind)?.button || null;
  }

  function activateControl(kind) {
    const button = findControl(kind);
    if (!button) return false;
    try {
      button.click();
    } catch {
      return false;
    }
    // Meet updates attributes asynchronously. Let the mutation observer do the
    // normal reconciliation, but schedule one extra pass for implementations
    // that update state without changing an observed attribute.
    if (kind === "mic" || kind === "camera") setTimeout(refreshControls, 180);
    return true;
  }

  /** true = off/muted, false = live, null = could not tell. */
  function controlMuted(kind) {
    const info = controlInfo(kind);
    if (!info) return null;

    const nodes = [info.stateNode, info.button];
    for (const node of nodes) {
      const attr = node?.getAttribute?.("data-is-muted");
      if (attr === "true") return true;
      if (attr === "false") return false;
    }
    for (const node of nodes) {
      const label = labelOf(node);
      if (/turn on|unmute/i.test(label)) return true;
      if (/turn off|^mute/i.test(label)) return false;
    }
    return null;
  }

  const micMuted = () => controlMuted("mic");

  function setShadowMuted(muted) {
    const shadow = state.shadowVideo;
    if (!shadow || shadow.muted === muted) return;

    state.expectedShadowMuted = muted;
    clearTimeout(state.expectedShadowMutedTimer);
    shadow.muted = muted;
    // Firefox normally delivers volumechange immediately. The timeout covers
    // a failed/no-event update without swallowing a later real PiP click.
    state.expectedShadowMutedTimer = setTimeout(() => {
      if (state.expectedShadowMuted === muted) state.expectedShadowMuted = null;
    }, 150);
  }

  /** Push Meet's mic state onto the shadow element so the PiP icon agrees. */
  function mirrorMicToShadow() {
    if (!shadowIsReady()) return;
    const muted = micMuted();
    const decision = muteState.fromMeetState({
      shadowMuted: state.shadowVideo.muted,
      meetMuted: muted,
      pendingTarget: state.pendingMicTarget,
    });
    if (decision.clearPending) {
      state.pendingMicTarget = null;
      clearTimeout(state.pendingMicTimer);
    }
    if (decision.action === "wait" || decision.action === "none") return;
    setShadowMuted(decision.muted);
  }

  /** Someone pressed mute in the PiP window. */
  function onShadowVolumeChange() {
    const shadow = state.shadowVideo;
    if (!shadow) return;
    const decision = muteState.fromShadowVolumeChange({
      shadowMuted: shadow.muted,
      expectedShadowMuted: state.expectedShadowMuted,
      pendingTarget: state.pendingMicTarget,
      meetMuted: micMuted(),
    });
    if (decision.clearExpected) {
      state.expectedShadowMuted = null;
      clearTimeout(state.expectedShadowMutedTimer);
    }
    if (decision.action !== "toggle-meet") return;

    const target = decision.target;
    if (!activateControl("mic")) {
      mirrorMicToShadow();
      return;
    }
    state.pendingMicTarget = target;
    clearTimeout(state.pendingMicTimer);
    state.pendingMicTimer = setTimeout(() => {
      if (state.pendingMicTarget !== target) return;
      state.pendingMicTarget = null;
      // If Meet rejected the click, put the PiP icon back to the real state.
      mirrorMicToShadow();
    }, 800);
  }

  /**
   * Watch Meet's whole control area rather than one button node. Meet replaces
   * its controls during layout changes, and polling deliberately stops while a
   * video PiP window is open. A document observer keeps mute state linked in
   * both of those cases.
   */
  function refreshControls() {
    state.controlsRefreshId = null;
    mirrorMicToShadow();
    refreshPipButtons();
    // If Meet replaced part of its page shell, put the launcher back straight
    // away instead of waiting for the next polling tick.
    updateLaunchButton();
  }

  function watchControls() {
    if (state.controlsObserver) return;
    const root = document.documentElement;
    if (!root) return;
    state.controlsObserver = new MutationObserver(() => {
      if (state.controlsRefreshId !== null) return;
      state.controlsRefreshId = setTimeout(refreshControls, 0);
    });
    state.controlsObserver.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-pressed", "data-is-muted", "data-tooltip", "title"],
    });
    refreshControls();
  }

  /* --------------------------------------------------------------- doc pip */

  /**
   * The Chrome-equivalent path.
   *
   * Chrome's Meet popout is the Document Picture-in-Picture API: an always-on-top
   * window holding a real document, which is why its buttons work. Firefox
   * shipped that API in 151 (dom.documentpip.enabled, default true on desktop),
   * so we can build the same thing — live video plus real controls.
   *
   * What Firefox does not have is Chrome's other half: the "auto picture-in-
   * picture" permission for conferencing sites, exposed through an
   * `enterpictureinpicture` MediaSession action. Gecko's MediaSessionAction enum
   * has no such value, and requestWindow() throws NotAllowedError without
   * transient activation. So this window cannot open by itself on a tab switch —
   * it needs a click, and then it simply stays open.
   *
   * Note the window inherits Meet's CSP, so everything here is built through
   * CSSOM rather than <style> elements, which a strict style-src would reject.
   */

  // Firefox rejects requestWindow() from an iframe. Content scripts also run
  // in Meet's frames, so only the page-level script may offer this button.
  const DOCPIP_SUPPORTED =
    window.top === window && typeof window.documentPictureInPicture !== "undefined";
  const SVG_NS = "http://www.w3.org/2000/svg";

  const ICON_PATHS = {
    gallery:
      "M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z",
    micOn:
      "M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z",
    micOff:
      "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
    camOn:
      "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
    camOff:
      "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
    leave:
      "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.51-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
  };

  const css = (el, rules) => {
    for (const [prop, value] of Object.entries(rules)) {
      el.style.setProperty(prop, value);
    }
  };

  function makeIcon(doc, key) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATHS[key]);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  }

  const docPipOpen = () => !!(state.pipWindow && !state.pipWindow.closed);

  function showLaunchMessage(message) {
    const button = state.launchButton;
    if (!button?.isConnected) return;
    clearTimeout(state.launchMessageTimer);
    button.textContent = message;
    button.setAttribute("aria-label", message);
    button.title = message;
    state.launchMessageTimer = setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = "Pop out";
      setLaunchButtonAvailability(button);
    }, 3500);
  }

  function makeButton(doc, { iconKey, label, danger, onClick }) {
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    css(button, {
      display: "grid",
      "place-items": "center",
      width: "40px",
      height: "40px",
      "border-radius": "50%",
      border: "none",
      cursor: "pointer",
      color: "#fff",
      background: danger ? "#d93025" : "rgba(255,255,255,0.16)",
      transition: "background 120ms ease",
      padding: "0",
    });
    button.appendChild(makeIcon(doc, iconKey));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    button.addEventListener("mouseenter", () => {
      if (!button.dataset.active) {
        css(button, { background: danger ? "#e5544a" : "rgba(255,255,255,0.28)" });
      }
    });
    button.addEventListener("mouseleave", () => refreshPipButtons());
    return button;
  }

  /** Paint the mic/camera buttons to match Meet's actual state. */
  function refreshPipButtons() {
    const buttons = state.pipButtons;
    if (!buttons || !docPipOpen()) return;

    for (const kind of ["mic", "camera"]) {
      const button = buttons[kind];
      if (!button) continue;
      const off = controlMuted(kind);
      const name = kind === "mic" ? "Microphone" : "Camera";
      if (off === null) {
        // A neutral state is safer than presenting an "on" icon that we
        // cannot verify against Meet's real control.
        button.dataset.active = "";
        button.disabled = true;
        button.setAttribute("aria-label", `${name} state unavailable`);
        button.title = `${name} state unavailable`;
        css(button, { background: "rgba(255,255,255,0.28)" });
        button.replaceChildren(
          makeIcon(state.pipWindow.document, kind === "mic" ? "micOn" : "camOn")
        );
        continue;
      }
      const isOff = off === true;
      button.disabled = false;
      button.dataset.active = isOff ? "1" : "";
      button.setAttribute(
        "aria-label",
        isOff ? `${name} is off. Activate to turn it on.` : `${name} is on. Activate to turn it off.`
      );
      button.title = button.getAttribute("aria-label");
      css(button, {
        background: isOff ? "#d93025" : "rgba(255,255,255,0.16)",
      });
      const iconKey =
        kind === "mic"
          ? isOff
            ? "micOff"
            : "micOn"
          : isOff
            ? "camOff"
            : "camOn";
      button.replaceChildren(makeIcon(state.pipWindow.document, iconKey));
    }
  }

  function setPipStatus(message) {
    const status = state.pipStatus;
    if (!status) return;
    status.textContent = message || "";
    css(status, { display: message ? "grid" : "none" });
  }

  function renderPipView() {
    if (!docPipOpen() || !state.pipVideo || !state.pipGallery) return;
    const hasPeople = state.pipTiles.size > 0;
    const galleryVisible = state.pipView === "gallery" && hasPeople;
    css(state.pipGallery, { display: galleryVisible ? "grid" : "none" });
    css(state.pipVideo, { display: galleryVisible ? "none" : "block" });
    if (galleryVisible) {
      for (const tile of state.pipTiles.values()) {
        if (tile.media.tagName === "VIDEO" && tile.media.paused) {
          tile.media.play().catch(() => {});
        }
      }
    } else if (state.pipVideo.srcObject && state.pipVideo.paused) {
      state.pipVideo.play().catch(() => {});
    }
    setPipStatus(galleryVisible || state.pipVideo.srcObject
      ? ""
      : "Waiting for a visible Meet video or participant…");
    const button = state.pipButtons?.gallery;
    if (button) {
      const label = galleryVisible ? "Show meeting stage" : "Show participants";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.setAttribute("aria-pressed", String(galleryVisible));
      css(button, { background: galleryVisible ? "#1a73e8" : "rgba(255,255,255,0.16)" });
    }
  }

  function makeGalleryTile(doc, entry) {
    const frame = doc.createElement("div");
    frame.setAttribute("aria-label", entry.name);
    css(frame, {
      position: "relative", overflow: "hidden", "min-width": "0", "min-height": "0",
      "border-radius": "8px", background: "#202124", display: "grid", "place-items": "center",
    });
    let media;
    if (entry.track) {
      media = doc.createElement("video");
      media.autoplay = true;
      media.playsInline = true;
      media.muted = true;
      media.srcObject = new MediaStream([entry.track]);
      css(media, { width: "100%", height: "100%", "object-fit": "cover" });
      frame.appendChild(media);
    } else {
      media = doc.createElement("div");
      media.textContent = entry.name.slice(0, 1).toUpperCase();
      css(media, {
        width: "72px", height: "72px", "border-radius": "50%", background: "#5f6368",
        color: "white", display: "grid", "place-items": "center", "font-size": "34px",
        "font-weight": "500", overflow: "hidden", position: "relative",
      });
      if (entry.photo) {
        const photo = doc.createElement("img");
        photo.alt = "";
        photo.src = entry.photo;
        css(photo, {
          position: "absolute", width: "100%", height: "100%", "object-fit": "cover",
        });
        photo.addEventListener("error", () => photo.remove(), { once: true });
        media.appendChild(photo);
      }
      frame.appendChild(media);
    }
    const label = doc.createElement("div");
    label.textContent = entry.name;
    css(label, {
      position: "absolute", left: "0", right: "0", bottom: "0", color: "#fff",
      padding: "14px 8px 6px", "font-size": "11px", "white-space": "nowrap",
      overflow: "hidden", "text-overflow": "ellipsis",
      background: "linear-gradient(transparent, rgba(0,0,0,0.72))",
    });
    frame.appendChild(label);
    return { frame, media, track: entry.track, photo: entry.photo, name: entry.name };
  }

  function updatePipGallery() {
    try {
      updatePipGalleryFromMeet();
    } catch (error) {
      // Meet can replace a tile while we are reading it. A discovery failure
      // must never tear down the entire floating window.
      console.warn("[meet-popout] participant gallery unavailable", error);
      state.pipView = "stage";
      renderPipView();
    }
  }

  function updatePipGalleryFromMeet() {
    if (!docPipOpen() || !state.pipGallery) return;
    const found = participantTiles.collect(document, {
      liveTrack: liveVideoTrack,
      isSelf: isLikelySelfView,
      isScreen: isScreenTrack,
      shadowAttribute: SHADOW_ATTR,
    });
    if (!found.length && document.visibilityState === "hidden" &&
        state.pipTiles.size && ++state.pipGalleryMisses < 3) return;
    if (found.length) state.pipGalleryMisses = 0;
    const selected = participantTiles.select(found, pickBestVideo());
    const next = new Map();
    const frames = [];
    for (const entry of selected) {
      const previous = state.pipTiles.get(entry.id);
      let tile;
      try {
        tile = previous && previous.track === entry.track &&
          previous.photo === entry.photo && previous.name === entry.name
          ? previous
          : makeGalleryTile(state.pipWindow.document, entry);
      } catch (error) {
        log("could not add participant tile", entry.name, error);
        continue;
      }
      if (previous && previous !== tile && previous.media.tagName === "VIDEO") {
        previous.media.srcObject = null;
      }
      next.set(entry.id, tile);
      frames.push(tile.frame);
    }
    for (const [id, tile] of state.pipTiles) {
      if (!next.has(id) && tile.media.tagName === "VIDEO") tile.media.srcObject = null;
    }
    state.pipTiles = next;
    const gallery = state.pipGallery;
    if (frames.length !== gallery.children.length ||
        frames.some((frame, index) => gallery.children[index] !== frame)) {
      gallery.replaceChildren(...frames);
    }
    for (const tile of next.values()) {
      if (tile.media.tagName === "VIDEO" && tile.media.paused) {
        tile.media.play().catch(() => {});
      }
    }
    css(gallery, {
      "grid-template-columns": frames.length === 1 ? "1fr" : "repeat(2, minmax(0, 1fr))",
      "grid-template-rows": frames.length <= 2 ? "1fr" : "repeat(2, minmax(0, 1fr))",
    });
    if (state.pipOverflow) {
      state.pipOverflow.textContent = found.length > selected.length
        ? `+${found.length - selected.length} more`
        : "";
      css(state.pipOverflow, { display: found.length > selected.length ? "block" : "none" });
    }
    renderPipView();
  }

  function buildPipUI(pipWindow, track) {
    const doc = pipWindow.document;
    css(doc.documentElement, { height: "100%" });
    css(doc.body, {
      margin: "0",
      height: "100%",
      background: "#000",
      overflow: "hidden",
      "font-family": "system-ui, -apple-system, sans-serif",
      position: "relative",
    });

    const video = doc.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    // Meet's own audio keeps playing from the tab; this is video only.
    video.muted = true;
    css(video, {
      width: "100%",
      height: "100%",
      "object-fit": "contain",
      display: "block",
      background: "#000",
    });
    if (track) video.srcObject = new MediaStream([track]);
    doc.body.appendChild(video);
    if (track) video.play().catch(() => {});
    state.pipVideo = video;

    const gallery = doc.createElement("div");
    gallery.setAttribute("aria-label", "Meeting participants");
    css(gallery, {
      position: "absolute", inset: "0", gap: "4px", padding: "5px",
      "box-sizing": "border-box", display: "none", background: "#111",
    });
    doc.body.appendChild(gallery);
    state.pipGallery = gallery;

    const overflow = doc.createElement("div");
    css(overflow, {
      position: "absolute", top: "9px", right: "9px", padding: "3px 7px",
      "border-radius": "10px", background: "rgba(0,0,0,0.72)", color: "#fff",
      "font-size": "11px", display: "none", "pointer-events": "none",
    });
    doc.body.appendChild(overflow);
    state.pipOverflow = overflow;

    const status = doc.createElement("div");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    css(status, {
      position: "absolute",
      inset: "0",
      display: "grid",
      "place-items": "center",
      padding: "24px",
      "box-sizing": "border-box",
      color: "rgba(255,255,255,0.82)",
      "font-size": "14px",
      "text-align": "center",
      "pointer-events": "none",
    });
    doc.body.appendChild(status);
    state.pipStatus = status;
    setPipStatus(track ? "" : "Waiting for a visible Meet video or participant…");

    const bar = doc.createElement("div");
    css(bar, {
      position: "absolute",
      left: "0",
      right: "0",
      bottom: "0",
      display: "flex",
      "justify-content": "center",
      gap: "12px",
      padding: "12px",
      background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
      opacity: "0",
      transition: "opacity 150ms ease",
    });
    doc.body.appendChild(bar);

    const reveal = (shown) => css(bar, { opacity: shown ? "1" : "0" });
    doc.body.addEventListener("mouseenter", () => reveal(true));
    doc.body.addEventListener("mouseleave", () => reveal(false));
    doc.body.addEventListener("pointerdown", () => {
      reveal(true);
      pipWindow.setTimeout(() => reveal(false), 2500);
    });
    bar.addEventListener("focusin", () => reveal(true));
    // Touch and small windows never get a hover, so show it briefly on open.
    reveal(true);
    pipWindow.setTimeout(() => reveal(false), 2500);

    const buttons = {
      gallery: makeButton(doc, {
        iconKey: "gallery",
        label: "Show meeting stage",
        onClick: () => {
          state.pipView = state.pipView === "gallery" ? "stage" : "gallery";
          renderPipView();
        },
      }),
      mic: makeButton(doc, {
        iconKey: "micOn",
        label: "Toggle microphone",
        onClick: () => {
          activateControl("mic");
          pipWindow.setTimeout(refreshPipButtons, 150);
        },
      }),
      camera: makeButton(doc, {
        iconKey: "camOn",
        label: "Toggle camera",
        onClick: () => {
          activateControl("camera");
          pipWindow.setTimeout(refreshPipButtons, 150);
        },
      }),
      leave: makeButton(doc, {
        iconKey: "leave",
        label: "Leave the call",
        danger: true,
        onClick: () => {
          if (activateControl("leave")) closeDocPiP();
        },
      }),
    };
    state.pipButtons = buttons;
    bar.append(buttons.gallery, buttons.mic, buttons.camera, buttons.leave);
    renderPipView();
  }

  function buildFallbackPipUI(pipWindow, track) {
    const doc = pipWindow.document;
    for (const tile of state.pipTiles.values()) {
      if (tile.media.tagName === "VIDEO") tile.media.srcObject = null;
    }
    state.pipTiles.clear();
    doc.body.replaceChildren();
    css(doc.body, { margin: "0", background: "#202124", height: "100%" });
    state.pipGallery = null;
    state.pipStatus = null;
    state.pipButtons = null;
    state.pipOverflow = null;
    let video = null;
    if (track) {
      try {
        video = doc.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.srcObject = new MediaStream([track]);
        css(video, { width: "100%", height: "100%", "object-fit": "contain" });
        doc.body.appendChild(video);
        video.play().catch(() => {});
      } catch (error) {
        console.error("[meet-popout] could not attach fallback video", error);
        video = null;
      }
    }
    state.pipVideo = video;
    if (!video) {
      const message = doc.createElement("div");
      message.textContent = "Waiting for a Meet video";
      css(message, { color: "#fff", padding: "24px", "font-family": "system-ui" });
      doc.body.appendChild(message);
    }
  }

  /**
   * Must be called from a user gesture — requestWindow() throws NotAllowedError
   * without transient activation, and there is no way around that in Firefox.
   */
  async function openDocPiP() {
    if (!state.enabled || state.pipOpening) return false;
    if (!DOCPIP_SUPPORTED) {
      showLaunchMessage("Controls popout is unavailable in this Firefox");
      return false;
    }
    if (docPipOpen()) {
      state.pipWindow.focus();
      return true;
    }

    const source = pickBestVideo();
    const track = source && liveVideoTrack(source);

    let pipWindow;
    state.pipOpening = true;
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 420,
        height: 280,
      });
    } catch (e) {
      log("requestWindow rejected", e);
      state.pipError = e?.message || "Firefox rejected the popout request";
      showLaunchMessage(
        e?.name === "NotAllowedError"
          ? "Firefox blocked the popout — click again in the meeting"
          : "Could not open the controls popout"
      );
      state.pipOpening = false;
      return false;
    }

    state.pipOpening = false;
    if (!state.enabled) {
      pipWindow.close();
      return false;
    }
    state.pipWindow = pipWindow;
    state.pipFallback = false;
    state.pipError = null;
    state.pipExpectedClose = false;
    state.pipView = "gallery";
    const openedAt = Date.now();
    try {
      buildPipUI(pipWindow, track);
    } catch (e) {
      console.error("[meet-popout] could not build controls; showing video only", e);
      state.pipFallback = true;
      state.pipError = e?.message || "Controls could not be built";
      try {
        buildFallbackPipUI(pipWindow, track);
      } catch (fallbackError) {
        console.error("[meet-popout] could not build fallback popout", fallbackError);
        state.pipError = fallbackError?.message || "Popout document could not be built";
        // Keep the browser window available for diagnostics. A rendering
        // failure in an extension content script is not a reason to dismiss
        // Firefox's already opened PiP window.
      }
    }

    pipWindow.addEventListener("pagehide", () => {
      if (state.pipWindow !== pipWindow) return;
      if (!state.pipExpectedClose && !state.pipError && Date.now() - openedAt < 3000) {
        state.pipError = "Firefox closed the floating window immediately";
      }
      state.pipWindow = null;
      state.pipFallback = false;
      state.pipExpectedClose = false;
      for (const tile of state.pipTiles.values()) {
        if (tile.media.tagName === "VIDEO") tile.media.srcObject = null;
      }
      state.pipTiles.clear();
      state.pipGalleryMisses = 0;
      state.pipVideo = null;
      state.pipGallery = null;
      state.pipOverflow = null;
      state.pipStatus = null;
      state.pipButtons = null;
      updateLaunchButton();
      if (state.enabled && document.visibilityState === "visible") startPolling();
    });

    // The chrome-side popout would be a second floating window; stand it down.
    releaseFocus();
    destroyShadow();
    state.targetKind = "docpip";
    updateLaunchButton();
    startPolling();
    return true;
  }

  function closeDocPiP() {
    if (docPipOpen()) {
      try {
        state.pipExpectedClose = true;
        state.pipWindow.close();
      } catch {}
    }
  }

  /** Follow the active speaker without rebuilding the window. */
  function updatePipVideo(track) {
    if (!docPipOpen()) return;
    if (!state.pipVideo) {
      if (state.pipFallback && track) {
        try {
          buildFallbackPipUI(state.pipWindow, track);
        } catch (error) {
          log("could not attach a newly available fallback video", error);
        }
      }
      return;
    }
    const current = state.pipVideo.srcObject;
    if (!track) {
      if (current) state.pipVideo.srcObject = null;
      renderPipView();
      return;
    }
    if (current && current.getVideoTracks()[0] === track) return;
    try {
      state.pipVideo.srcObject = new MediaStream([track]);
      state.pipVideo.play().catch(() => {});
      renderPipView();
    } catch (e) {
      log("could not swap the popout track", e);
    }
  }

  /* --------------------------------------------------------- launch button */

  function setLaunchButtonAvailability(button) {
    // Source discovery can briefly be empty while Meet redraws ordinary
    // controls. Do not turn the entry point into a permanent-looking loading
    // button: the user click runs a fresh discovery pass in openDocPiP().
    button.disabled = false;
    const label = "Pop out this meeting into a floating window";
    const title = "Pop out this meeting";
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
    if (button.title !== title) button.title = title;
    css(button, {
      opacity: "1",
      cursor: "pointer",
    });
  }

  function updateLaunchButton() {
    if (!DOCPIP_SUPPORTED || !state.showButton || !state.enabled || !findControl("leave")) {
      state.launchButton?.remove();
      state.launchButton = null;
      return;
    }

    // Meet regularly removes and recreates its video tree while an ordinary
    // control is clicked. Keep the launcher in place through that brief gap;
    // a disabled button is much less confusing than a vanishing one.
    if (docPipOpen()) {
      state.launchButton?.remove();
      state.launchButton = null;
      return;
    }
    if (state.launchButton?.isConnected) {
      setLaunchButtonAvailability(state.launchButton);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Pop out";
    button.setAttribute("aria-label", "Pop out this meeting into a floating window");
    css(button, {
      position: "fixed",
      right: "16px",
      bottom: "96px",
      "z-index": "2147483646",
      padding: "8px 14px",
      "border-radius": "999px",
      border: "none",
      background: "#1a73e8",
      color: "#fff",
      font: "500 13px/1 system-ui, -apple-system, sans-serif",
      "box-shadow": "0 2px 10px rgba(0,0,0,0.35)",
    });
    // The click is the transient activation requestWindow() needs.
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDocPiP();
    });
    (document.body || document.documentElement).appendChild(button);
    state.launchButton = button;
    setLaunchButtonAvailability(button);
  }

  // Fallback entry point: the toolbar popup arms this, and the next click
  // anywhere in the page supplies the activation.
  document.addEventListener(
    "click",
    () => {
      if (!state.armed) return;
      state.armed = false;
      openDocPiP();
    },
    true
  );

  /* ---------------------------------------------------------------- shadow  */

  /**
   * A silent audio track. Its only job is to exist, so that mozHasAudio is true
   * when the shadow element loads metadata. Gain is zeroed, and the element is
   * muted anyway — Meet's own audio is untouched and keeps playing.
   */
  function makeSilentAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(dest);
      osc.start();
      const track = dest.stream.getAudioTracks()[0];
      if (!track) return null;
      // Not required, but keeps the graph out of a suspended state.
      ctx.resume?.().catch(() => {});
      return { ctx, track };
    } catch (e) {
      log("could not build silent audio track", e);
      return null;
    }
  }

  function createShadow(videoTrack) {
    const audio = state.audio || makeSilentAudio();
    if (!audio) return null;
    state.audio = audio;

    let stream;
    try {
      // Audio track is present up front — mozHasAudio latches at HAVE_METADATA.
      stream = new MediaStream([videoTrack, audio.track]);
    } catch (e) {
      log("could not build shadow stream", e);
      return null;
    }

    const video = document.createElement("video");
    video.setAttribute(SHADOW_ATTR, "");
    video.setAttribute("aria-hidden", "true");
    // Start in the real microphone state. Starting every new shadow muted was
    // visible as a wrong PiP icon until the next polling pass.
    video.muted = muteState.initialShadowMuted(micMuted());
    video.autoplay = true;
    video.playsInline = true;
    // Needed for focus() to take: -1 keeps it out of the tab order.
    video.tabIndex = -1;

    // Effectively invisible, but still laid out and painted. Firefox measures
    // clientWidth/clientHeight, so display:none or a smaller box would
    // disqualify it. PiP renders the decoded frames, not the CSS, so the
    // popped-out window shows the speaker at full opacity.
    video.style.cssText = [
      "position:fixed",
      "left:0",
      "bottom:0",
      `width:${MIN_DIM}px`,
      `height:${MIN_DIM}px`,
      "opacity:0.01",
      "pointer-events:none",
      "border:0",
      "margin:0",
      "padding:0",
      "z-index:-2147483647",
    ].join(";");

    video.addEventListener("volumechange", onShadowVolumeChange);
    video.addEventListener("loadeddata", mirrorMicToShadow, { once: true });
    video.srcObject = stream;
    (document.body || document.documentElement).appendChild(video);
    video.play().then(mirrorMicToShadow).catch((e) => log("shadow play rejected", e));

    state.shadowVideo = video;
    state.shadowStream = stream;
    state.videoTrack = videoTrack;
    log("shadow created");
    return video;
  }

  function setShadowTrack(videoTrack) {
    if (state.videoTrack === videoTrack) return;
    const stream = state.shadowStream;
    if (!stream) return;
    try {
      // Add first, then drop the old one, so the stream is never video-less.
      stream.addTrack(videoTrack);
      for (const t of stream.getVideoTracks()) {
        if (t !== videoTrack) stream.removeTrack(t);
      }
      state.videoTrack = videoTrack;
      if (state.shadowVideo.paused) {
        state.shadowVideo.play().catch(() => {});
      }
      log("shadow track swapped");
    } catch (e) {
      log("track swap failed", e);
    }
  }

  function destroyShadow() {
    clearTimeout(state.expectedShadowMutedTimer);
    clearTimeout(state.pendingMicTimer);
    state.expectedShadowMuted = null;
    state.pendingMicTarget = null;
    if (state.shadowVideo) {
      try {
        state.shadowVideo.srcObject = null;
        state.shadowVideo.remove();
      } catch {}
    }
    state.shadowVideo = null;
    state.shadowStream = null;
    state.videoTrack = null;
    state.targetKind = "none";
  }

  function shadowIsReady() {
    const shadow = state.shadowVideo;
    return !!(
      shadow &&
      shadow.isConnected &&
      !shadow.paused &&
      !shadow.ended &&
      shadow.readyState > 2
    );
  }

  /** Keep the shadow element warm and pointed at the current speaker. */
  function sync() {
    if (!state.enabled) {
      destroyShadow();
      return;
    }

    const source = pickBestVideo();
    const track = source && liveVideoTrack(source);

    if (!track) {
      if (docPipOpen()) {
        watchControls();
        // Meet replaces tiles during layout changes. Retain the last live
        // track briefly instead of flashing a black waiting screen.
        const currentTrack = state.pipVideo?.srcObject?.getVideoTracks?.()[0];
        if (++state.misses >= MAX_MISSES || currentTrack?.readyState !== "live") {
          updatePipVideo(null);
        }
        updatePipGallery();
        refreshPipButtons();
        state.targetKind = "docpip";
        return;
      }
      // A background tab can stop laying out its tiles while the MediaStream
      // stays live. Keep that stream in Firefox's PiP until it ends.
      if (document.visibilityState === "hidden" &&
          state.shadowVideo && state.videoTrack?.readyState === "live") {
        return;
      }
      // Meet reshuffles tiles constantly, so one empty poll usually means a
      // layout change rather than the end of the meeting. Tearing the shadow
      // element down on every blip would keep resetting its readyState.
      const maxMisses = document.visibilityState === "hidden" ? HIDDEN_MAX_MISSES : MAX_MISSES;
      if (++state.misses >= maxMisses) destroyShadow();
      updateLaunchButton();
      return;
    }
    state.misses = 0;
    watchControls();
    updateLaunchButton();

    // The popout window supersedes the chrome-side one: it is already floating
    // and has real controls, so a second window would just be in the way.
    if (docPipOpen()) {
      destroyShadow();
      updatePipVideo(track);
      updatePipGallery();
      refreshPipButtons();
      state.targetKind = "docpip";
      return;
    }

    if (!state.shadowVideo || !state.shadowVideo.isConnected) {
      destroyShadow();
      createShadow(track);
    } else {
      setShadowTrack(track);
    }

    state.targetKind = shadowIsReady() ? "shadow" : "fallback";
  }

  /* ------------------------------------------------------------- focusing  */

  /**
   * Fallback for the case where the shadow element never became playable.
   * Focusing Meet's real <video> still makes findVideoToPiP select it, but
   * eligibility then hinges on mozHasAudio, so this path only produces a popout
   * if the user has set
   * media.videocontrols.picture-in-picture.video-toggle.always-show = true.
   */
  function focusFallback() {
    const video = pickBestVideo();
    if (!video) return false;
    if (!video.hasAttribute("tabindex")) {
      video.tabIndex = -1;
      state.patchedVideo = video;
    }
    try {
      video.focus({ preventScroll: true });
    } catch {
      return false;
    }
    return document.activeElement === video;
  }

  /**
   * Put focus on whatever Firefox should pop out, remembering where it came
   * from. Safe to call repeatedly — the original focus is only recorded once,
   * so a blur followed by a tab switch does not "restore" us onto the shadow.
   */
  function borrowFocus() {
    if (!state.enabled) return false;
    if (docPipOpen()) return false;

    const previous = state.borrowed ? state.lastFocused : document.activeElement;

    let focused = false;
    if (shadowIsReady()) {
      try {
        state.shadowVideo.focus({ preventScroll: true });
        focused = document.activeElement === state.shadowVideo;
      } catch {}
      state.targetKind = focused ? "shadow" : "none";
    }
    if (!focused) {
      focused = focusFallback();
      state.targetKind = focused ? "fallback" : "none";
    }

    if (focused) {
      state.lastFocused = previous;
      state.borrowed = true;
    }
    log("borrowFocus ->", state.targetKind);
    return focused;
  }

  function releaseFocus() {
    if (!state.borrowed) return;
    const previous = state.lastFocused;
    state.lastFocused = null;
    state.borrowed = false;

    if (state.patchedVideo) {
      try {
        state.patchedVideo.removeAttribute("tabindex");
      } catch {}
      state.patchedVideo = null;
    }

    try {
      if (previous && previous.isConnected && previous !== document.body) {
        previous.focus({ preventScroll: true });
      } else if (document.activeElement?.hasAttribute?.(SHADOW_ATTR)) {
        document.activeElement.blur();
      }
    } catch {}
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      if (!state.enabled) return;
      // Keep the source current while Firefox displays the shadow in PiP.
      // Stopping here froze the tile selected at the moment of the tab switch.
      sync();
      startPolling();
      borrowFocus();
    } else {
      // Firefox closes the PiP window itself on VideoTabShown; we only have to
      // give back the focus we borrowed.
      releaseFocus();
      if (state.enabled) startPolling();
    }
  }

  /**
   * Belt and braces. A tab switch blurs the window a moment before the document
   * reports itself hidden, and focus() is unambiguously honoured while the
   * document is still the active one. The old focus is restored on return,
   * including when the user was typing in Meet chat.
   */
  function onWindowBlur() {
    if (!state.enabled) return;
    if (document.visibilityState !== "visible") return;
    if (!shadowIsReady()) return;
    borrowFocus();
  }

  function onWindowFocus() {
    if (document.visibilityState === "visible") releaseFocus();
  }

  /* ---------------------------------------------------------------- wiring */

  function startPolling() {
    if (state.pollId !== null) return;
    sync();
    state.pollId = setInterval(sync, POLL_MS);
  }

  function stopPolling() {
    if (state.pollId === null) return;
    clearInterval(state.pollId);
    state.pollId = null;
  }

  // Default group listener: runs before Firefox's own mozSystemGroup handler,
  // and well before the two async IPC hops that lead to the auto-toggle.
  document.addEventListener("visibilitychange", onVisibilityChange, true);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onWindowFocus);

  window.addEventListener("pagehide", () => {
    stopPolling();
    state.controlsObserver?.disconnect();
    state.controlsObserver = null;
    clearTimeout(state.controlsRefreshId);
    state.controlsRefreshId = null;
    state.launchButton?.remove();
    state.launchButton = null;
    clearTimeout(state.launchMessageTimer);
    // Firefox owns the Document PiP window's lifetime and closes it if this
    // page truly navigates away. Closing it ourselves here can race a transient
    // pagehide during Meet's own page transitions.
    destroyShadow();
    try {
      state.audio?.ctx.close();
    } catch {}
    state.audio = null;
  });

  browser.storage.local
    .get({ enabled: true, debug: false, showButton: true, videoSource: "stage" })
    .then((settings) => {
      state.enabled = settings.enabled;
      state.debug = settings.debug;
      state.showButton = settings.showButton;
      state.videoSource = settings.videoSource;
      if (state.enabled && document.visibilityState === "visible") startPolling();
    })
    .catch(() => startPolling());

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue;
      if (!state.enabled) {
        state.armed = false;
        closeDocPiP();
        stopPolling();
        state.controlsObserver?.disconnect();
        state.controlsObserver = null;
        clearTimeout(state.controlsRefreshId);
        state.controlsRefreshId = null;
        releaseFocus();
        destroyShadow();
        state.launchButton?.remove();
        state.launchButton = null;
      } else {
        startPolling();
      }
    }
    if (changes.debug) state.debug = changes.debug.newValue;
    if (changes.showButton) {
      state.showButton = changes.showButton.newValue;
      updateLaunchButton();
    }
    if (changes.videoSource) {
      state.videoSource = changes.videoSource.newValue;
      state.misses = 0;
      sync();
    }
  });

  // Status for the popup. Only the top frame answers, so a multi-frame page
  // cannot race two different replies back to the popup.
  if (window.top === window) {
    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === "meet-popout:open-docpip") {
        if (!DOCPIP_SUPPORTED) {
          return Promise.resolve({ ok: false, reason: "unsupported" });
        }
        if (docPipOpen()) {
          state.pipWindow.focus();
          return Promise.resolve({ ok: true, already: true });
        }
        // requestWindow() needs a gesture, and a popup click is not one for
        // this document, so wait for the next click in the page.
        state.armed = true;
        return Promise.resolve({ ok: true, armed: true });
      }
      if (message?.type === "meet-popout:control") {
        return Promise.resolve({ ok: activateControl(message.control) });
      }
      if (message?.type !== "meet-popout:status") return;
      return Promise.resolve({
        enabled: state.enabled,
        hasSource: !!pickBestVideo(),
        shadowReady: shadowIsReady(),
        targetKind: state.targetKind,
        docPipSupported: DOCPIP_SUPPORTED,
        docPipOpen: docPipOpen(),
        pipFallback: state.pipFallback,
        pipError: state.pipError,
        armed: state.armed,
        videoSource: state.videoSource,
        controls: {
          mic: !!findControl("mic"),
          camera: !!findControl("camera"),
          leave: !!findControl("leave"),
        },
      });
    });
  }
})();
