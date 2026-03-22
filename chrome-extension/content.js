const STORAGE_PREFIX = "caption-replacer:";
const HIDE_STYLE_ID = "yt-srt-hide-native-captions-style";
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
let generationState = {
  active: false,
  status: "",
  cueCount: 0,
  error: ""
};

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

  const captionsEnabledInUi = areCaptionsEnabledInUi();

  if (captionsEnabledInUi) {
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
  const entry = stored[getStorageKey(videoId)];

  if (!entry || typeof entry.srtText !== "string") {
    clearCustomCaptions();
    return;
  }

  applySrtText(entry.srtText, videoId);
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

  await chrome.storage.local.set({
    [getStorageKey(videoId)]: {
      fileName: "generated-captions.srt",
      srtText,
      updatedAt: Date.now()
    }
  });
}

function startGeneration(serverUrl) {
  if (generationWs) {
    stopGeneration();
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
  const wsUrl = `${wsBase}/captions?url=${encodeURIComponent(window.location.href)}`;

  const ws = new WebSocket(wsUrl);
  generationWs = ws;

  ws.addEventListener("open", () => {
    generationState.status = "receiving";
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

      if (!videoEl || !rafId) {
        try {
          startRendering();
        } catch {
          // Ignore if video element is not available yet.
        }
      }
    }

    if (data.type === "done") {
      generationState.active = false;
      generationState.status = data.cached ? "done_cached" : "done";
      generationWs = null;
      saveGeneratedSrt();
    }

    if (data.type === "error") {
      generationState.active = false;
      generationState.status = "error";
      generationState.error = data.message || "Server error.";
      generationWs = null;
    }
  });

  ws.addEventListener("error", () => {
    if (generationWs !== ws) {
      return;
    }

    generationState.active = false;
    generationState.status = "error";
    generationState.error = "Could not connect to the caption server.";
    generationWs = null;
  });

  ws.addEventListener("close", () => {
    if (generationWs === ws) {
      generationWs = null;

      if (generationState.active) {
        generationState.active = false;
      }
    }
  });
}

function stopGeneration() {
  if (generationWs) {
    generationWs.close();
    generationWs = null;
  }

  generationState.active = false;
  generationState.status = generationState.cueCount > 0 ? "stopped" : "";
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

    if (message?.type === "CAPTION_REPLACER_STOP_GENERATION") {
      stopGeneration();
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_GET_STATUS") {
      sendResponse({ ok: true, ...generationState });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_APPLY_SRT") {
      applySrtText(message.srtText || "", message.videoId);
      sendResponse({ ok: true, cueCount: cues.length });
      return true;
    }

    if (message?.type === "CAPTION_REPLACER_CLEAR_SRT") {
      if (message.videoId === getCurrentVideoId()) {
        stopGeneration();
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

  if (change.newValue?.srtText) {
    applySrtText(change.newValue.srtText, videoId);
  } else {
    clearCustomCaptions();
  }
});

const observer = new MutationObserver(() => {
  if (cues.length && overlayEl && !overlayEl.isConnected) {
    ensureOverlay();
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });

void loadStoredCaptionsForCurrentVideo();
