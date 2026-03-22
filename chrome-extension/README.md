# Chrome Extension

Unpacked Chrome extension that replaces YouTube's built-in captions with custom ones — either generated in realtime from the caption server or loaded from a local `.srt` file.

## What It Does

1. loads as an unpacked Chrome extension
2. connects to the caption server over WebSocket to generate captions for the current video in realtime
3. alternatively, lets you pick a local `.srt` file as a fallback
4. stores caption data per YouTube video ID in Chrome storage
5. injects or reconnects the content script for the current tab when needed
6. hides YouTube's native captions while custom captions are active
7. renders captions as a custom overlay on top of the player
8. follows YouTube's own captions toggle, so turning captions off in the YouTube UI also hides the custom captions
9. receives cues incrementally during realtime generation so captions appear as they are transcribed

## Files

- `manifest.json`: extension manifest
- `popup.html`, `popup.css`, `popup.js`: popup UI for generating, selecting, and clearing captions
- `content.js`: YouTube page script that renders the custom caption overlay and handles incremental cue updates

## Load Into Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this `chrome-extension` folder
5. After code changes, click the extension's reload button in `chrome://extensions`

## Usage

### Realtime generation (primary flow)

1. Make sure the caption server is running (`npm start` in `caption-generator/`)
2. Open a YouTube watch page
3. Click the extension icon
4. Confirm the server URL (defaults to `ws://localhost:8080`)
5. Click **Generate Captions**
6. Captions appear on the video as they are transcribed in realtime

If the video was already transcribed, cached captions load instantly.

### Manual SRT file (fallback)

1. Open a YouTube watch page
2. Click the extension icon
3. Use the **Choose SRT File** picker to load a `.srt` file from disk
4. The extension stores that file for the current video ID and applies it immediately

If you revisit the same video later, the stored SRT is reapplied automatically.

## Clear Captions

Use the popup's **Clear captions for this video** button to remove the saved custom SRT for the current YouTube video.

This does not delete the original file from disk or from the server cache. It only removes the saved mapping from Chrome storage.

## Current Behavior

- Targets standard YouTube watch pages on `youtube.com/watch`
- Stores subtitle text in Chrome extension storage so captions persist across visits
- Connects to the local caption server via WebSocket for realtime generation
- Receives cues incrementally — no need to wait for the full transcription to finish
- Uses the current YouTube video ID to decide which stored SRT to apply
- Tries to work without requiring a manual page reload by injecting the content script when needed

## Limitations

- The caption appearance is implemented as a custom overlay rather than a true native YouTube subtitle track
- The server URL must be configured manually (defaults to localhost)
