# Chrome Extension

Unpacked Chrome extension that lets you choose a finished `.srt` file for a YouTube video and display those captions instead of YouTube's built-in captions.

This extension is designed for the non-streaming flow:

1. generate the full `.srt` file with the caption server
2. open the target YouTube video
3. load the completed `.srt` file into the extension
4. watch the custom captions on that video

## What It Does

1. loads as an unpacked Chrome extension
2. provides a popup UI for choosing a local `.srt` file
3. stores the file contents per YouTube video ID in Chrome storage
4. injects or reconnects the content script for the current tab when needed
5. hides YouTube's native captions while custom captions are active
6. renders the selected SRT as a custom overlay on top of the player
7. follows YouTube's own captions toggle, so turning captions off in the YouTube UI also hides the custom captions

## Files

- `manifest.json`: extension manifest
- `popup.html`, `popup.css`, `popup.js`: popup UI for selecting and clearing an SRT file
- `content.js`: YouTube page script that parses SRT, hides native captions, and renders the custom caption overlay

## Load Into Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this `chrome-extension` folder
5. After code changes, click the extension's reload button in `chrome://extensions`

## Usage

1. Open a YouTube watch page like `https://www.youtube.com/watch?v=...`
2. Click the extension icon
3. Choose an `.srt` file from disk
4. The extension stores that file for the current video ID and applies it immediately

If you revisit the same video later, the stored SRT is reapplied automatically.

## Clear Captions

Use the popup's `Clear captions for this video` button to remove the saved custom SRT for the current YouTube video.

This does not delete the original file from disk. It only removes the saved mapping from Chrome storage.

## Current Behavior

- Targets standard YouTube watch pages on `youtube.com/watch`
- Stores subtitle text in Chrome extension storage, not as a live file handle
- Does not stream updates from disk after selection
- Uses the current YouTube video ID to decide which stored SRT to apply
- Tries to work without requiring a manual page reload by injecting the content script when needed

## Limitations

- This version assumes the `.srt` file is already complete before you pick it
- If the SRT file changes later on disk, the extension will not automatically reread it
- The caption appearance is implemented as a custom overlay rather than a true native YouTube subtitle track
