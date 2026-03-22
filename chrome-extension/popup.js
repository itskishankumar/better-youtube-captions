const STORAGE_PREFIX = "caption-replacer:";
const SERVER_URL_KEY = "caption-replacer:serverUrl";
const DEFAULT_SERVER_URL = "ws://localhost:8080";

const videoStatusEl = document.getElementById("videoStatus");
const videoMetaEl = document.getElementById("videoMeta");
const serverUrlEl = document.getElementById("serverUrl");
const generateButtonEl = document.getElementById("generateButton");
const streamStatusEl = document.getElementById("streamStatus");
const fileInputEl = document.getElementById("srtFile");
const fileMetaEl = document.getElementById("fileMeta");
const clearButtonEl = document.getElementById("clearButton");
const statusMessageEl = document.getElementById("statusMessage");
const filePickerLabelEl = document.querySelector(".file-picker");

let currentTab = null;
let currentVideoId = null;
let statusPollTimer = null;

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

function setStatus(message, type = "") {
  statusMessageEl.textContent = message;
  statusMessageEl.classList.remove("error", "success");

  if (type) {
    statusMessageEl.classList.add(type);
  }
}

function setStreamStatus(message) {
  streamStatusEl.textContent = message;
}

function setControlsEnabled(enabled) {
  fileInputEl.disabled = !enabled;
  clearButtonEl.disabled = !enabled;
  filePickerLabelEl.classList.toggle("disabled", !enabled);
}

function updateGenerateButton(generating) {
  if (generating) {
    generateButtonEl.textContent = "Stop";
    generateButtonEl.classList.add("generating");
  } else {
    generateButtonEl.textContent = "Generate Captions";
    generateButtonEl.classList.remove("generating");
  }
}

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

async function loadStoredFileInfo(videoId) {
  const stored = await chrome.storage.local.get(getStorageKey(videoId));
  return stored[getStorageKey(videoId)] || null;
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
// Status polling — ask the content script for generation state
// ---------------------------------------------------------------------------

function applyStatus(state) {
  if (!state || !state.ok) {
    return;
  }

  updateGenerateButton(state.active);

  if (state.active && state.status === "connecting") {
    setStreamStatus("Connecting...");
    setStatus("");
  } else if (state.active && state.status === "receiving") {
    setStreamStatus(`Receiving captions... (${state.cueCount} cues)`);
    setStatus("");
  } else if (state.status === "done") {
    setStreamStatus(`Generation complete — ${state.cueCount} cues.`);
    setStatus("Generation complete", "success");
  } else if (state.status === "done_cached") {
    setStreamStatus(`Loaded from cache — ${state.cueCount} cues.`);
    setStatus("Loaded from cache", "success");
  } else if (state.status === "stopped") {
    setStreamStatus(`Stopped — ${state.cueCount} cues received.`);
    setStatus("");
  } else if (state.status === "error") {
    setStreamStatus("");
    setStatus(state.error || "Server error.", "error");
  }
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
// Generate / Stop
// ---------------------------------------------------------------------------

async function startGeneration() {
  if (!currentVideoId) {
    return;
  }

  await ensureContentScriptReady();

  const response = await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_GET_STATUS"
  });

  if (response?.active) {
    await sendMessageToActiveTab({ type: "CAPTION_REPLACER_STOP_GENERATION" });
    updateGenerateButton(false);
    setStreamStatus("");
    return;
  }

  const serverUrl = getWsUrl();
  await sendMessageToActiveTab({
    type: "CAPTION_REPLACER_START_GENERATION",
    serverUrl
  });

  setStreamStatus("Connecting...");
  setStatus("");
  updateGenerateButton(true);
  startPolling();
}

// ---------------------------------------------------------------------------
// File picker (fallback)
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

    const payload = {
      fileName: file.name,
      srtText,
      updatedAt: Date.now()
    };

    await chrome.storage.local.set({
      [getStorageKey(currentVideoId)]: payload
    });

    await sendMessageToActiveTab({
      type: "CAPTION_REPLACER_APPLY_SRT",
      videoId: currentVideoId,
      srtText,
      fileName: file.name
    });

    fileMetaEl.textContent = `Stored file: ${file.name} (${new Date(payload.updatedAt).toLocaleString()})`;
    setStatus(`Applied ${file.name} to the current video.`, "success");
  } catch (error) {
    setStatus(error.message || "Failed to read the selected SRT file.", "error");
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

  fileMetaEl.textContent = "No SRT selected for this video.";
  setStreamStatus("");
  setStatus("Cleared custom captions for this video.");
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
    fileMetaEl.textContent = "";
    generateButtonEl.disabled = true;
    setControlsEnabled(false);
    setStatus("");
    return;
  }

  videoStatusEl.textContent = "Ready to replace captions.";
  videoMetaEl.textContent = `Video ID: ${currentVideoId}`;
  generateButtonEl.disabled = false;
  setControlsEnabled(true);
  await ensureContentScriptReady();

  const existing = await loadStoredFileInfo(currentVideoId);

  if (existing) {
    const timestamp = new Date(existing.updatedAt).toLocaleString();
    fileMetaEl.textContent = `Stored: ${existing.fileName} (${timestamp})`;
  } else {
    fileMetaEl.textContent = "No SRT selected for this video.";
  }

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
