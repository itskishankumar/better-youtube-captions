# Caption Generator

Small Node.js server for:

1. downloading best-audio from a video URL with `yt-dlp_macos`
2. transcribing a saved audio file with ElevenLabs realtime speech-to-text
3. writing a progressively updated `.srt` file beside the audio file
4. **streaming realtime captions to the Chrome extension** via WebSocket (download + transcribe in a single pipeline)
5. caching generated captions in `captions/` so repeat requests are served instantly

## Requirements

- Node.js 20+
- `ffmpeg` installed and available on `PATH`
- an ElevenLabs API key
- the `yt-dlp_macos` binary in this folder

## Environment

Create a `.env` file in this folder with:

```env
ELEVENLABS_API_KEY=your_api_key_here
PORT=8080
```

`PORT` is optional. The server defaults to `8080`.

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

If the client disconnects, the server kills all child processes to avoid waste.

## REST API (batch flow)

The original REST endpoints are still available for manual / scripted use.

### `POST /download`

Downloads the best available audio stream for a video URL into this folder.

Request:

```json
{
  "url": "https://www.youtube.com/watch?v=..."
}
```

Example:

```bash
curl -X POST http://localhost:8080/download \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=..."}'
```

Response shape:

```json
{
  "ok": true,
  "requestId": "1774149168748-e7cf9cae",
  "audioFile": "1774149168748-e7cf9cae.webm",
  "audioPath": "/absolute/path/to/file.webm",
  "ytDlpStdout": "...",
  "ytDlpStderr": "..."
}
```

### `POST /transcribe`

Streams a local audio file to ElevenLabs realtime STT, then progressively rewrites the matching `.srt` file as committed transcript segments arrive.

Request:

```json
{
  "audioPath": "1774149168748-e7cf9cae.webm"
}
```

`audioPath` must point to a file inside this project folder. It can be just a filename or a relative path inside the project.

Example:

```bash
curl -X POST http://localhost:8080/transcribe \
  -H "Content-Type: application/json" \
  -d '{"audioPath":"1774149168748-e7cf9cae.webm"}'
```

Response shape:

```json
{
  "ok": true,
  "mode": "realtime",
  "audioFile": "1774149168748-e7cf9cae.webm",
  "audioPath": "/absolute/path/to/file.webm",
  "srtFile": "1774149168748-e7cf9cae.srt",
  "srtPath": "/absolute/path/to/file.srt",
  "segmentCount": 123
}
```

## How Transcription Works

Both the WebSocket streaming path and the `/transcribe` batch path use the same transcription logic:

1. converts the source audio to mono `pcm_16000` using `ffmpeg`
2. opens an ElevenLabs realtime websocket session using `scribe_v2_realtime`
3. streams the PCM audio in chunks
4. listens for `committed_transcript_with_timestamps` events
5. converts committed timestamped words into subtitle cues
6. rewrites the full `.srt` file after each committed update

The streaming path pipes `yt-dlp → ffmpeg → ElevenLabs` concurrently so captions start arriving within seconds rather than waiting for a full download.

Each write is intended to be a valid full SRT file at that moment, not an append-only partial fragment.

## Caption Cache

Generated `.srt` files are stored in the `captions/` subfolder. A JSON index at `captions/captions.json` maps video URLs to their `.srt` files so repeat requests skip the entire download + transcribe pipeline.

## Notes

- The server uses `commit_strategy=vad`, so subtitle updates happen when ElevenLabs decides a segment is final.
- The server applies local cue splitting rules for subtitle readability based on punctuation, pauses, cue duration, and line length.
- Temporary PCM files are created during batch transcription and deleted afterwards.
- The streaming path does not write temporary files — audio is piped directly.

## Files

- `server.js`: HTTP server, WebSocket handler, and transcription pipelines
- `captions/`: generated `.srt` files and `captions.json` cache index (gitignored)
- `yt-dlp_macos`: local downloader binary
- `.env`: local environment variables
