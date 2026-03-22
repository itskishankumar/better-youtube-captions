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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
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

function createRequestId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function getNonEmptyLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

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

      resolve({
        audioPath,
        ytDlpStdout: stdout,
        ytDlpStderr: stderr
      });
    });
  });
}

async function writeSrtFile(audioPath, srtContent) {
  const srtPath = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.srt`
  );

  await fs.writeFile(srtPath, srtContent, "utf8");

  return srtPath;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
    await convertAudioToRealtimePcm(audioPath, pcmPath);
    const pcmBuffer = await fs.readFile(pcmPath);

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

const server = http.createServer(async (req, res) => {
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

      const requestId = createRequestId();
      const { audioPath, ytDlpStdout, ytDlpStderr } = await runYtDlp(videoUrl, requestId);

      sendJson(res, 200, {
        ok: true,
        requestId,
        audioFile: path.basename(audioPath),
        audioPath,
        ytDlpStdout,
        ytDlpStderr
      });
      return;
    }

    if (req.url === "/transcribe") {
      const audioPath = await resolveAudioPath(body.audioPath);
      const { srtPath, segmentCount } = await transcribeAudioRealtime(audioPath);

      sendJson(res, 200, {
        ok: true,
        mode: "realtime",
        audioFile: path.basename(audioPath),
        audioPath,
        srtFile: path.basename(srtPath),
        srtPath,
        segmentCount
      });
      return;
    }

    sendJson(res, 404, {
      error: "Not found. Use POST /download or POST /transcribe."
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
