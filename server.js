/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (v8 - LOW LATENCY)
 *
 * ✅ Optimized timing for faster response
 */

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

// -------------------- Audio constants --------------------
const ELEVEN_SAMPLE_RATE = 16000;
const TWILIO_FRAME_BYTES = 160;
const PLAYER_INTERVAL_MS = 20;

const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, 0xff);

// -------------------- VAD / Turn config (OPTIMIZED) --------------------
const ENERGY_THRESHOLD = 0.015;            // Slightly more sensitive
const SILENCE_MS_TO_COMMIT = 500;          // ✅ 800 → 500ms (faster commit)
const MIN_SPOKE_MS_TO_COMMIT = 250;        // ✅ 400 → 250ms (faster commit)
const ANTI_ECHO_HOLD_MS = 350;             // ✅ 600 → 350ms (faster turn-taking)

const GREETING_DELAY_MS = 500;

// ============================================================================
// Mu-law (G.711) utils
// ============================================================================
const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i;
    let sign = (mulaw & 0x80) ? -1 : 1;
    let exponent = (mulaw >> 4) & 0x07;
    let mantissa = mulaw & 0x0F;
    let sample = (mantissa << 3) + 0x84;
    sample <<= exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

function decodeMulaw(buf) {
  const pcm = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) pcm[i] = MULAW_DECODE_TABLE[buf[i]];
  return pcm;
}

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulawByte = ~(sign | (exponent << 4) | mantissa);
  return mulawByte & 0xff;
}

function encodeMulaw(pcmSamples) {
  const mulaw = Buffer.alloc(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) mulaw[i] = linearToMulaw(pcmSamples[i]);
  return mulaw;
}

function upsample8to16(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    const a = pcm8k[i];
    const b = pcm8k[Math.min(i + 1, pcm8k.length - 1)];
    out[i * 2] = a;
    out[i * 2 + 1] = (a + b) >> 1;
  }
  return out;
}

function downsample16to8(pcm16k) {
  const out = new Int16Array(Math.floor(pcm16k.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = pcm16k[i * 2];
  return out;
}

function pcm16ToBase64(pcm) {
  const buf = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], i * 2);
  return buf.toString("base64");
}

function base64ToPcm16(b64) {
  const buf = Buffer.from(b64, "base64");
  const pcm = new Int16Array(buf.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
  return pcm;
}

function rmsEnergy(pcm16) {
  let sum = 0;
  for (let i = 0; i < pcm16.length; i++) {
    const x = pcm16[i] / 32768;
    sum += x * x;
  }
  return Math.sqrt(sum / pcm16.length);
}

function silence16kBase64(ms = 100) {
  const samples = Math.floor((ms / 1000) * ELEVEN_SAMPLE_RATE);
  const pcm = new Int16Array(samples);
  return pcm16ToBase64(pcm);
}

// ============================================================================
// ElevenLabs client
// ============================================================================
class ElevenLabs {
  constructor({ apiKey, agentId, onAudio, onAgentText, onUserText, logPrefix }) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.onAudio = onAudio;
    this.onAgentText = onAgentText;
    this.onUserText = onUserText;
    this.logPrefix = logPrefix || "[ElevenLabs]";

    this.ws = null;
    this.ready = false;
    
    this.audioChunksSent = 0;
    this.commitsSent = 0;
  }

  log(msg) {
    console.log(`${this.logPrefix} ${msg}`);
  }

  async connect() {
    const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(this.agentId)}`;
    const res = await fetch(url, { headers: { "xi-api-key": this.apiKey } });
    if (!res.ok) throw new Error(`ElevenLabs signed-url failed: ${await res.text()}`);
    const { signed_url } = await res.json();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(signed_url);

      this.ws.on("open", () => {
        this.log("WS open");
      });

      this.ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (msg.type === "ping" || msg.ping_event) {
          const eid = msg.ping_event?.event_id ?? msg.event_id;
          if (eid && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "pong", event_id: eid }));
          }
          return;
        }

        if (msg.type === "conversation_initiation_metadata") {
          this.ready = true;
          this.log("✅ ready");
          resolve();
          return;
        }

        if (msg.type === "audio") {
          const b64 =
            msg.audio_event?.audio_base_64 ||
            msg.audio?.chunk ||
            msg.audio?.audio_base_64 ||
            msg.audio_event?.chunk;
          if (b64) this.onAudio?.(b64);
          return;
        }

        if (msg.type === "agent_response") {
          const text = msg.agent_response_event?.agent_response;
          if (text) this.onAgentText?.(text);
          return;
        }

        if (msg.type === "user_transcript") {
          const text = msg.user_transcription_event?.user_transcript;
          if (text) this.onUserText?.(text);
          return;
        }
      });

      this.ws.on("close", (code, reason) => {
        this.ready = false;
        this.log(`WS close code=${code} reason=${reason?.toString?.() || ""}`);
      });

      this.ws.on("error", (err) => {
        this.log(`WS error: ${err?.message || err}`);
        reject(err);
      });

      setTimeout(() => resolve(), 8000);
    });
  }

  sendAudio(b64Pcm16_16k) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify({
        type: "user_audio_chunk",
        user_audio_chunk: b64Pcm16_16k,
      }));
      this.audioChunksSent++;
      return true;
    } catch {
      return false;
    }
  }

  commit() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify({ type: "user_audio_commit" }));
      this.commitsSent++;
      this.log(`📤 Commit #${this.commitsSent} (${this.audioChunksSent} chunks)`);
      return true;
    } catch {
      return false;
    }
  }

  triggerGreeting() {
    if (!this.ready) return false;
    this.log("🎬 Triggering greeting...");
    this.sendAudio(silence16kBase64(100));
    return this.commit();
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

// ============================================================================
// Call Session
// ============================================================================
class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;
    this.shortId = streamSid.slice(0, 8);

    this.closed = false;

    this.outBuf = Buffer.alloc(0);
    this.playTimer = null;
    this.frames = 0;

    this.lastAgentAudioAt = 0;
    this.bufferEmptiedAt = 0;

    this.userTalking = false;
    this.userSpeechStartAt = 0;
    this.lastVoiceAt = 0;
    this.userAudioChunks = 0;

    this.eleven = null;

    console.log(`[Session ${this.streamSid}] Created`);
  }

  async start() {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
      console.log(`[Session ${this.streamSid}] Missing ELEVEN env vars`);
      this.close("missing_env");
      return;
    }

    this.eleven = new ElevenLabs({
      apiKey: ELEVENLABS_API_KEY,
      agentId: ELEVENLABS_AGENT_ID,
      logPrefix: `[Session ${this.shortId}] [11L]`,
      onAudio: (b64) => this.onElevenAudio(b64),
      onAgentText: (t) => console.log(`[Session ${this.shortId}] [11L] 💬 Agent: ${t.substring(0, 90)}`),
      onUserText: (t) => console.log(`[Session ${this.shortId}] [11L] 👤 User: ${t}`),
    });

    await this.eleven.connect();
    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

    this.startPlayer();

    setTimeout(() => {
      if (!this.closed && this.eleven?.ready) {
        this.eleven.triggerGreeting();
      }
    }, GREETING_DELAY_MS);
  }

  startPlayer() {
    if (this.playTimer) return;

    this.playTimer = setInterval(() => {
      if (this.closed) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      let frame;

      // Clear residual buffer
      if (this.outBuf.length > 0 && 
          this.outBuf.length < TWILIO_FRAME_BYTES && 
          (now - this.lastAgentAudioAt) > 150) {
        this.outBuf = Buffer.alloc(0);
        this.bufferEmptiedAt = now;
      }

      if (this.outBuf.length >= TWILIO_FRAME_BYTES) {
        frame = this.outBuf.subarray(0, TWILIO_FRAME_BYTES);
        this.outBuf = this.outBuf.subarray(TWILIO_FRAME_BYTES);

        if (this.outBuf.length < TWILIO_FRAME_BYTES) {
          this.bufferEmptiedAt = now;
        }
      } else {
        frame = MULAW_SILENCE_FRAME;
      }

      try {
        this.twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: frame.toString("base64") },
        }));

        this.frames++;
        if (this.frames % 50 === 0) {
          console.log(`[Twilio ${this.shortId}] ▶️ frames=${this.frames} queue=${this.outBuf.length}`);
        }
      } catch {
        this.close("twilio_send_error");
      }
    }, PLAYER_INTERVAL_MS);
  }

  isAgentSpeaking() {
    const now = Date.now();

    if (this.outBuf.length >= TWILIO_FRAME_BYTES) {
      return true;
    }

    if (this.bufferEmptiedAt > 0 && (now - this.bufferEmptiedAt) < ANTI_ECHO_HOLD_MS) {
      return true;
    }

    return false;
  }

  onElevenAudio(b64Pcm16) {
    if (this.closed) return;

    this.lastAgentAudioAt = Date.now();

    const pcm16k = base64ToPcm16(b64Pcm16);
    const pcm8k = downsample16to8(pcm16k);
    const mulaw = encodeMulaw(pcm8k);

    this.outBuf = Buffer.concat([this.outBuf, mulaw]);
  }

  fromTwilio(b64Mulaw) {
    if (this.closed || !this.eleven || !this.eleven.ready) return;

    const now = Date.now();

    if (this.isAgentSpeaking()) {
      return;
    }

    let pcm8;
    try {
      pcm8 = decodeMulaw(Buffer.from(b64Mulaw, "base64"));
    } catch {
      return;
    }

    const e = rmsEnergy(pcm8);

    if (e > ENERGY_THRESHOLD) {
      this.lastVoiceAt = now;
      if (!this.userTalking) {
        this.userTalking = true;
        this.userSpeechStartAt = now;
        console.log(`[Session ${this.shortId}] 🎤 User speaking`);
      }
    }

    // Always send audio to ElevenLabs
    const pcm16 = upsample8to16(pcm8);
    if (this.eleven.sendAudio(pcm16ToBase64(pcm16))) {
      this.userAudioChunks++;
    }

    // Auto-commit with optimized timing
    if (this.userTalking) {
      const spokeMs = now - this.userSpeechStartAt;
      const silenceMs = this.lastVoiceAt ? (now - this.lastVoiceAt) : 0;

      if (silenceMs >= SILENCE_MS_TO_COMMIT && spokeMs >= MIN_SPOKE_MS_TO_COMMIT) {
        console.log(`[Session ${this.shortId}] ⚡ Commit (silence=${silenceMs}ms spoke=${spokeMs}ms)`);
        this.userTalking = false;
        this.userSpeechStartAt = 0;
        this.lastVoiceAt = 0;
        this.userAudioChunks = 0;
        this.eleven.commit();
      }
    }
  }

  close(reason = "unknown") {
    if (this.closed) return;
    this.closed = true;
    console.log(`[Session ${this.streamSid}] Closing reason=${reason}`);
    try { clearInterval(this.playTimer); } catch {}
    try { this.eleven?.close(); } catch {}
  }
}

// ============================================================================
// HTTP server
// ============================================================================
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  if (req.url === "/twiml") {
    const host = req.headers.host;
    const wsUrl = `wss://${host}/twilio-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="language" value="es-ES"/>
    </Stream>
  </Connect>
</Response>`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });
const sessions = new Map();

wss.on("connection", (ws, req) => {
  console.log(`[Server] New WebSocket connection from ${req.url}`);
  if (req.url !== "/twilio-stream") {
    ws.close();
    return;
  }

  let session = null;

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "connected") {
      console.log("[Twilio] Connected");
      return;
    }

    if (msg.event === "start") {
      const streamSid = msg.start?.streamSid;
      const callSid = msg.start?.callSid;
      console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);

      session = new CallSession(streamSid, ws);
      sessions.set(streamSid, session);

      try {
        await session.start();
      } catch (e) {
        console.log(`[Session ${streamSid}] start error: ${e?.message || e}`);
        session.close("start_error");
      }
      return;
    }

    if (msg.event === "media") {
      if (!session) return;
      session.fromTwilio(msg.media?.payload);
      return;
    }

    if (msg.event === "stop") {
      console.log("[Twilio] 📞 stop");
      if (session) {
        session.close("twilio_stop");
        sessions.delete(session.streamSid);
        session = null;
      }
      return;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[Twilio] WS close code=${code} reason=${reason?.toString?.() || ""}`);
    if (session) {
      session.close("twilio_ws_close");
      sessions.delete(session.streamSid);
      session = null;
    }
  });

  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   TwiML:  https://your-domain/twiml`);
  console.log(`   Health: https://your-domain/health`);

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.log("⚠️  Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }
});

process.on("SIGTERM", () => {
  for (const s of sessions.values()) s.close("sigterm");
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
});
