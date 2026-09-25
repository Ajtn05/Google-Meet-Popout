"use strict";

/** Discover Meet's visible participant tiles without depending on CSS classes. */
(() => {
  const ROOT_SELECTOR = "[data-participant-id], [data-allocation-index]";

  function visible(element, minSize = 32) {
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width < minSize || rect.height < minSize) return false;
    const view = element.ownerDocument.defaultView;
    return rect.bottom > 0 && rect.right > 0 &&
      rect.top < view.innerHeight && rect.left < view.innerWidth;
  }

  function photoIn(root) {
    let best = null;
    let bestArea = 0;
    for (const img of root.querySelectorAll("img")) {
      if (!visible(img, 32)) continue;
      const src = img.currentSrc || img.src;
      if (!src || !/^(https:|data:image\/|blob:)/i.test(src)) continue;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = img;
        bestArea = area;
      }
    }
    return best;
  }

  function nameNodeIn(root) {
    const marked = root.querySelector("[data-self-name], [data-participant-name]");
    if (marked) return marked;
    // Meet sometimes renders an initial instead of an <img>. The name label
    // is usually a span near the bottom of that participant tile.
    const tileBottom = root.getBoundingClientRect().bottom;
    return [...root.querySelectorAll("span")].find((span) => {
      const value = span.textContent?.trim();
      if (!value || value.length < 2 || value.length > 60 || !visible(span, 1)) return false;
      if (span.closest?.("button, [role='button']")) return false;
      return Math.abs(tileBottom - span.getBoundingClientRect().bottom) < 50;
    }) || null;
  }

  function nameIn(root, photo, nameNode) {
    const raw = nameNode?.textContent || photo?.alt || root.getAttribute("aria-label") || "";
    return raw.trim().replace(/\s+/g, " ").slice(0, 80) || "Participant";
  }

  function collect(doc, { liveTrack, isSelf, isScreen, shadowAttribute }) {
    const byId = new Map();
    const coveredVideos = new Set();
    for (const root of doc.querySelectorAll(ROOT_SELECTOR)) {
      if (!visible(root, 80)) continue;
      const videos = [...root.querySelectorAll("video")].filter(
        (video) => !video.hasAttribute(shadowAttribute) && visible(video, 32)
      );
      const video = videos.find((candidate) => liveTrack(candidate)) || null;
      const track = video ? liveTrack(video) : null;
      const photo = photoIn(root);
      const nameNode = nameNodeIn(root);
      if (!track && !photo && !nameNode && !root.getAttribute("aria-label")) continue;
      const id = root.getAttribute("data-participant-id") ||
        root.getAttribute("data-allocation-index") || `tile-${byId.size}`;
      const rect = root.getBoundingClientRect();
      const tile = {
        id,
        name: nameIn(root, photo, nameNode),
        photo: photo?.currentSrc || photo?.src || null,
        track,
        video,
        self: !!nameNode?.hasAttribute("data-self-name") || (video ? isSelf(video) : false),
        screen: track ? isScreen(track) : false,
        area: rect.width * rect.height,
      };
      const previous = byId.get(id);
      if (!previous || Number(!!tile.track) > Number(!!previous.track) ||
          (Boolean(tile.track) === Boolean(previous.track) && tile.area > previous.area)) {
        byId.set(id, tile);
      }
      for (const candidate of videos) coveredVideos.add(candidate);
    }

    // Meet occasionally omits the participant marker from a video tile.
    let fallbackIndex = 0;
    for (const video of doc.querySelectorAll("video")) {
      if (video.hasAttribute(shadowAttribute) || coveredVideos.has(video) || !visible(video, 80)) continue;
      const track = liveTrack(video);
      if (!track) continue;
      const id = `video-${track.id || fallbackIndex++}`;
      byId.set(id, {
        id,
        name: "Participant",
        photo: null,
        track,
        video,
        self: isSelf(video),
        screen: isScreen(track),
        area: video.getBoundingClientRect().width * video.getBoundingClientRect().height,
      });
    }
    // The same stream can appear in both a large stage and a thumbnail.
    const bestByTrack = new Map();
    for (const [id, tile] of byId) {
      if (!tile.track) continue;
      const previous = bestByTrack.get(tile.track);
      if (!previous || tile.area > previous.area) bestByTrack.set(tile.track, { id, area: tile.area });
    }
    for (const [id, tile] of byId) {
      if (tile.track && bestByTrack.get(tile.track)?.id !== id) byId.delete(id);
    }
    return [...byId.values()];
  }

  function select(tiles, stageVideo, limit = 4) {
    return [...tiles]
      .sort((a, b) => {
        const rank = (tile) =>
          (stageVideo && tile.video === stageVideo ? 1000 : 0) +
          (tile.screen ? 100 : 0) +
          (tile.self ? 0 : 10) +
          (tile.track ? 1 : 0);
        return rank(b) - rank(a) || b.area - a.area;
      })
      .slice(0, limit);
  }

  globalThis.MeetPopoutParticipantTiles = { collect, select };
})();
