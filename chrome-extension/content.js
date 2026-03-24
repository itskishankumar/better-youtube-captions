const STORAGE_PREFIX = "caption-replacer:";
const HIDE_STYLE_ID = "yt-srt-hide-native-captions-style";
const HIDE_SETTINGS_STYLE_ID = "yt-srt-hide-settings-subtitle-style";
const DEFAULT_SERVER_URL = "ws://localhost:8080";

let currentVideoId = null;
let cues = [];
let overlayEl = null;
let textEl = null;
let videoEl = null;
let rafId = null;

// ---------------------------------------------------------------------------
// Generation state (WebSocket lives here, survives popup close)
// ---------------------------------------------------------------------------

let generationWs = null;
let captionSource = "";
let captionFileName = "";
let generationState = {
  active: false,
  status: "",
  cueCount: 0,
  error: ""
};
let seekListener = null;
let seekDebounceTimer = null;
let coverageBarEl = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStorageKey(videoId) {
  return `${STORAGE_PREFIX}${videoId}`;
}

function getCurrentVideoId() {
  try {
    const url = new URL(window.location.href);

    if (!url.hostname.endsWith("youtube.com") || url.pathname !== "/watch") {
      return null;
    }

    return url.searchParams.get("v");
  } catch {
    return null;
  }
}

function parseTimestamp(raw) {
  const cleaned = raw.trim().replace(",", ".");
  const parts = cleaned.split(":");

  if (parts.length !== 3) {
    return null;
  }

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);

  if ([hours, minutes, seconds].some(Number.isNaN)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function parseSrt(srtText) {
  const blocks = srtText
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);

  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim());

    if (!lines.length) {
      continue;
    }

    let idx = 0;

    if (/^\d+$/.test(lines[0])) {
      idx = 1;
    }

    if (!lines[idx]) {
      continue;
    }

    const timeMatch = lines[idx].match(
      /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})$/
    );

    if (!timeMatch) {
      continue;
    }

    const start = parseTimestamp(timeMatch[1]);
    const end = parseTimestamp(timeMatch[2]);

    if (start == null || end == null || end <= start) {
      continue;
    }

    const text = lines.slice(idx + 1).join("\n").trim();

    if (!text) {
      continue;
    }

    parsed.push({ start, end, text });
  }

  return parsed.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Caption overlay
// ---------------------------------------------------------------------------

function ensureOverlay() {
  const container = document.querySelector(".html5-video-player");

  if (!container) {
    return false;
  }

  if (!overlayEl) {
    overlayEl = document.createElement("div");
    overlayEl.id = "yt-srt-custom-caption-overlay";
    overlayEl.style.position = "absolute";
    overlayEl.style.left = "0";
    overlayEl.style.right = "0";
    overlayEl.style.bottom = "12%";
    overlayEl.style.display = "flex";
    overlayEl.style.justifyContent = "center";
    overlayEl.style.pointerEvents = "none";
    overlayEl.style.zIndex = "10000";

    textEl = document.createElement("div");
    textEl.style.maxWidth = "90%";
    textEl.style.padding = "6px 10px";
    textEl.style.fontSize = "clamp(16px, 2.5vw, 28px)";
    textEl.style.lineHeight = "1.3";
    textEl.style.whiteSpace = "pre-line";
    textEl.style.textAlign = "center";
    textEl.style.color = "#fff";
    textEl.style.textShadow =
      "0 0 2px rgba(0,0,0,.9), 0 0 8px rgba(0,0,0,.8), 0 0 12px rgba(0,0,0,.8)";
    textEl.style.background = "rgba(0, 0, 0, 0.45)";
    textEl.style.borderRadius = "6px";
    textEl.style.visibility = "hidden";

    overlayEl.appendChild(textEl);
    container.appendChild(overlayEl);
  } else if (!overlayEl.isConnected) {
    container.appendChild(overlayEl);
  }

  return true;
}

function ensureCoverageBar() {
  const progressBar = document.querySelector(".ytp-progress-bar-container");
  if (!progressBar || !progressBar.parentElement) return false;

  if (!coverageBarEl) {
    coverageBarEl = document.createElement("div");
    coverageBarEl.id = "yt-srt-coverage-bar";
    coverageBarEl.style.cssText = [
      "position: absolute",
      `top: ${progressBar.offsetTop + progressBar.offsetHeight}px`,
      `left: ${progressBar.offsetLeft}px`,
      `width: ${progressBar.offsetWidth}px`,
      "height: 10px",
      "background: rgba(255,255,255,0.08)",
      "pointer-events: none",
      "z-index: 10000",
      "transition: opacity .3s",
    ].join(";");
    progressBar.parentElement.appendChild(coverageBarEl);
  } else if (!coverageBarEl.isConnected) {
    progressBar.parentElement.appendChild(coverageBarEl);
  }

  return true;
}

function updateCoverageBar() {
  if (!ensureCoverageBar() || !videoEl) return;

  const duration = videoEl.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    coverageBarEl.style.opacity = "0";
    return;
  }

  if (cues.length === 0) {
    coverageBarEl.innerHTML = "";
    coverageBarEl.style.opacity = "0";
    return;
  }

  // Merge cues into contiguous coverage ranges
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const ranges = [];
  let cur = { start: sorted[0].start, end: sorted[0].end };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= cur.end + 0.5) {
      cur.end = Math.max(cur.end, sorted[i].end);
    } else {
      ranges.push(cur);
      cur = { start: sorted[i].start, end: sorted[i].end };
    }
  }
  ranges.push(cur);

  coverageBarEl.style.opacity = "1";
  coverageBarEl.innerHTML = ranges
    .map((r) => {
      const left = ((r.start / duration) * 100).toFixed(3);
      const width = (((r.end - r.start) / duration) * 100).toFixed(3);
      return `<div style="position:absolute;top:0;height:100%;left:${left}%;width:${width}%;background:rgba(0,210,100,0.8);border-radius:1px;min-width:1px"></div>`;
    })
    .join("");
}

function removeCoverageBar() {
  if (coverageBarEl) {
    coverageBarEl.remove();
    coverageBarEl = null;
  }
}

function getSubtitlesButton() {
  return (
    document.querySelector(".ytp-subtitles-button") ||
    document.querySelector('[aria-keyshortcuts="c"]')
  );
}

function areCaptionsEnabledInUi() {
  const button = getSubtitlesButton();

  if (!button) {
    return true;
  }

  const ariaPressed = button.getAttribute("aria-pressed");
  const ariaChecked = button.getAttribute("aria-checked");

  if (ariaPressed === "true" || ariaChecked === "true") {
    return true;
  }

  if (ariaPressed === "false" || ariaChecked === "false") {
    return false;
  }

  const title =
    button.getAttribute("title") ||
    button.getAttribute("aria-label") ||
    button.textContent ||
    "";

  if (/captions.*off|subtitles.*off/i.test(title)) {
    return true;
  }

  if (/captions.*on|subtitles.*on/i.test(title)) {
    return false;
  }

  return true;
}

function hideNativeCaptions() {
  if (document.getElementById(HIDE_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  style.textContent = `
    .ytp-caption-window-container,
    .caption-window.ytp-caption-window-bottom {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function showNativeCaptions() {
  document.getElementById(HIDE_STYLE_ID)?.remove();
}

function enableSettingsSubtitleHiding() {
  if (document.getElementById(HIDE_SETTINGS_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HIDE_SETTINGS_STYLE_ID;
  style.textContent = `
    .ytp-menuitem[data-caption-replacer-hidden="true"] {
      display: none !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function disableSettingsSubtitleHiding() {
  document.getElementById(HIDE_SETTINGS_STYLE_ID)?.remove();

  for (const item of document.querySelectorAll('[data-caption-replacer-hidden]')) {
    item.removeAttribute("data-caption-replacer-hidden");
  }
}

function markSubtitlesSettingsMenuItems() {
  for (const item of document.querySelectorAll(".ytp-menuitem")) {
    const label = item.querySelector(".ytp-menuitem-label");

    if (label && /subtitles|closed captions/i.test(label.textContent)) {
      item.setAttribute("data-caption-replacer-hidden", "true");
    }
  }
}

function insertCuesChronologically(existing, incoming) {
  const combined = [...existing, ...incoming];

  combined.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }

    return a.end - b.end;
  });

  return combined;
}

function findCurrentCue(timeSec) {
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];

    if (timeSec >= cue.start && timeSec <= cue.end) {
      return cue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function renderLoop() {
  if (!videoEl || !textEl || !cues.length) {
    if (textEl) {
      textEl.style.visibility = "hidden";
      textEl.textContent = "";
    }

    rafId = requestAnimationFrame(renderLoop);
    return;
  }

  if (areCaptionsEnabledInUi()) {
    hideNativeCaptions();
  } else {
    showNativeCaptions();
    textEl.textContent = "";
    textEl.style.visibility = "hidden";
    rafId = requestAnimationFrame(renderLoop);
    return;
  }

  const cue = findCurrentCue(videoEl.currentTime);

  if (cue) {
    if (textEl.textContent !== cue.text) {
      textEl.textContent = cue.text;
    }

    textEl.style.visibility = "visible";
  } else {
    textEl.textContent = "";
    textEl.style.visibility = "hidden";
  }

  rafId = requestAnimationFrame(renderLoop);
}

function startRendering() {
  videoEl = document.querySelector("video");

  if (!videoEl) {
    throw new Error("No video element found on this page.");
  }

  if (!ensureOverlay()) {
    throw new Error("Could not attach caption overlay.");
  }

  hideNativeCaptions();
  enableSettingsSubtitleHiding();
  markSubtitlesSettingsMenuItems();

  if (videoEl && !seekListener) {
    seekListener = () => {
      if (!generationWs || generationWs.readyState !== WebSocket.OPEN) return;

      if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
      seekDebounceTimer = setTimeout(() => {
        const ts = videoEl.currentTime;
        generationWs.send(JSON.stringify({ type: "seek", timestamp: ts }));
      }, 500);
    };
    videoEl.addEventListener("seeking", seekListener);
  }

  if (!rafId) {
    rafId = requestAnimationFrame(renderLoop);
  }
}

function stopRendering() {
  if (!rafId) {
    return;
  }

  cancelAnimationFrame(rafId);
  rafId = null;
}

function clearCustomCaptions() {
  cues = [];
  showNativeCaptions();
  disableSettingsSubtitleHiding();
  stopRendering();

  if (videoEl && seekListener) {
    videoEl.removeEventListener("seeking", seekListener);
    seekListener = null;
  }
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer);
    seekDebounceTimer = null;
  }

  if (generationWs) {
    generationWs.close();
    generationWs = null;
  }

  removeCoverageBar();

  captionSource = "";
  captionFileName = "";
  generationState = { active: false, status: "", cueCount: 0, error: "" };

  if (textEl) {
    textEl.textContent = "";
    textEl.style.visibility = "hidden";
  }
}

function applySrtText(srtText, videoId) {
  if (videoId !== getCurrentVideoId()) {
    return;
  }

  const parsed = parseSrt(srtText);

  if (!parsed.length) {
    clearCustomCaptions();
    return;
  }

  currentVideoId = videoId;
  cues = parsed;
  startRendering();
  updateCoverageBar();
}

async function loadStoredCaptionsForCurrentVideo() {
  const videoId = getCurrentVideoId();
  currentVideoId = videoId;

  if (!videoId) {
    clearCustomCaptions();
    stopRendering();
    return;
  }

  const stored = await chrome.storage.local.get(getStorageKey(videoId));
  const srtText = stored[getStorageKey(videoId)];

  if (typeof srtText !== "string" || !srtText) {
    clearCustomCaptions();
    return;
  }

  applySrtText(srtText, videoId);
}

// ---------------------------------------------------------------------------
// Realtime generation (WebSocket managed here, not in popup)
// ---------------------------------------------------------------------------

function formatTimestamp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);

  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

async function saveGeneratedSrt() {
  const videoId = getCurrentVideoId();

  if (!videoId || cues.length === 0) {
    return;
  }

  const srtText = cues
    .map((cue, i) => `${i + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`)
    .join("\n\n") + "\n";

  await chrome.storage.local.set({ [getStorageKey(videoId)]: srtText });
}

function startGeneration(serverUrl) {
  if (generationWs) {
    return;
  }

  const videoId = getCurrentVideoId();

  if (!videoId) {
    return;
  }

  clearCustomCaptions();
  currentVideoId = videoId;

  try {
    startRendering();
  } catch {
    // Video element may not be ready yet.
  }

  generationState = { active: true, status: "connecting", cueCount: 0, error: "" };

  const wsBase = (serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  const currentTime = videoEl ? Math.floor(videoEl.currentTime) : 0;
  let wsUrl = `${wsBase}/captions?url=${encodeURIComponent(window.location.href)}`;
  if (currentTime > 5) {
    wsUrl += `&t=${currentTime}`;
  }

  const ws = new WebSocket(wsUrl);
  generationWs = ws;

  ws.addEventListener("open", () => {
    generationState.status = "receiving";
    captionSource = "server";
  });

  ws.addEventListener("message", (event) => {
    let data;

    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "cues" && Array.isArray(data.cues)) {
      cues = insertCuesChronologically(cues, data.cues);
      generationState.cueCount = cues.length;

      // Re-activate if cues arrive after a previous "done" (seek-triggered pipeline)
      if (!generationState.active) {
        generationState.active = true;
        generationState.status = "receiving";
      }

      if (!videoEl || !rafId) {
        try {
          startRendering();
        } catch {
          // Ignore if video element is not available yet.
        }
      }

      updateCoverageBar();
    }

    if (data.type === "done") {
      generationState.active = false;
      generationState.status = data.cached ? "done_cached" : "done";
      captionSource = "server";
      saveGeneratedSrt();

      if (data.cached) {
        // Cached data fully delivered — close WS, no pipelines to keep alive
        if (generationWs === ws) generationWs = null;
        ws.close();
      }
    }

    if (data.type === "error") {
      generationState.active = false;
      generationState.status = "error";
      generationState.error = data.message || "Server error.";
    }
  });

  ws.addEventListener("error", () => {
    if (generationWs !== ws) return;

    generationState.active = false;
    generationState.status = "error";
    generationState.error = "Could not connect to the caption server.";
    generationWs = null;
  });

  ws.addEventListener("close", () => {
    if (generationWs !== ws) return;

    generationWs = null;
    generationState.active = false;
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message?.type === "CAPTION_REPLACER_PING") {
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_START_GENERATION") {
      startGeneration(message.serverUrl);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_GET_STATUS") {
      sendResponse({ ok: true, ...generationState, cueCount: cues.length, captionSource, captionFileName });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_APPLY_SRT") {
      applySrtText(message.srtText || "", message.videoId);
      captionSource = "file";
      captionFileName = message.fileName || "";
      sendResponse({ ok: true, cueCount: cues.length });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_CLEAR_SRT") {
      if (message.videoId === getCurrentVideoId()) {
        clearCustomCaptions();
      }

      sendResponse({ ok: true });
      return true;
    }

    sendResponse({ ok: false, error: "Unsupported message type." });
    return true;
  } catch (error) {
    sendResponse({ ok: false, error: error.message || "Unknown error." });
    return true;
  }
});

// ---------------------------------------------------------------------------
// Storage change listener and DOM observer
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const videoId = getCurrentVideoId();

  if (!videoId) {
    return;
  }

  const key = getStorageKey(videoId);
  const change = changes[key];

  if (!change) {
    return;
  }

  if (typeof change.newValue === "string" && change.newValue) {
    applySrtText(change.newValue, videoId);
  } else {
    clearCustomCaptions();
  }
});

function handleVideoChange() {
  const newVideoId = getCurrentVideoId();

  if (newVideoId === currentVideoId) {
    return;
  }

  clearCustomCaptions();
  void loadStoredCaptionsForCurrentVideo();
}

document.addEventListener("yt-navigate-finish", handleVideoChange);

window.addEventListener("popstate", handleVideoChange);

const observer = new MutationObserver(() => {
  if (cues.length && overlayEl && !overlayEl.isConnected) {
    ensureOverlay();
  }

  if (document.getElementById(HIDE_SETTINGS_STYLE_ID)) {
    markSubtitlesSettingsMenuItems();
  }

  handleVideoChange();
});

observer.observe(document.documentElement, { childList: true, subtree: true });

void loadStoredCaptionsForCurrentVideo();
