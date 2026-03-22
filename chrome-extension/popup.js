const STORAGE_PREFIX = "caption-replacer:";
const SERVER_URL_KEY = "caption-replacer:serverUrl";
const DEFAULT_SERVER_URL = "ws://localhost:8080";

const videoStatusEl = document.getElementById("videoStatus");
const videoMetaEl = document.getElementById("videoMeta");
const captionBadgeEl = document.getElementById("captionBadge");
const serverUrlEl = document.getElementById("serverUrl");
const generateButtonEl = document.getElementById("generateButton");
const streamStatusEl = document.getElementById("streamStatus");
const fileInputEl = document.getElementById("srtFile");
const fileMetaEl = document.getElementById("fileMeta");
const clearButtonEl = document.getElementById("clearButton");
const filePickerLabelEl = document.querySelector(".file-picker");

let currentTab = null;
let currentVideoId = null;
let statusPollTimer = null;
let captionsLoaded = false;
let generationActive = false;
let manualFileName = null;

function getStorageKey(videoId) {
  return `${STORAGE_PREFIX}${videoId}`;
}

function parseVideoIdFromUrl(urlString) {
  try {
    const url = new URL(urlString);

    if (url.hostname !== "www.youtube.com" || url.pathname !== "/watch") {
      return null;
    }

    return url.searchParams.get("v");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStreamStatus(message) {
  streamStatusEl.textContent = message;
}

function setBadge(loaded) {
  captionsLoaded = loaded;

  if (loaded) {
    captionBadgeEl.textContent = "Loaded";
    captionBadgeEl.classList.remove("unloaded");
    captionBadgeEl.classList.add("loaded");
  } else {
    captionBadgeEl.textContent = "Unloaded";
    captionBadgeEl.classList.remove("loaded");
    captionBadgeEl.classList.add("unloaded");
  }

  syncControls();
}

function syncControls() {
  const hasVideo = Boolean(currentVideoId);
  const blockGenerate = !hasVideo || captionsLoaded || generationActive;

  serverUrlEl.disabled = !hasVideo;
  generateButtonEl.disabled = blockGenerate;
  clearButtonEl.disabled = !hasVideo;
  fileInputEl.disabled = !hasVideo;
  filePickerLabelEl.classList.toggle("disabled", !hasVideo);
}

function applySource(source) {
  if (source === "file") {
    streamStatusEl.classList.add("hidden");
    if (manualFileName) {
      fileMetaEl.textContent = manualFileName;
      fileMetaEl.classList.remove("hidden");
    }
  } else if (source === "server") {
    fileMetaEl.classList.add("hidden");
    streamStatusEl.classList.remove("hidden");
  } else {
    fileMetaEl.classList.add("hidden");
    streamStatusEl.classList.remove("hidden");
  }
}

function showFileMeta(name) {
  manualFileName = name;
  fileMetaEl.textContent = name;
  fileMetaEl.classList.remove("hidden");
}

function hideFileMeta() {
  manualFileName = null;
  fileMetaEl.classList.add("hidden");
  fileMetaEl.textContent = "";
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendMessageToActiveTab(message) {
  if (!currentTab || typeof currentTab.id !== "number") {
    return null;
  }

  try {
    return await chrome.tabs.sendMessage(currentTab.id, message);
  } catch {
    return null;
  }
}

async function ensureContentScriptReady() {
  if (!currentTab || typeof currentTab.id !== "number") {
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      type: "CAPTION_REPLACER_PING"
    });

    if (response?.ok) {
      return;
    }
  } catch {
    // Fall through to script injection.
  }

  await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    files: ["content.js"]
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function hasStoredCaptions(videoId) {
  const stored = await chrome.storage.local.get(getStorageKey(videoId));
  const value = stored[getStorageKey(videoId)];
  return typeof value === "string" && value.length > 0;
}

async function loadServerUrl() {
  const stored = await chrome.storage.local.get(SERVER_URL_KEY);
  return stored[SERVER_URL_KEY] || DEFAULT_SERVER_URL;
}

async function saveServerUrl(url) {
  await chrome.storage.local.set({ [SERVER_URL_KEY]: url });
}

function getWsUrl() {
  const raw = serverUrlEl.value.trim() || DEFAULT_SERVER_URL;
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

function applyStatus(state) {
  if (!state || !state.ok) {
    return;
  }

  generationActive = state.active;
  const hasCues = state.cueCount > 0;

  setBadge(hasCues);

  if (state.active && state.status === "connecting") {
    setStreamStatus("Connecting...");
  } else if (state.active && state.status === "receiving") {
    setStreamStatus(`Receiving captions... (${state.cueCount} cues)`);
  } else if (state.status === "done" || state.status === "done_cached") {
    setStreamStatus(`Loaded ${state.cueCount} cues.`);
  } else if (state.status === "error") {
    setStreamStatus(state.error || "Server error.");
  }

  if (state.captionSource === "file" && state.captionFileName) {
    manualFileName = state.captionFileName;
  }

  applySource(state.captionSource);
  syncControls();
}

async function pollStatus() {
  const response = await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_GET_STATUS"
  });

  if (response) {
    applyStatus(response);
  }

  if (response?.active) {
    statusPollTimer = setTimeout(pollStatus, 400);
  } else {
    statusPollTimer = null;
  }
}

function startPolling() {
  if (statusPollTimer) {
    return;
  }

  void pollStatus();
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

async function startGeneration() {
  if (!currentVideoId || captionsLoaded || generationActive) {
    return;
  }

  await ensureContentScriptReady();

  const response = await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_GET_STATUS"
  });

  if (response?.active) {
    return;
  }

  const serverUrl = getWsUrl();
  await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_START_GENERATION",
    serverUrl
  });

  generationActive = true;
  setStreamStatus("Connecting...");
  syncControls();
  startPolling();
}

// ---------------------------------------------------------------------------
// File picker
// ---------------------------------------------------------------------------

async function handleFileSelection(event) {
  const file = event.target.files?.[0];

  if (!file || !currentVideoId) {
    return;
  }

  try {
    await ensureContentScriptReady();
    const srtText = await file.text();

    if (!srtText.trim()) {
      throw new Error("The selected SRT file is empty.");
    }

    await chrome.storage.local.set({
      [getStorageKey(currentVideoId)]: srtText
    });

    await sendMessageToActiveTab({
      type: "CAPTION_REPLACER_APPLY_SRT",
      videoId: currentVideoId,
      srtText,
      fileName: file.name
    });

    showFileMeta(file.name);
    setBadge(true);
    applySource("file");
  } catch (error) {
    setStreamStatus(error.message || "Failed to read the selected SRT file.");
  } finally {
    fileInputEl.value = "";
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

async function handleClear() {
  if (!currentVideoId) {
    return;
  }

  await ensureContentScriptReady();
  await chrome.storage.local.remove(getStorageKey(currentVideoId));
  await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_CLEAR_SRT",
    videoId: currentVideoId
  });

  setBadge(false);
  hideFileMeta();
  setStreamStatus("");
  applySource("");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function refreshPopupState() {
  currentTab = await getActiveTab();
  const tabUrl = currentTab?.url || "";
  currentVideoId = parseVideoIdFromUrl(tabUrl);

  serverUrlEl.value = await loadServerUrl();

  if (!currentVideoId) {
    videoStatusEl.textContent = "Open a YouTube watch page first.";
    videoMetaEl.textContent = "";
    setBadge(false);
    syncControls();
    return;
  }

  videoStatusEl.textContent = "Ready to replace captions.";
  videoMetaEl.textContent = `Video ID: ${currentVideoId}`;

  await ensureContentScriptReady();

  const hasCaptions = await hasStoredCaptions(currentVideoId);
  setBadge(hasCaptions);

  const status = await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_GET_STATUS"
  });

  if (status) {
    applyStatus(status);

    if (status.active) {
      startPolling();
    }
  }
}

serverUrlEl.addEventListener("change", () => {
  void saveServerUrl(serverUrlEl.value.trim());
});

generateButtonEl.addEventListener("click", () => {
  void startGeneration();
});

fileInputEl.addEventListener("change", handleFileSelection);

clearButtonEl.addEventListener("click", () => {
  void handleClear();
});

void refreshPopupState();
