"use strict";

/**
 * Pure decisions for keeping Firefox PiP's media mute button in step with
 * Google Meet's microphone. Keeping this small state machine separate lets us
 * test the timing-sensitive cases without a live browser PiP window.
 */
(() => {
  function initialShadowMuted(meetMuted) {
    return typeof meetMuted === "boolean" ? meetMuted : true;
  }

  function fromMeetState({ shadowMuted, meetMuted, pendingTarget }) {
    if (typeof meetMuted !== "boolean") return { action: "none" };
    if (pendingTarget !== null && meetMuted !== pendingTarget) {
      return { action: "wait" };
    }
    return {
      action: shadowMuted === meetMuted ? "none" : "set-shadow",
      muted: meetMuted,
      clearPending: pendingTarget !== null && meetMuted === pendingTarget,
    };
  }

  function fromShadowVolumeChange({
    shadowMuted,
    expectedShadowMuted,
    pendingTarget,
    meetMuted,
  }) {
    if (expectedShadowMuted === shadowMuted) {
      return { action: "ignore", clearExpected: true };
    }
    if (typeof meetMuted !== "boolean") return { action: "ignore" };
    if (shadowMuted === meetMuted || pendingTarget === shadowMuted) {
      return { action: "ignore" };
    }
    return { action: "toggle-meet", target: shadowMuted };
  }

  globalThis.MeetPopoutMuteState = {
    initialShadowMuted,
    fromMeetState,
    fromShadowVolumeChange,
  };
})();
