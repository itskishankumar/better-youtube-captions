const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const { GoogleGenAI } = require("@google/genai");

let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

// ---------------------------------------------------------------------------
// Gemini Sanity Pass
// ---------------------------------------------------------------------------

async function sanitizeCuesWithGemini(contextSegments, newCues) {
  if (!ai || newCues.length === 0) return newCues;

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

    const response = await ai.models.generateContent({
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

function streamTranscribeFromUrl(videoUrl, { onCues, onDone, onError }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    process.nextTick(() =>
      onError(new Error("ELEVENLABS_API_KEY is not set.")),
    );
    return;
  }

  const videoId = extractVideoId(videoUrl);
  const srtBaseName = videoId || createRequestId();
  const srtPath = path.join(CAPTIONS_DIR, `${srtBaseName}.srt`);

  log(
    "stream",
    `starting pipeline for ${videoUrl} (videoId=${videoId || "unknown"})`,
  );

  let failed = false;
  let ytDlpChild = null;
  let ffmpegChild = null;
  let elWs = null;
  const segments = [];
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
      log("stream", "spawning yt-dlp (stdout mode)...");
      ytDlpChild = spawn(
        BINARY_PATH,
        ["-f", "bestaudio", "-o", "-", "--no-progress", videoUrl],
        { cwd: __dirname },
      );

      log("stream", "spawning ffmpeg (pipe:0 → pcm_s16le → pipe:1)...");
      ffmpegChild = spawn(
        "ffmpeg",
        [
          "-i",
          "pipe:0",
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
        ],
        { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] },
      );

      ytDlpChild.stdout.pipe(ffmpegChild.stdin);
      ffmpegChild.stdin.on("error", () => {});

      let ytDlpStderr = "";
      ytDlpChild.stderr.on("data", (chunk) => {
        ytDlpStderr += chunk.toString();
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
            try {
              let newCues = createSrtSegmentsFromRealtimeEvent(event);
              let preview = newCues
                .map((c) => c.text.replace(/\n/g, " "))
                .join(" | ");
              log(
                "ElevenLabs",
                `Received | +${newCues.length} cue(s) (${segments.length} total): ${preview}`,
              );

              newCues = await sanitizeCuesWithGemini(segments, newCues);

              const updated = insertSegmentsChronologically(segments, newCues);
              segments.length = 0;
              segments.push(...updated);

              await fs.writeFile(srtPath, buildSrtContent(segments), "utf8");

              preview = newCues
                .map((c) => c.text.replace(/\n/g, " "))
                .join(" | ");
              log(
                "gemini",
                `Sanitized | +${newCues.length} cue(s) (${segments.length} total): ${preview}`,
              );

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
            log(
              "stream",
              `pipeline complete → ${path.basename(srtPath)} (${segments.length} segments)`,
            );
            onDone({
              srtPath,
              srtFile: path.basename(srtPath),
              segmentCount: segments.length,
              videoId,
            });
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

  sendJson(res, 404, { error: "Not found." });
});

// ---------------------------------------------------------------------------
// WebSocket server for realtime caption streaming
// ---------------------------------------------------------------------------

const wss = new WebSocket.Server({ noServer: true });

async function handleCaptionWebSocket(clientWs, requestUrl) {
  const videoUrl = requestUrl.searchParams.get("url");

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
  log("ws", `connected — videoId=${videoId || "unknown"} url=${videoUrl}`);

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
    log(
      "cache",
      `read error for ${videoUrl} — falling through to live transcription`,
    );
  }

  let finished = false;

  streamTranscribeFromUrl(videoUrl, {
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
    },
  });

  clientWs.on("close", () => {
    if (!finished) {
      log("ws", "client disconnected — pipeline will continue to completion");
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
