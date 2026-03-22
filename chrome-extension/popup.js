const STORAGE_PREFIX = "caption-replacer:";

const videoStatusEl = document.getElementById("videoStatus");
const videoMetaEl = document.getElementById("videoMeta");
const fileInputEl = document.getElementById("srtFile");
const fileMetaEl = document.getElementById("fileMeta");
const clearButtonEl = document.getElementById("clearButton");
const statusMessageEl = document.getElementById("statusMessage");
const filePickerLabelEl = document.querySelector(".file-picker");

let currentTab = null;
let currentVideoId = null;

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

function setStatus(message, isError = false) {
  statusMessageEl.textContent = message;
  statusMessageEl.classList.toggle("error", isError);
}

function setPickerEnabled(enabled) {
  fileInputEl.disabled = !enabled;
  clearButtonEl.disabled = !enabled;
  filePickerLabelEl.classList.toggle("disabled", !enabled);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendMessageToActiveTab(message) {
  if (!currentTab || typeof currentTab.id !== "number") {
    return;
  }

  try {
    await chrome.tabs.sendMessage(currentTab.id, message);
  } catch {
    // Ignore cases where the content script is not ready.
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

async function refreshPopupState() {
  currentTab = await getActiveTab();
  const tabUrl = currentTab?.url || "";
  currentVideoId = parseVideoIdFromUrl(tabUrl);

  if (!currentVideoId) {
    videoStatusEl.textContent = "Open a YouTube watch page first.";
    videoMetaEl.textContent = "";
    fileMetaEl.textContent = "Pick an SRT file after opening the target video.";
    setPickerEnabled(false);
    setStatus("");
    return;
  }

  videoStatusEl.textContent = "Ready to replace captions.";
  videoMetaEl.textContent = `Video ID: ${currentVideoId}`;
  setPickerEnabled(true);
  await ensureContentScriptReady();

  const existing = await loadStoredFileInfo(currentVideoId);

  if (existing) {
    const timestamp = new Date(existing.updatedAt).toLocaleString();
    fileMetaEl.textContent = `Stored file: ${existing.fileName} (${timestamp})`;
  } else {
    fileMetaEl.textContent = "No SRT selected for this video.";
  }
}

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
    setStatus(`Applied ${file.name} to the current video.`);
  } catch (error) {
    setStatus(error.message || "Failed to read the selected SRT file.", true);
  } finally {
    fileInputEl.value = "";
  }
}

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
  setStatus("Cleared custom captions for this video.");
}

fileInputEl.addEventListener("change", handleFileSelection);
clearButtonEl.addEventListener("click", () => {
  void handleClear();
});

void refreshPopupState();
