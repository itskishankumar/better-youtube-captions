const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const { GoogleGenAI } = require("@google/genai");

const ENABLE_GEMINI_ENV = process.env.ENABLE_GEMINI_SANITY_PASS !== "false";
let gemini = null;
if (ENABLE_GEMINI_ENV && process.env.GEMINI_API_KEY) {
  gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

const PORT = process.env.PORT || 8080;
const BINARY_PATH = path.join(__dirname, "yt-dlp_macos");
const ELEVENLABS_REALTIME_ENDPOINT =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
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
const serverStartTime = Date.now();
let activeConnectionCount = 0;
const activeJobs = new Map(); // videoId → { segments, activePipelines }

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
    "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
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
    createdAt: new Date().toISOString(),
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
  const milliseconds = Math.round(
    (safeSeconds - Math.floor(safeSeconds)) * 1000,
  );

  const normalizedSeconds = seconds + Math.floor(milliseconds / 1000);
  const normalizedMilliseconds = milliseconds % 1000;
  const normalizedMinutes = minutes + Math.floor(normalizedSeconds / 60);
  const displaySeconds = normalizedSeconds % 60;
  const normalizedHours = hours + Math.floor(normalizedMinutes / 60);
  const displayMinutes = normalizedMinutes % 60;

  return `${String(normalizedHours).padStart(2, "0")}:${String(
    displayMinutes,
  ).padStart(2, "0")}:${String(displaySeconds).padStart(2, "0")},${String(
    normalizedMilliseconds,
  ).padStart(3, "0")}`;
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
        segment.text,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

function parseSrt(srtText) {
  const blocks = srtText
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);
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
      /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})$/,
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

    const text = lines
      .slice(idx + 1)
      .join("\n")
      .trim();

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

    if (
      leftLength > SRT_MAX_CHARS_PER_LINE ||
      rightLength > SRT_MAX_CHARS_PER_LINE
    ) {
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
    text: wrapSubtitleText(text),
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
    nextToken && typeof nextToken.start === "number"
      ? Math.max(0, nextToken.start - cue.end)
      : 0;

  if (
    duration >= SRT_MAX_CUE_DURATION_S ||
    plainText.length >= SRT_MAX_CUE_CHARS
  ) {
    return true;
  }

  if (/[.!?]["')\]]*$/.test(lastText) && duration >= 1.2) {
    return true;
  }

  if (pauseToNext >= SRT_PAUSE_SPLIT_S && duration >= 1.0) {
    return true;
  }

  if (
    /[,;:]["')\]]*$/.test(lastText) &&
    (duration >= 2.0 || plainText.length >= 32)
  ) {
    return true;
  }

  return false;
}

function createSrtSegmentsFromRealtimeEvent(event) {
  if (!Array.isArray(event.words) || event.words.length === 0) {
    throw new Error(
      "Realtime transcript commit did not include any timestamped words.",
    );
  }

  const timedWords = event.words.filter((word) => {
    return (
      typeof word.text === "string" &&
      typeof word.start === "number" &&
      typeof word.end === "number"
    );
  });

  if (timedWords.length === 0) {
    throw new Error(
      "Realtime transcript commit did not include valid word timestamps.",
    );
  }

  const text = typeof event.text === "string" ? event.text.trim() : "";

  if (!text) {
    throw new Error(
      "Realtime transcript commit did not include transcript text.",
    );
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
    throw new Error(
      "Realtime transcript commit could not be converted into SRT segments.",
    );
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
      text: segment.text,
    };
  });
}

function computeCoverageRanges(segments) {
  if (!segments || segments.length === 0) {
    return { ranges: [], duration: 0 };
  }

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const ranges = [];
  let cur = { start: sorted[0].start, end: sorted[0].end };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= cur.end + 0.5) {
      cur.end = Math.max(cur.end, sorted[i].end);
    } else {
      ranges.push({ start: cur.start, end: cur.end });
      cur = { start: sorted[i].start, end: sorted[i].end };
    }
  }

  ranges.push({ start: cur.start, end: cur.end });

  return { ranges, duration: ranges[ranges.length - 1].end };
}

// ---------------------------------------------------------------------------
// Gemini Sanity Pass
// ---------------------------------------------------------------------------

async function sanitizeCuesWithGemini(contextSegments, newCues) {
  if (!gemini || newCues.length === 0) return newCues;

  try {
    const contextText = contextSegments
      .slice(-3)
      .map((c) => c.text)
      .join(" ");
    const currentArray = newCues.map((c) => c.text);

    const prompt = `You are a real-time speech transcription cleaner. 
    \nUsing the [CONTEXT] for grammatical alignment, fix any obvious speech-to-text errors in the [CURRENT] JSON array of phrases.
    \nCRITICAL RULES:\n1. Output ONLY a valid JSON array of strings.
    \n2. The output array MUST have exactly ${currentArray.length} elements, corresponding 1:1 to the [CURRENT] array.
    \n3. Keep the original meaning and tone exactly the same.
    \n4. If you don't spot any punctuation and or capitalization, then add your own. Else, leave it as is.
    \n5. Do not include the [CONTEXT] in your output.
    \n
    \n[CONTEXT]: "${contextText}"
    \n[CURRENT]: ${JSON.stringify(currentArray)}`;

    const response = await gemini.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const responseData = JSON.parse(response.text.trim());

    if (
      !Array.isArray(responseData) ||
      responseData.length !== newCues.length
    ) {
      log(
        "gemini",
        "Sanity pass warning: Output array length mismatch, skipping.",
      );
      return newCues;
    }

    return newCues.map((cue, i) => ({
      start: cue.start,
      end: cue.end,
      text: responseData[i] || cue.text,
    }));
  } catch (err) {
    log("gemini", `Sanity pass failed for cue batch: ${err.message}`);
    return newCues;
  }
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
  "insufficient_audio_activity",
]);

function streamTranscribeFromUrl(
  videoUrl,
  { onCues, onDone, onError, onDuration, startTimestamp = 0, getContextSegments },
) {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    process.nextTick(() =>
      onError(new Error("ELEVENLABS_API_KEY is not set.")),
    );
    return { teardown() {} };
  }

  const videoId = extractVideoId(videoUrl);

  log(
    "stream",
    `starting pipeline for ${videoUrl} (videoId=${videoId || "unknown"}, t=${startTimestamp}s)`,
  );

  let failed = false;
  let ytDlpChild = null;
  let ffmpegChild = null;
  let elWs = null;
  let writeChain = Promise.resolve();

  function teardown() {
    if (failed) {
      return;
    }

    failed = true;
    log("stream", "tearing down pipeline after error");

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
      log("stream", `spawning yt-dlp (t=${startTimestamp}s)...`);
      ytDlpChild = spawn(
        BINARY_PATH,
        ["-f", "bestaudio", "-o", "-", "--no-progress", videoUrl],
        { cwd: __dirname },
      );

      const ffmpegArgs = ["-i", "pipe:0"];
      if (startTimestamp > 0) {
        ffmpegArgs.push("-ss", String(startTimestamp));
      }
      ffmpegArgs.push(
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(REALTIME_SAMPLE_RATE),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
      );

      log("stream", "spawning ffmpeg (pipe:0 → pcm_s16le → pipe:1)...");
      ffmpegChild = spawn("ffmpeg", ffmpegArgs, {
        cwd: __dirname,
        stdio: ["pipe", "pipe", "pipe"],
      });

      ytDlpChild.stdout.pipe(ffmpegChild.stdin);
      ffmpegChild.stdin.on("error", () => {});

      let ytDlpStderr = "";
      ytDlpChild.stderr.on("data", (chunk) => {
        ytDlpStderr += chunk.toString();
      });

      let durationReported = false;
      ffmpegChild.stderr.on("data", (chunk) => {
        if (durationReported || !onDuration) return;
        const match = chunk.toString().match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (match) {
          durationReported = true;
          const dur =
            Number(match[1]) * 3600 +
            Number(match[2]) * 60 +
            Number(match[3]) +
            Number(match[4]) / 100;
          if (dur > 0) onDuration(dur);
        }
      });

      ytDlpChild.on("error", (err) => {
        log("stream", `yt-dlp error: ${err.message}`);
        if (!failed) {
          onError(new Error(`Failed to start yt-dlp: ${err.message}`));
        }
        teardown();
      });

      ffmpegChild.on("error", (err) => {
        log("stream", `ffmpeg error: ${err.message}`);
        if (!failed) {
          onError(new Error(`Failed to start ffmpeg: ${err.message}`));
        }
        teardown();
      });

      ytDlpChild.on("close", (code) => {
        log("stream", `yt-dlp exited with code ${code}`);
        if (code !== 0 && !failed) {
          onError(
            new Error(
              `yt-dlp exited with code ${code}.\n${ytDlpStderr || "No output."}`,
            ),
          );
          teardown();
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
        headers: { "xi-api-key": apiKey },
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
        if (!finalCommitSent || failed) {
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
          if (failed) {
            return;
          }

          pcmBuffer = Buffer.concat([pcmBuffer, data]);

          while (pcmBuffer.length >= REALTIME_CHUNK_BYTES && !failed) {
            const chunk = pcmBuffer.subarray(0, REALTIME_CHUNK_BYTES);
            pcmBuffer = pcmBuffer.subarray(REALTIME_CHUNK_BYTES);

            if (elWs.readyState === WebSocket.OPEN) {
              elWs.send(
                JSON.stringify({
                  message_type: "input_audio_chunk",
                  audio_base_64: chunk.toString("base64"),
                  commit: false,
                  sample_rate: REALTIME_SAMPLE_RATE,
                }),
              );
            }

            await sleep(REALTIME_SEND_DELAY_MS);
          }
        }

        if (
          pcmBuffer.length > 0 &&
          !failed &&
          elWs.readyState === WebSocket.OPEN
        ) {
          elWs.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: pcmBuffer.toString("base64"),
              commit: false,
              sample_rate: REALTIME_SAMPLE_RATE,
            }),
          );
        }

        if (!failed && elWs.readyState === WebSocket.OPEN) {
          finalCommitSent = true;
          elWs.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: "",
              commit: true,
              sample_rate: REALTIME_SAMPLE_RATE,
            }),
          );
          scheduleFinish();
        }
      }

      elWs.on("message", (rawMessage) => {
        if (failed) {
          return;
        }

        let event;

        try {
          event = JSON.parse(rawMessage.toString());
        } catch {
          onError(new Error("ElevenLabs returned invalid JSON."));
          teardown();
          return;
        }

        const messageType = event.message_type;

        if (messageType === "session_started" && !sessionStarted) {
          sessionStarted = true;
          log(
            "stream",
            "ElevenLabs session started — streaming audio chunks...",
          );
          drainFfmpegOutput().catch((err) => {
            if (!failed) {
              onError(err);
            }
            teardown();
          });
          return;
        }

        if (messageType === "committed_transcript_with_timestamps") {
          clearFinishTimer();

          writeChain = writeChain.then(async () => {
            if (failed) return;

            try {
              let newCues = createSrtSegmentsFromRealtimeEvent(event);

              if (startTimestamp > 0) {
                newCues = newCues.map((cue) => ({
                  start: cue.start + startTimestamp,
                  end: cue.end + startTimestamp,
                  text: cue.text,
                }));
              }

              let preview = newCues
                .map((c) => c.text.replace(/\n/g, " "))
                .join(" | ");
              log(
                "elevenLabs",
                `Received | +${newCues.length} cue(s): ${preview}`,
              );

              if (gemini) {
                const context = getContextSegments
                  ? getContextSegments()
                  : [];
                newCues = await sanitizeCuesWithGemini(context, newCues);
                preview = newCues
                  .map((c) => c.text.replace(/\n/g, " "))
                  .join(" | ");
                log(
                  "gemini",
                  `Sanitized | +${newCues.length} cue(s): ${preview}`,
                );
              }

              onCues(newCues);
            } catch (err) {
              log(
                "stream",
                `failed to process transcript event: ${err.message}`,
              );
            }
          });

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
          teardown();
        }
      });

      elWs.on("error", (err) => {
        log("stream", `ElevenLabs websocket error: ${err.message}`);
        if (!failed) {
          onError(new Error(`ElevenLabs websocket error: ${err.message}`));
        }
        teardown();
      });

      elWs.on("close", () => {
        if (failed) {
          return;
        }

        clearFinishTimer();

        writeChain
          .then(() => {
            log("stream", `pipeline complete (t=${startTimestamp}s)`);
            onDone({ videoId });
          })
          .catch((err) => onError(err));
      });
    } catch (err) {
      log("stream", `pipeline error: ${err.message}`);
      if (!failed) {
        onError(err);
      }
      teardown();
    }
  })();

  return { teardown };
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

  // Admin dashboard
  if (req.method === "GET" && req.url === "/dashboard") {
    try {
      const html = await fs.readFile(
        path.join(__dirname, "dashboard.html"),
        "utf8",
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end("dashboard.html not found");
    }
    return;
  }

  // API: server status
  if (req.method === "GET" && req.url === "/api/status") {
    const cache = await loadCache();
    const jobs = {};
    for (const [id, job] of activeJobs) {
      const coverage = computeCoverageRanges(job.segments);
      const duration = job.videoDuration || coverage.duration || 1;
      jobs[id] = {
        activePipelines: job.activePipelines,
        segmentCount: job.segments.length,
        coverage: coverage.ranges,
        duration,
      };
    }
    sendJson(res, 200, {
      uptime: Math.floor((Date.now() - serverStartTime) / 1000),
      activeConnections: activeConnectionCount,
      activeJobs: jobs,
      totalCachedVideos: Object.keys(cache).length,
    });
    return;
  }

  // API: list cached videos
  if (req.method === "GET" && req.url === "/api/videos") {
    const cache = await loadCache();
    const videos = Object.values(cache).map((entry) => ({
      videoId: entry.videoId,
      videoUrl: entry.videoUrl,
      srtFile: entry.srtFile,
      totalCues: entry.segmentCount || 0,
      createdAt: entry.createdAt || null,
    }));
    sendJson(res, 200, videos);
    return;
  }

  // API: delete a cached video
  const deleteMatch = req.url.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    try {
      const videoId = deleteMatch[1];
      const cache = await loadCache();
      const toDelete = Object.entries(cache).find(
        ([, v]) => v.videoId === videoId,
      );
      if (toDelete) {
        const srtPath = path.join(CAPTIONS_DIR, toDelete[1].srtFile);
        await fs.rm(srtPath, { force: true });
        delete cache[toDelete[0]];
        await saveCache(cache);
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

// ---------------------------------------------------------------------------
// WebSocket server for realtime caption streaming
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ noServer: true });

async function handleCaptionWebSocket(clientWs, requestUrl) {
  const videoUrl = requestUrl.searchParams.get("url");
  const initialTimestamp = Number(requestUrl.searchParams.get("t")) || 0;

  if (!videoUrl || !isValidHttpUrl(videoUrl)) {
    log("ws", "rejected — missing or invalid url parameter");
    clientWs.send(
      JSON.stringify({
        type: "error",
        message: "Missing or invalid url parameter.",
      }),
    );
    clientWs.close();
    return;
  }

  const videoId = extractVideoId(videoUrl);
  const jobKey = videoId || "unknown";
  log("ws", `connected — videoId=${jobKey} url=${videoUrl}`);

  activeConnectionCount++;

  // --- shared state across all pipelines for this connection ---
  const segments = [];
  const srtBaseName = videoId || createRequestId();
  const srtPath = path.join(CAPTIONS_DIR, `${srtBaseName}.srt`);
  const activePipelines = new Set();
  let seekDebounceTimer = null;

  const jobState = { segments, activePipelines: 0, videoDuration: 0 };
  activeJobs.set(jobKey, jobState);

  const COVERAGE_TOLERANCE_S = 2;
  let nextPipelineNum = 0;

  function isCoveredByOtherPipeline(t, excludePid) {
    return segments.some(
      (s) =>
        s._pid !== excludePid &&
        t >= s.start - COVERAGE_TOLERANCE_S &&
        t <= s.end + COVERAGE_TOLERANCE_S,
    );
  }

  function isTimeCovered(t) {
    return segments.some(
      (s) => t >= s.start - COVERAGE_TOLERANCE_S && t <= s.end + COVERAGE_TOLERANCE_S,
    );
  }

  function writeSrt() {
    return fs.writeFile(srtPath, buildSrtContent(segments), "utf8");
  }

  function updateJobState() {
    jobState.activePipelines = activePipelines.size;
  }

  function onPipelineCompleted() {
    activeJobs.delete(jobKey);

    writeSrt()
      .then(() =>
        addCacheEntry(
          videoUrl,
          videoId,
          path.basename(srtPath),
          segments.length,
        ),
      )
      .then(() => {
        log(
          "cache",
          `saved ${path.basename(srtPath)} (${segments.length} segments)`,
        );
      })
      .catch((err) => {
        log("cache", `failed to save: ${err.message}`);
      });

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "done", cached: false }));
    }

    log("ws", `pipeline completed — ${segments.length} segments total`);
  }

  function startPipeline(seekTimestamp) {
    const pipelineId = Symbol();
    const pid = ++nextPipelineNum;
    let pipelineEnded = false;

    function endPipeline(reason) {
      if (pipelineEnded) return;
      pipelineEnded = true;
      activePipelines.delete(pipelineId);
      updateJobState();

      if (activePipelines.size === 0 && reason !== "error" && segments.length > 0) {
        onPipelineCompleted();
      }
    }

    const handle = streamTranscribeFromUrl(videoUrl, {
      startTimestamp: seekTimestamp,
      getContextSegments: () => segments.slice(-3),
      onDuration(dur) {
        if (!jobState.videoDuration) {
          jobState.videoDuration = dur;
          log("ws", `video duration: ${dur}s`);
        }
      },

      onCues(newCues) {
        // Check coverage only against segments from OTHER pipelines
        const uncovered = newCues.filter(
          (cue) => !isCoveredByOtherPipeline(cue.start, pid),
        );

        if (uncovered.length > 0) {
          // Tag cues with this pipeline's ID
          for (const cue of uncovered) {
            cue._pid = pid;
          }

          segments.push(...uncovered);
          segments.sort((a, b) =>
            a.start !== b.start ? a.start - b.start : a.end - b.end,
          );

          writeSrt().catch(() => {});

          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "cues", cues: uncovered }));
          }
        }

        // Only stop when ALL cues are covered by OTHER pipelines
        if (uncovered.length === 0) {
          log(
            "stream",
            `pipeline from ${seekTimestamp}s hit covered territory, stopping`,
          );
          handle.teardown();
          endPipeline("coverage");
        }
      },

      onDone() {
        endPipeline("completed");
      },

      onError(err) {
        log("ws", `pipeline error (t=${seekTimestamp}s): ${err.message}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({ type: "error", message: err.message }),
          );
        }
        endPipeline("error");
      },
    });

    activePipelines.add(pipelineId);
    updateJobState();
  }

  // --- check cache before starting any pipelines ---
  try {
    const cached = await getCachedEntry(videoUrl);

    if (cached) {
      log(
        "cache",
        `hit for ${videoUrl} → ${cached.srtFile} (${cached.segmentCount} segments)`,
      );
      const srtContent = await fs.readFile(
        path.join(CAPTIONS_DIR, cached.srtFile),
        "utf8",
      );
      const cues = parseSrt(srtContent);

      if (cues.length > 0 && clientWs.readyState === WebSocket.OPEN) {
        segments.push(...cues);
        clientWs.send(JSON.stringify({ type: "cues", cues }));
        clientWs.send(JSON.stringify({ type: "done", cached: true }));
        activeJobs.delete(jobKey);
        activeConnectionCount--;
        clientWs.close();
        log("ws", `sent ${cues.length} cached cues and closed`);
        return;
      }
    } else {
      log("cache", `miss for ${videoUrl} — starting live transcription`);
    }
  } catch {
    log(
      "cache",
      `read error for ${videoUrl} — falling through to live transcription`,
    );
  }

  // --- listen for seek messages from the client ---
  clientWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "seek" && typeof msg.timestamp === "number") {
        if (seekDebounceTimer) clearTimeout(seekDebounceTimer);

        seekDebounceTimer = setTimeout(() => {
          if (isTimeCovered(msg.timestamp)) {
            log("ws", `seek to ${msg.timestamp}s — already covered`);
            return;
          }

          log("ws", `seek to ${msg.timestamp}s — starting new pipeline`);
          startPipeline(msg.timestamp);
        }, 500);
      }
    } catch {
      /* ignore malformed messages */
    }
  });

  // --- start initial pipeline ---
  startPipeline(initialTimestamp);

  clientWs.on("close", () => {
    activeConnectionCount--;
    if (seekDebounceTimer) clearTimeout(seekDebounceTimer);

    if (activePipelines.size > 0) {
      log("ws", "client disconnected — pipelines will continue to completion");
    }
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
