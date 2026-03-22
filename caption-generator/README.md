# Caption Generator

Node.js server that streams realtime captions for YouTube videos to the companion Chrome extension. It:

1. downloads audio from a YouTube URL with `yt-dlp_macos`
2. pipes the audio through `ffmpeg` into ElevenLabs realtime speech-to-text
3. (optional) performs a contextual and grammatical sanity pass on the text chunks using Google Gemini
4. pushes subtitle cues to the Chrome extension over WebSocket as they arrive
5. writes the final `.srt` file to disk and caches it so repeat requests are served instantly

## Requirements

- Node.js 20+
- `ffmpeg` installed and available on `PATH`
- an ElevenLabs API key
- an optional Google Gemini API key (for the text sanity pass)
- the `yt-dlp_macos` binary in this folder

## Environment

Create a `.env` file in this folder with:

```env
ELEVENLABS_API_KEY=your_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
ENABLE_GEMINI_SANITY_PASS=true
PORT=8080
```

`PORT`, `GEMINI_API_KEY`, and `ENABLE_GEMINI_SANITY_PASS` are optional. The server defaults to `8080`.

## Install

```bash
npm install
```

## Start

```bash
npm start
```

Health check:

```bash
curl http://localhost:8080/health
```

## Realtime WebSocket endpoint

### `ws://localhost:8080/captions?url=<encoded-youtube-url>`

The primary way the Chrome extension connects. Opens a WebSocket that:

1. checks the local caption cache — if the video was already transcribed, sends all cues instantly and closes
2. otherwise starts a streaming pipeline: `yt-dlp → ffmpeg → ElevenLabs realtime STT`
3. pushes cue batches to the client as `{ "type": "cues", "cues": [...] }` messages as they arrive
4. sends `{ "type": "done", "cached": true|false }` when finished
5. writes the final `.srt` to `captions/<videoId>.srt` and updates `captions/captions.json`

If the client disconnects mid-stream, the transcription pipeline continues to completion so the result is still cached for future requests.

## How Transcription Works

1. `yt-dlp` streams the best available audio to stdout
2. `ffmpeg` converts it to mono PCM at 16 kHz (`pcm_s16le`) and pipes to stdout
3. the server opens an ElevenLabs realtime WebSocket session (`scribe_v2_realtime`)
4. PCM chunks are base64-encoded and sent to ElevenLabs in real time
5. `committed_transcript_with_timestamps` events are converted into subtitle cues
6. (Optional) If `ENABLE_GEMINI_SANITY_PASS` is enabled and a key is provided, the subtitle cue batch is dispatched to `gemini-3-flash-preview` to dynamically correct STT grammar and spelling errors using a rolling 3-sentence history.
7. the `.srt` file is rewritten after each committed update

Each `.srt` write produces a complete, valid SRT file — not an append-only fragment.

## Caption Cache

Generated `.srt` files are stored in the `captions/` subfolder. A JSON index at `captions/captions.json` maps video URLs to their `.srt` files so repeat requests skip the entire download + transcribe pipeline.

## Notes

- The server uses `commit_strategy=vad` with configurable silence and speech thresholds, so subtitle updates happen when ElevenLabs decides a segment is final.
- Cue splitting rules enforce readability constraints: max 42 chars per line, max 84 chars per cue, max 6 s duration, and splits on punctuation or pauses.

## Files

- `server.js`: HTTP server, WebSocket handler, and streaming transcription pipeline
- `captions/`: generated `.srt` files and `captions.json` cache index (gitignored)
- `yt-dlp_macos`: local downloader binary
- `.env`: local environment variables
