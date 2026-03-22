# Caption Generator

Small Node.js server for:

1. downloading best-audio from a video URL with `yt-dlp_macos`
2. transcribing a saved audio file with ElevenLabs realtime speech-to-text
3. writing a progressively updated `.srt` file beside the audio file

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

## API

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

The `/transcribe` flow does the following:

1. converts the source audio to mono `pcm_16000` using `ffmpeg`
2. opens an ElevenLabs realtime websocket session using `scribe_v2_realtime`
3. streams the PCM audio in chunks
4. listens for `committed_transcript_with_timestamps` events
5. converts committed timestamped words into subtitle cues
6. rewrites the full `.srt` file after each committed update

Each write is intended to be a valid full SRT file at that moment, not an append-only partial fragment.

## Notes

- The server uses `commit_strategy=vad`, so subtitle updates happen when ElevenLabs decides a segment is final.
- The server applies local cue splitting rules for subtitle readability based on punctuation, pauses, cue duration, and line length.
- Temporary PCM files are created during transcription and deleted afterwards.

## Files

- `server.js`: HTTP server and transcription pipeline
- `yt-dlp_macos`: local downloader binary
- `.env`: local environment variables

