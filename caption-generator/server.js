const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const BINARY_PATH = path.join(__dirname, "yt-dlp_macos");
const ELEVENLABS_REALTIME_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_REALTIME_MODEL_ID = "scribe_v2_realtime";
const REALTIME_SAMPLE_RATE = 16000;
const REALTIME_CHUNK_BYTES = 16000;
const REALTIME_SEND_DELAY_MS = 100;
const REALTIME_FINALIZE_IDLE_MS = 4000;
const SRT_MAX_CHARS_PER_LINE = 42;
const SRT_MAX_CUE_CHARS = 84;
const SRT_MAX_CUE_DURATION_S = 6;
const SRT_PAUSE_SPLIT_S = 0.7;
const CAPTIONS_DIR = path.join(__dirname, "captions");
const CACHE_FILE = path.join(CAPTIONS_DIR, "captions.json");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(tag, ...args) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`${time} [${tag}]`, ...args);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractVideoId(videoUrl) {
  try {
    const url = new URL(videoUrl);

    if (url.hostname === "www.youtube.com" || url.hostname === "youtube.com") {
      return url.searchParams.get("v") || null;
    }

    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1).split("/")[0] || null;
    }

    return null;
  } catch {
    return null;
  }
}

function createRequestId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function getNonEmptyLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Captions cache
// ---------------------------------------------------------------------------

async function ensureCaptionsDir() {
  await fs.mkdir(CAPTIONS_DIR, { recursive: true });
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

async function getCachedEntry(videoUrl) {
  const cache = await loadCache();
  const entry = cache[videoUrl];

  if (!entry) {
    return null;
  }

  try {
    await fs.access(path.join(CAPTIONS_DIR, entry.srtFile));
    return entry;
  } catch {
    return null;
  }
}

async function addCacheEntry(videoUrl, videoId, srtFile, segmentCount) {
  const cache = await loadCache();
  cache[videoUrl] = {
    videoUrl,
    videoId,
    srtFile,
    segmentCount,
    createdAt: new Date().toISOString()
  };
  await saveCache(cache);
}

// ---------------------------------------------------------------------------
// SRT helpers
// ---------------------------------------------------------------------------

function formatSrtTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);

  const normalizedSeconds = seconds + Math.floor(milliseconds / 1000);
  const normalizedMilliseconds = milliseconds % 1000;
  const normalizedMinutes = minutes + Math.floor(normalizedSeconds / 60);
  const displaySeconds = normalizedSeconds % 60;
  const normalizedHours = hours + Math.floor(normalizedMinutes / 60);
  const displayMinutes = normalizedMinutes % 60;

  return `${String(normalizedHours).padStart(2, "0")}:${String(displayMinutes).padStart(
    2,
    "0"
  )}:${String(displaySeconds).padStart(2, "0")},${String(normalizedMilliseconds).padStart(
    3,
    "0"
  )}`;
}

function buildSrtContent(segments) {
  if (segments.length === 0) {
    return "";
  }

  return `${segments
    .map((segment, index) => {
      return [
        String(index + 1),
        `${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}`,
        segment.text
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

function parseSrt(srtText) {
  const blocks = srtText.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());

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

    function parseTs(raw) {
      const cleaned = raw.trim().replace(",", ".");
      const parts = cleaned.split(":");

      if (parts.length !== 3) {
        return null;
      }

      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const s = Number(parts[2]);

      if ([h, m, s].some(Number.isNaN)) {
        return null;
      }

      return h * 3600 + m * 60 + s;
    }

    const start = parseTs(timeMatch[1]);
    const end = parseTs(timeMatch[2]);

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

function normalizeCueTextFromTokens(tokens) {
  const rawText = tokens.map((token) => token.text || "").join("");

  return rawText
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim();
}

function wrapSubtitleText(text) {
  if (text.length <= SRT_MAX_CHARS_PER_LINE) {
    return text;
  }

  const midpoint = Math.floor(text.length / 2);
  let bestSplitIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== " ") {
      continue;
    }

    const distance = Math.abs(i - midpoint);
    const leftLength = text.slice(0, i).trim().length;
    const rightLength = text.slice(i + 1).trim().length;

    if (leftLength > SRT_MAX_CHARS_PER_LINE || rightLength > SRT_MAX_CHARS_PER_LINE) {
      continue;
    }

    if (distance < bestDistance) {
      bestDistance = distance;
      bestSplitIndex = i;
    }
  }

  if (bestSplitIndex === -1) {
    return text;
  }

  return `${text.slice(0, bestSplitIndex).trim()}\n${text.slice(bestSplitIndex + 1).trim()}`;
}

function finalizeCueFromTokens(tokens) {
  const timedTokens = tokens.filter((token) => {
    return typeof token.start === "number" && typeof token.end === "number";
  });

  if (timedTokens.length === 0) {
    return null;
  }

  const text = normalizeCueTextFromTokens(tokens);

  if (!text) {
    return null;
  }

  return {
    start: timedTokens[0].start,
    end: timedTokens[timedTokens.length - 1].end,
    text: wrapSubtitleText(text)
  };
}

function shouldSplitCue(tokens, nextToken) {
  const cue = finalizeCueFromTokens(tokens);

  if (!cue) {
    return false;
  }

  const duration = cue.end - cue.start;
  const plainText = cue.text.replace(/\n/g, " ");
  const lastText = tokens[tokens.length - 1]?.text || "";
  const pauseToNext =
    nextToken && typeof nextToken.start === "number" ? Math.max(0, nextToken.start - cue.end) : 0;

  if (duration >= SRT_MAX_CUE_DURATION_S || plainText.length >= SRT_MAX_CUE_CHARS) {
    return true;
  }

  if (/[.!?]["')\]]*$/.test(lastText) && duration >= 1.2) {
    return true;
  }

  if (pauseToNext >= SRT_PAUSE_SPLIT_S && duration >= 1.0) {
    return true;
  }

  if (/[,;:]["')\]]*$/.test(lastText) && (duration >= 2.0 || plainText.length >= 32)) {
    return true;
  }

  return false;
}

function createSrtSegmentsFromRealtimeEvent(event) {
  if (!Array.isArray(event.words) || event.words.length === 0) {
    throw new Error("Realtime transcript commit did not include any timestamped words.");
  }

  const timedWords = event.words.filter((word) => {
    return typeof word.text === "string" && typeof word.start === "number" && typeof word.end === "number";
  });

  if (timedWords.length === 0) {
    throw new Error("Realtime transcript commit did not include valid word timestamps.");
  }

  const text = typeof event.text === "string" ? event.text.trim() : "";

  if (!text) {
    throw new Error("Realtime transcript commit did not include transcript text.");
  }

  const segments = [];
  let currentTokens = [];

  for (let index = 0; index < timedWords.length; index += 1) {
    const token = timedWords[index];
    const nextToken = timedWords[index + 1];

    currentTokens.push(token);

    if (shouldSplitCue(currentTokens, nextToken)) {
      const cue = finalizeCueFromTokens(currentTokens);

      if (cue) {
        segments.push(cue);
      }

      currentTokens = [];
    }
  }

  if (currentTokens.length > 0) {
    const cue = finalizeCueFromTokens(currentTokens);

    if (cue) {
      segments.push(cue);
    }
  }

  if (segments.length === 0) {
    throw new Error("Realtime transcript commit could not be converted into SRT segments.");
  }

  return segments;
}

function insertSegmentsChronologically(existingSegments, newSegments) {
  const combined = [...existingSegments, ...newSegments];

  combined.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    return left.end - right.end;
  });

  return combined.map((segment) => {
    return {
      start: segment.start,
      end: segment.end,
      text: segment.text
    };
  });
}

// ---------------------------------------------------------------------------
// Audio download (batch)
// ---------------------------------------------------------------------------

async function runYtDlp(videoUrl, requestId) {
  const outputTemplate = `${requestId}.%(ext)s`;
  const args = [
    "-f",
    "bestaudio",
    "-P",
    __dirname,
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath",
    "--no-progress",
    videoUrl
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(BINARY_PATH, args, {
      cwd: __dirname
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start yt-dlp_macos: ${error.message}`));
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `yt-dlp_macos exited with code ${code}.\n${stderr || stdout || "No output returned."}`
          )
        );
        return;
      }

      const outputLines = getNonEmptyLines(stdout);
      const candidatePath = outputLines[outputLines.length - 1];

      if (!candidatePath) {
        reject(new Error("yt-dlp_macos did not report the downloaded audio file path."));
        return;
      }

      const audioPath = path.isAbsolute(candidatePath)
        ? candidatePath
        : path.join(__dirname, candidatePath);

      try {
        await fs.access(audioPath);
      } catch {
        reject(new Error(`Downloaded audio file was not found at ${audioPath}.`));
        return;
      }

      resolve({ audioPath });
    });
  });
}

// ---------------------------------------------------------------------------
// Batch transcription (existing REST flow)
// ---------------------------------------------------------------------------

async function writeSrtFile(audioPath, srtContent) {
  const srtPath = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.srt`
  );

  await fs.writeFile(srtPath, srtContent, "utf8");

  return srtPath;
}

async function convertAudioToRealtimePcm(audioPath, pcmPath) {
  const args = [
    "-y",
    "-i",
    audioPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(REALTIME_SAMPLE_RATE),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    pcmPath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      cwd: __dirname
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`ffmpeg exited with code ${code} while converting audio.\n${stderr}`)
        );
        return;
      }

      resolve();
    });
  });
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function transcribeAudioRealtime(audioPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set.");
  }

  const srtPath = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.srt`
  );
  const pcmPath = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.${createRequestId()}.pcm`
  );

  await writeSrtFile(audioPath, "");

  try {
    log("batch", "converting audio to PCM...");
    await convertAudioToRealtimePcm(audioPath, pcmPath);
    const pcmBuffer = await fs.readFile(pcmPath);
    log("batch", `PCM ready — ${(pcmBuffer.length / 1024).toFixed(0)} KB`);

    if (pcmBuffer.length === 0) {
      throw new Error("PCM conversion produced an empty file.");
    }

    const websocketUrl = new URL(ELEVENLABS_REALTIME_ENDPOINT);
    websocketUrl.searchParams.set("model_id", ELEVENLABS_REALTIME_MODEL_ID);
    websocketUrl.searchParams.set("audio_format", "pcm_16000");
    websocketUrl.searchParams.set("include_timestamps", "true");
    websocketUrl.searchParams.set("commit_strategy", "vad");
    websocketUrl.searchParams.set("vad_silence_threshold_secs", ".5");
    websocketUrl.searchParams.set("vad_threshold", "0.4");
    websocketUrl.searchParams.set("min_speech_duration_ms", "100");
    websocketUrl.searchParams.set("min_silence_duration_ms", "100");

    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(websocketUrl, {
        headers: {
          "xi-api-key": apiKey
        }
      });

      const segments = [];
      let writeChain = Promise.resolve();
      let finalized = false;
      let finishTimer = null;
      let finalCommitSent = false;
      let sessionStarted = false;

      function clearFinishTimer() {
        if (finishTimer) {
          clearTimeout(finishTimer);
          finishTimer = null;
        }
      }

      function scheduleFinish() {
        if (!finalCommitSent || finalized) {
          return;
        }

        clearFinishTimer();
        finishTimer = setTimeout(() => {
          ws.close();
        }, REALTIME_FINALIZE_IDLE_MS);
      }

      function finish(result) {
        if (finalized) {
          return;
        }

        finalized = true;
        clearFinishTimer();

        writeChain
          .then(() => resolve(result))
          .catch(reject);
      }

      function fail(error) {
        if (finalized) {
          return;
        }

        finalized = true;
        clearFinishTimer();
        reject(error);
      }

      async function sendAudioChunks() {
        for (let offset = 0; offset < pcmBuffer.length; offset += REALTIME_CHUNK_BYTES) {
          const chunk = pcmBuffer.subarray(offset, offset + REALTIME_CHUNK_BYTES);

          ws.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: chunk.toString("base64"),
              commit: false,
              sample_rate: REALTIME_SAMPLE_RATE
            })
          );

          await sleep(REALTIME_SEND_DELAY_MS);
        }

        finalCommitSent = true;
        ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            commit: true,
            sample_rate: REALTIME_SAMPLE_RATE
          })
        );
        scheduleFinish();
      }

      ws.on("message", (rawMessage) => {
        let event;

        try {
          event = JSON.parse(rawMessage.toString());
        } catch {
          fail(new Error("ElevenLabs realtime API returned invalid JSON."));
          return;
        }

        const messageType = event.message_type;

        if (messageType === "session_started") {
          if (!sessionStarted) {
            sessionStarted = true;
            log("batch", "ElevenLabs session started, sending audio chunks...");
            void sendAudioChunks().catch((error) => {
              fail(error);
            });
          }
          return;
        }

        if (messageType === "committed_transcript_with_timestamps") {
          writeChain = writeChain.then(async () => {
            const newSegments = createSrtSegmentsFromRealtimeEvent(event);
            const updatedSegments = insertSegmentsChronologically(segments, newSegments);
            segments.length = 0;
            segments.push(...updatedSegments);
            await fs.writeFile(srtPath, buildSrtContent(segments), "utf8");
            const preview = newSegments.map((s) => s.text.replace(/\n/g, " ")).join(" | ");
            log("batch", `+${newSegments.length} cue(s) (${segments.length} total): ${preview}`);
          });
          scheduleFinish();
          return;
        }

        if (
          messageType === "auth_error" ||
          messageType === "quota_exceeded" ||
          messageType === "transcriber_error" ||
          messageType === "input_error" ||
          messageType === "error" ||
          messageType === "commit_throttled" ||
          messageType === "unaccepted_terms" ||
          messageType === "rate_limited" ||
          messageType === "queue_overflow" ||
          messageType === "resource_exhausted" ||
          messageType === "session_time_limit_exceeded" ||
          messageType === "chunk_size_exceeded" ||
          messageType === "insufficient_audio_activity"
        ) {
          const details =
            typeof event.message === "string"
              ? event.message
              : typeof event.error === "string"
                ? event.error
                : JSON.stringify(event);
          fail(new Error(`ElevenLabs realtime error (${messageType}): ${details}`));
        }
      });

      ws.on("error", (error) => {
        fail(new Error(`ElevenLabs realtime websocket error: ${error.message}`));
      });

      ws.on("close", () => {
        if (finalized) {
          return;
        }

        if (!sessionStarted) {
          fail(new Error("ElevenLabs realtime websocket closed before the session started."));
          return;
        }

        if (!finalCommitSent) {
          fail(new Error("ElevenLabs realtime websocket closed before all audio was sent."));
          return;
        }

        finish({
          srtPath,
          segmentCount: segments.length
        });
      });
    });
  } finally {
    await removeFileIfExists(pcmPath);
  }
}

async function resolveAudioPath(audioPathInput) {
  if (typeof audioPathInput !== "string" || !audioPathInput.trim()) {
    throw new Error("The `audioPath` field is required and must be a non-empty string.");
  }

  const trimmedPath = audioPathInput.trim();
  const resolvedPath = path.resolve(__dirname, trimmedPath);
  const relativePath = path.relative(__dirname, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The `audioPath` must point to a file inside the server folder.");
  }

  try {
    const stats = await fs.stat(resolvedPath);

    if (!stats.isFile()) {
      throw new Error("The `audioPath` must point to a file.");
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Audio file not found: ${resolvedPath}`);
    }

    throw error;
  }

  return resolvedPath;
}

// ---------------------------------------------------------------------------
// Streaming transcription (realtime WebSocket flow)
// ---------------------------------------------------------------------------

const ELEVENLABS_ERROR_TYPES = new Set([
  "auth_error",
  "quota_exceeded",
  "transcriber_error",
  "input_error",
  "error",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity"
]);

function streamTranscribeFromUrl(videoUrl, { onCues, onDone, onError }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    process.nextTick(() => onError(new Error("ELEVENLABS_API_KEY is not set.")));
    return { abort() {} };
  }

  const videoId = extractVideoId(videoUrl);
  const srtBaseName = videoId || createRequestId();
  const srtPath = path.join(CAPTIONS_DIR, `${srtBaseName}.srt`);

  log("stream", `starting pipeline for ${videoUrl} (videoId=${videoId || "unknown"})`);

  let aborted = false;
  let ytDlpChild = null;
  let ffmpegChild = null;
  let elWs = null;
  const segments = [];
  let writeChain = Promise.resolve();

  function abort() {
    if (aborted) {
      return;
    }

    aborted = true;
    log("stream", "aborting pipeline — killing child processes");

    if (ytDlpChild) {
      ytDlpChild.kill();
    }

    if (ffmpegChild) {
      ffmpegChild.kill();
    }

    if (elWs && elWs.readyState <= WebSocket.OPEN) {
      elWs.close();
    }
  }

  void (async () => {
    try {
      log("stream", "spawning yt-dlp (stdout mode)...");
      ytDlpChild = spawn(BINARY_PATH, [
        "-f", "bestaudio", "-o", "-", "--no-progress", videoUrl
      ], { cwd: __dirname });

      log("stream", "spawning ffmpeg (pipe:0 → pcm_s16le → pipe:1)...");
      ffmpegChild = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-vn", "-ac", "1",
        "-ar", String(REALTIME_SAMPLE_RATE),
        "-f", "s16le", "-acodec", "pcm_s16le",
        "pipe:1"
      ], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] });

      ytDlpChild.stdout.pipe(ffmpegChild.stdin);
      ffmpegChild.stdin.on("error", () => {});

      let ytDlpStderr = "";
      ytDlpChild.stderr.on("data", (chunk) => {
        ytDlpStderr += chunk.toString();
      });

      ytDlpChild.on("error", (err) => {
        log("stream", `yt-dlp error: ${err.message}`);
        if (!aborted) {
          onError(new Error(`Failed to start yt-dlp: ${err.message}`));
        }
        abort();
      });

      ffmpegChild.on("error", (err) => {
        log("stream", `ffmpeg error: ${err.message}`);
        if (!aborted) {
          onError(new Error(`Failed to start ffmpeg: ${err.message}`));
        }
        abort();
      });

      ytDlpChild.on("close", (code) => {
        log("stream", `yt-dlp exited with code ${code}`);
        if (code !== 0 && !aborted) {
          onError(new Error(
            `yt-dlp exited with code ${code}.\n${ytDlpStderr || "No output."}`
          ));
          abort();
        }
      });

      const wsUrl = new URL(ELEVENLABS_REALTIME_ENDPOINT);
      wsUrl.searchParams.set("model_id", ELEVENLABS_REALTIME_MODEL_ID);
      wsUrl.searchParams.set("audio_format", "pcm_16000");
      wsUrl.searchParams.set("include_timestamps", "true");
      wsUrl.searchParams.set("commit_strategy", "vad");
      wsUrl.searchParams.set("vad_silence_threshold_secs", ".5");
      wsUrl.searchParams.set("vad_threshold", "0.4");
      wsUrl.searchParams.set("min_speech_duration_ms", "100");
      wsUrl.searchParams.set("min_silence_duration_ms", "100");

      log("stream", "connecting to ElevenLabs realtime STT...");
      elWs = new WebSocket(wsUrl, {
        headers: { "xi-api-key": apiKey }
      });

      let sessionStarted = false;
      let finalCommitSent = false;
      let finishTimer = null;

      function clearFinishTimer() {
        if (finishTimer) {
          clearTimeout(finishTimer);
          finishTimer = null;
        }
      }

      function scheduleFinish() {
        if (!finalCommitSent || aborted) {
          return;
        }

        clearFinishTimer();
        finishTimer = setTimeout(() => {
          if (elWs && elWs.readyState <= WebSocket.OPEN) {
            elWs.close();
          }
        }, REALTIME_FINALIZE_IDLE_MS);
      }

      async function drainFfmpegOutput() {
        let pcmBuffer = Buffer.alloc(0);

        for await (const data of ffmpegChild.stdout) {
          if (aborted) {
            return;
          }

          pcmBuffer = Buffer.concat([pcmBuffer, data]);

          while (pcmBuffer.length >= REALTIME_CHUNK_BYTES && !aborted) {
            const chunk = pcmBuffer.subarray(0, REALTIME_CHUNK_BYTES);
            pcmBuffer = pcmBuffer.subarray(REALTIME_CHUNK_BYTES);

            if (elWs.readyState === WebSocket.OPEN) {
              elWs.send(JSON.stringify({
                message_type: "input_audio_chunk",
                audio_base_64: chunk.toString("base64"),
                commit: false,
                sample_rate: REALTIME_SAMPLE_RATE
              }));
            }

            await sleep(REALTIME_SEND_DELAY_MS);
          }
        }

        if (pcmBuffer.length > 0 && !aborted && elWs.readyState === WebSocket.OPEN) {
          elWs.send(JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: pcmBuffer.toString("base64"),
            commit: false,
            sample_rate: REALTIME_SAMPLE_RATE
          }));
        }

        if (!aborted && elWs.readyState === WebSocket.OPEN) {
          finalCommitSent = true;
          elWs.send(JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            commit: true,
            sample_rate: REALTIME_SAMPLE_RATE
          }));
          scheduleFinish();
        }
      }

      elWs.on("message", (rawMessage) => {
        if (aborted) {
          return;
        }

        let event;

        try {
          event = JSON.parse(rawMessage.toString());
        } catch {
          onError(new Error("ElevenLabs returned invalid JSON."));
          abort();
          return;
        }

        const messageType = event.message_type;

        if (messageType === "session_started" && !sessionStarted) {
          sessionStarted = true;
          log("stream", "ElevenLabs session started — streaming audio chunks...");
          drainFfmpegOutput().catch((err) => {
            if (!aborted) {
              onError(err);
            }
            abort();
          });
          return;
        }

        if (messageType === "committed_transcript_with_timestamps") {
          clearFinishTimer();

          try {
            const newCues = createSrtSegmentsFromRealtimeEvent(event);
            const updated = insertSegmentsChronologically(segments, newCues);
            segments.length = 0;
            segments.push(...updated);

            writeChain = writeChain.then(() =>
              fs.writeFile(srtPath, buildSrtContent(segments), "utf8")
            );

            const preview = newCues.map((c) => c.text.replace(/\n/g, " ")).join(" | ");
            log("stream", `+${newCues.length} cue(s) (${segments.length} total): ${preview}`);

            onCues(newCues);
          } catch (err) {
            log("stream", `failed to process transcript event: ${err.message}`);
          }

          scheduleFinish();
          return;
        }

        if (ELEVENLABS_ERROR_TYPES.has(messageType)) {
          const details =
            typeof event.message === "string"
              ? event.message
              : typeof event.error === "string"
                ? event.error
                : JSON.stringify(event);
          log("stream", `ElevenLabs error: ${details}`);
          onError(new Error(`ElevenLabs error (${messageType}): ${details}`));
          abort();
        }
      });

      elWs.on("error", (err) => {
        log("stream", `ElevenLabs websocket error: ${err.message}`);
        if (!aborted) {
          onError(new Error(`ElevenLabs websocket error: ${err.message}`));
        }
        abort();
      });

      elWs.on("close", () => {
        if (aborted) {
          return;
        }

        clearFinishTimer();

        writeChain
          .then(() => {
            log("stream", `pipeline complete → ${path.basename(srtPath)} (${segments.length} segments)`);
            onDone({
              srtPath,
              srtFile: path.basename(srtPath),
              segmentCount: segments.length,
              videoId
            });
          })
          .catch((err) => onError(err));
      });
    } catch (err) {
      log("stream", `pipeline error: ${err.message}`);
      if (!aborted) {
        onError(err);
      }
      abort();
    }
  })();

  return { abort };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, "");
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 404, {
      error: "Not found. Use POST /download or POST /transcribe."
    });
    return;
  }

  log("http", `${req.method} ${req.url}`);

  try {
    const body = await parseJsonBody(req);
    if (req.url === "/download") {
      const videoUrl = body.url;

      if (typeof videoUrl !== "string" || !isValidHttpUrl(videoUrl)) {
        sendJson(res, 400, {
          error: "The `url` field is required and must be a valid http(s) URL."
        });
        return;
      }

      log("download", `starting for ${videoUrl}`);
      const requestId = createRequestId();
      const { audioPath } = await runYtDlp(videoUrl, requestId);
      log("download", `complete → ${path.basename(audioPath)}`);

      sendJson(res, 200, {
        ok: true,
        requestId,
        audioFile: path.basename(audioPath),
        audioPath
      });
      return;
    }

    if (req.url === "/transcribe") {
      const audioPath = await resolveAudioPath(body.audioPath);
      log("transcribe", `starting for ${path.basename(audioPath)}`);
      const { srtPath, segmentCount } = await transcribeAudioRealtime(audioPath);
      log("transcribe", `complete → ${path.basename(srtPath)} (${segmentCount} segments)`);

      sendJson(res, 200, {
        ok: true,
        audioFile: path.basename(audioPath),
        srtFile: path.basename(srtPath),
        segmentCount
      });
      return;
    }

    sendJson(res, 404, {
      error: "Not found. Use POST /download or POST /transcribe."
    });
  } catch (error) {
    log("http", `error: ${error.message}`);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// WebSocket server for realtime caption streaming
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ noServer: true });

async function handleCaptionWebSocket(clientWs, requestUrl) {
  const videoUrl = requestUrl.searchParams.get("url");

  if (!videoUrl || !isValidHttpUrl(videoUrl)) {
    log("ws", "rejected — missing or invalid url parameter");
    clientWs.send(JSON.stringify({ type: "error", message: "Missing or invalid url parameter." }));
    clientWs.close();
    return;
  }

  const videoId = extractVideoId(videoUrl);
  log("ws", `connected — videoId=${videoId || "unknown"} url=${videoUrl}`);

  try {
    const cached = await getCachedEntry(videoUrl);

    if (cached) {
      log("cache", `hit for ${videoUrl} → ${cached.srtFile} (${cached.segmentCount} segments)`);
      const srtContent = await fs.readFile(
        path.join(CAPTIONS_DIR, cached.srtFile),
        "utf8"
      );
      const cues = parseSrt(srtContent);

      if (cues.length > 0 && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "cues", cues }));
        clientWs.send(JSON.stringify({ type: "done", cached: true }));
        clientWs.close();
        log("ws", `sent ${cues.length} cached cues and closed`);
        return;
      }
    } else {
      log("cache", `miss for ${videoUrl} — starting live transcription`);
    }
  } catch {
    log("cache", `read error for ${videoUrl} — falling through to live transcription`);
  }

  let finished = false;

  const session = streamTranscribeFromUrl(videoUrl, {
    onCues(newCues) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "cues", cues: newCues }));
      }
    },

    onDone({ srtFile, segmentCount, videoId: vid }) {
      if (finished) {
        return;
      }

      finished = true;

      addCacheEntry(videoUrl, vid, srtFile, segmentCount)
        .then(() => {
          log("cache", `saved ${srtFile} (${segmentCount} segments)`);
        })
        .catch((err) => {
          log("cache", `failed to save: ${err.message}`);
        });

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "done", cached: false }));
        clientWs.close();
      }

      log("ws", `done — sent ${segmentCount} segments total`);
    },

    onError(err) {
      if (finished) {
        return;
      }

      finished = true;
      log("ws", `error: ${err.message}`);

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "error", message: err.message }));
        clientWs.close();
      }
    }
  });

  clientWs.on("close", () => {
    if (!finished) {
      log("ws", "client disconnected — aborting pipeline");
    }
    session.abort();
  });
}

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (requestUrl.pathname !== "/captions") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleCaptionWebSocket(ws, requestUrl);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

ensureCaptionsDir().then(() => {
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
});
