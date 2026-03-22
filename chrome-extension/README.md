# Chrome Extension

Unpacked Chrome extension that replaces YouTube's built-in captions with custom ones — either generated in realtime from the caption server or loaded from a local `.srt` file.

## What It Does

1. loads as an unpacked Chrome extension
2. connects to the caption server over WebSocket to generate captions for the current video in realtime
3. alternatively, lets you pick a local `.srt` file as a fallback
4. stores caption data per YouTube video ID in Chrome storage so captions persist across visits
5. injects or reconnects the content script for the current tab when needed
6. hides YouTube's native caption overlay and the subtitles menu item in the player settings while custom captions are active
7. renders captions as a custom overlay on top of the player
8. follows YouTube's own captions toggle — turning captions off in the YouTube UI also hides the custom overlay
9. receives cues incrementally during realtime generation so captions appear as they are transcribed
10. automatically saves generated captions to Chrome storage when transcription finishes
11. handles YouTube's SPA navigation so captions reload correctly when switching videos without a full page refresh

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

## How It Works

- Targets standard YouTube watch pages on `youtube.com/watch`
- The content script (`content.js`) manages the WebSocket connection and caption overlay directly — it survives popup close so generation is not interrupted
- Listens for `yt-navigate-finish`, `popstate`, and DOM mutations to detect video changes in YouTube's SPA and re-apply stored captions
- The popup polls the content script for generation status and updates its UI accordingly
- The server URL is persisted in Chrome storage so it only needs to be set once
- YouTube's native caption container and the subtitles settings menu item are hidden via injected CSS while custom captions are active

## Limitations

- The caption appearance is a custom overlay rather than a native YouTube subtitle track, so it does not inherit YouTube's caption style settings
- The server URL must be configured manually (defaults to `ws://localhost:8080`)
