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
  const SHADOW_ATTR = "data-meet-popout-shadow";

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
    micButton: null,
    suppressVolumeChange: false,
    pipWindow: null,
    pipVideo: null,
    pipButtons: null,
    launchButton: null,
    armed: false,
    showButton: true,
    videoSource: "stage", // "stage" | "screen" | "self" | "largest"
    micObserver: null,
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
      const settings = track.getSettings?.() || {};
      candidates.push({
        video,
        area: r.width * r.height,
        self: isLikelySelfView(video),
        // Screen-share tracks expose displaySurface in Firefox and Chromium.
        screen: !!settings.displaySurface,
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
    camera: [/camera/i],
    leave: [/leave call/i, /end call/i, /hang ?up/i],
  };

  function labelOf(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("data-tooltip") ||
      el.getAttribute("title") ||
      ""
    );
  }

  function findControl(kind) {
    const matchers = CONTROL_MATCHERS[kind];
    if (!matchers) return null;
    const candidates = document.querySelectorAll(
      "[data-is-muted], button[aria-label], [role='button'][aria-label], [data-tooltip]"
    );
    for (const el of candidates) {
      const label = labelOf(el);
      if (label && matchers.some((m) => m.test(label))) return el;
    }
    return null;
  }

  function activateControl(kind) {
    const button = findControl(kind);
    if (!button) return false;
    try {
      button.click();
    } catch {
      return false;
    }
    // Meet updates its button attributes asynchronously.
    setTimeout(mirrorMicToShadow, 120);
    return true;
  }

  /** true = off/muted, false = live, null = could not tell. */
  function controlMuted(kind) {
    const button = findControl(kind);
    if (!button) return null;
    const attr = button.getAttribute("data-is-muted");
    if (attr === "true") return true;
    if (attr === "false") return false;
    const label = labelOf(button);
    if (/turn on|unmute/i.test(label)) return true;
    if (/turn off|^mute/i.test(label)) return false;
    return null;
  }

  const micMuted = () => controlMuted("mic");

  /** Push Meet's mic state onto the shadow element so the PiP icon agrees. */
  function mirrorMicToShadow() {
    if (!shadowIsReady()) return;
    const muted = micMuted();
    if (muted === null) return;
    const shadow = state.shadowVideo;
    if (shadow.muted === muted) return;
    state.suppressVolumeChange = true;
    shadow.muted = muted;
    setTimeout(() => {
      state.suppressVolumeChange = false;
    }, 0);
  }

  /** Someone pressed mute in the PiP window. */
  function onShadowVolumeChange() {
    if (state.suppressVolumeChange) return;
    const muted = micMuted();
    if (muted === null) return;
    if (state.shadowVideo && state.shadowVideo.muted !== muted) {
      activateControl("mic");
    }
  }

  /**
   * Watch the mic button directly rather than polling, so the PiP icon still
   * tracks the real state while the tab is hidden and polling is stopped.
   */
  function watchMicButton() {
    const button = findControl("mic");
    if (!button || button === state.micButton) return;
    state.micObserver?.disconnect();
    state.micButton = button;
    state.micObserver = new MutationObserver(() => mirrorMicToShadow());
    state.micObserver.observe(button, { attributes: true });
    mirrorMicToShadow();
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

  const DOCPIP_SUPPORTED = typeof window.documentPictureInPicture !== "undefined";
  const SVG_NS = "http://www.w3.org/2000/svg";

  const ICON_PATHS = {
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
      const isOff = off === true;
      button.dataset.active = isOff ? "1" : "";
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
    video.srcObject = new MediaStream([track]);
    doc.body.appendChild(video);
    video.play().catch(() => {});
    state.pipVideo = video;

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
    // Touch and small windows never get a hover, so show it briefly on open.
    reveal(true);
    pipWindow.setTimeout(() => reveal(false), 2500);

    const buttons = {
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
          activateControl("leave");
          closeDocPiP();
        },
      }),
    };
    state.pipButtons = buttons;
    bar.append(buttons.mic, buttons.camera, buttons.leave);
    refreshPipButtons();
  }

  /**
   * Must be called from a user gesture — requestWindow() throws NotAllowedError
   * without transient activation, and there is no way around that in Firefox.
   */
  async function openDocPiP() {
    if (!DOCPIP_SUPPORTED) return false;
    if (docPipOpen()) {
      state.pipWindow.focus();
      return true;
    }

    const source = pickBestVideo();
    const track = source && liveVideoTrack(source);
    if (!track) return false;

    let pipWindow;
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 420,
        height: 280,
      });
    } catch (e) {
      log("requestWindow rejected", e);
      return false;
    }

    state.pipWindow = pipWindow;
    state.videoTrack = track;
    try {
      buildPipUI(pipWindow, track);
    } catch (e) {
      log("could not build the popout UI", e);
    }

    pipWindow.addEventListener("pagehide", () => {
      state.pipWindow = null;
      state.pipVideo = null;
      state.pipButtons = null;
      updateLaunchButton();
      if (document.visibilityState === "visible") startPolling();
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
        state.pipWindow.close();
      } catch {}
    }
  }

  /** Follow the active speaker without rebuilding the window. */
  function updatePipVideo(track) {
    if (!docPipOpen() || !state.pipVideo) return;
    const current = state.pipVideo.srcObject;
    if (current && current.getVideoTracks()[0] === track) return;
    try {
      state.pipVideo.srcObject = new MediaStream([track]);
      state.pipVideo.play().catch(() => {});
    } catch (e) {
      log("could not swap the popout track", e);
    }
  }

  /* --------------------------------------------------------- launch button */

  function updateLaunchButton() {
    if (!DOCPIP_SUPPORTED || !state.showButton) {
      state.launchButton?.remove();
      state.launchButton = null;
      return;
    }

    const wanted = !!pickBestVideo() && !docPipOpen();
    if (!wanted) {
      state.launchButton?.remove();
      state.launchButton = null;
      return;
    }
    if (state.launchButton?.isConnected) return;

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
      cursor: "pointer",
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
    video.muted = true;
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
    video.srcObject = stream;
    (document.body || document.documentElement).appendChild(video);
    video.play().catch((e) => log("shadow play rejected", e));

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
      // Meet reshuffles tiles constantly, so one empty poll usually means a
      // layout change rather than the end of the meeting. Tearing the shadow
      // element down on every blip would keep resetting its readyState.
      if (++state.misses >= MAX_MISSES) destroyShadow();
      updateLaunchButton();
      return;
    }
    state.misses = 0;
    watchMicButton();
    updateLaunchButton();

    // The popout window supersedes the chrome-side one: it is already floating
    // and has real controls, so a second window would just be in the way.
    if (docPipOpen()) {
      destroyShadow();
      updatePipVideo(track);
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

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

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
      // The popout follows the active speaker, so it needs the poll to keep
      // running while the tab is in the background.
      if (!docPipOpen()) stopPolling();
      borrowFocus();
    } else {
      // Firefox closes the PiP window itself on VideoTabShown; we only have to
      // give back the focus we borrowed.
      releaseFocus();
      startPolling();
    }
  }

  /**
   * Belt and braces. A tab switch blurs the window a moment before the document
   * reports itself hidden, and focus() is unambiguously honoured while the
   * document is still the active one. Skipped while typing, so this never
   * interrupts the chat box; the visibilitychange path still covers that case.
   */
  function onWindowBlur() {
    if (!state.enabled) return;
    if (document.visibilityState !== "visible") return;
    if (isEditable(document.activeElement)) return;
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
    state.micObserver?.disconnect();
    state.micObserver = null;
    state.micButton = null;
    state.launchButton?.remove();
    state.launchButton = null;
    closeDocPiP();
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
      if (document.visibilityState === "visible") startPolling();
    })
    .catch(() => startPolling());

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue;
      if (!state.enabled) {
        releaseFocus();
        destroyShadow();
      } else {
        sync();
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
