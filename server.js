/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (fixed)
 * - Twilio Media Streams (8kHz mu-law) <-> ElevenLabs ConvAI (16kHz PCM16)
 * - Robust anti-echo + queue-drain handling + correct ElevenLabs message types
 *
 * Env:
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_AGENT_ID
 *   PORT (optional)
 */

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.warn("⚠️ Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
}

/* ───────────── Audio constants ───────────── */

const TWILIO_SR = 8000;
const ELEVEN_SR = 16000;

// Twilio wants 20ms frames at 8kHz mu-law => 160 bytes
const TWILIO_FRAME_BYTES = 160;
const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, 0xff); // μ-law silence-ish

/* ───────────── Mu-law codec ───────────── */

const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i;
    let sign = (mulaw & 0x80) ? -1 : 1;
    let exponent = (mulaw >> 4) & 0x07;
    let mantissa = mulaw & 0x0f;
    let sample = (mantissa << 3) + 0x84;
    sample <<= exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE_TABLE[buf[i]];
  return out;
}

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 33;

  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;

  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);

  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let mulawByte = ~(sign | (exponent << 4) | mantissa);
  return mulawByte & 0xff;
}

function encodeMulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

function upsample8to16(samples8k) {
  const out = new Int16Array(samples8k.length * 2);
  for (let i = 0; i < samples8k.length; i++) {
    const curr = samples8k[i];
    const next = samples8k[Math.min(i + 1, samples8k.length - 1)];
    out[i * 2] = curr;
    out[i * 2 + 1] = (curr + next) >> 1;
  }
  return out;
}

function downsample16to8(samples16k) {
  const out = new Int16Array(Math.floor(samples16k.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = samples16k[i * 2];
  return out;
}

function pcm16ToBase64(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf.toString("base64");
}

function base64ToPcm16(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function rmsEnergy(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i] / 32768;
    sum += x * x;
  }
  return Math.sqrt(sum / pcm.length);
}

/* ───────────── ElevenLabs ConvAI WS client ───────────── */

class ElevenLabs {
  constructor({ apiKey, agentId, onAudio, onText, onUserText, onLogPrefix }) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.onAudio = onAudio;
    this.onText = onText;
    this.onUserText = onUserText;
    this.onLogPrefix = onLogPrefix || "";
    this.ws = null;
    this.ready = false;
    this.open = false;
  }

  log(msg) {
    console.log(`${this.onLogPrefix}[ElevenLabs] ${msg}`);
  }

  async connect() {
    const url = await this.getSignedUrl();
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.open = true;
        this.log("WS open");
      });

      this.ws.on("message", (d) => {
        let m;
        try { m = JSON.parse(d.toString()); } catch { return; }

        if (m.type === "conversation_initiation_metadata") {
          this.ready = true;
          this.log("✅ ready");
        }

        if (m.type === "audio") {
          const chunk =
            m.audio?.chunk ||
            m.audio_event?.audio_base_64 ||
            m.audio_event?.chunk ||
            m.audio?.audio_base_64;

          if (chunk) this.onAudio?.(chunk);
        }

        if (m.type === "agent_response") {
          const t = m.agent_response_event?.agent_response;
          if (t) this.onText?.(t);
        }

        if (m.type === "user_transcript") {
          const t = m.user_transcription_event?.user_transcript;
          if (t) this.onUserText?.(t);
        }

        if (m.type === "ping") {
          const id = m.ping_event?.event_id || m.event_id;
          if (id && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "pong", event_id: id }));
          }
        }
      });

      this.ws.on("close", (code, reason) => {
        this.log(`WS close code=${code} reason=${reason?.toString?.() || ""}`);
        this.open = false;
        this.ready = false;
      });

      this.ws.on("error", (err) => {
        this.log(`WS error: ${err?.message || err}`);
        reject(err);
      });

      // resolve quickly; readiness is via waitReady()
      resolve();
    });
  }

  async getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.agentId}`,
      { headers: { "xi-api-key": this.apiKey } }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Signed URL error: ${t}`);
    }
    const j = await res.json();
    return j.signed_url;
  }

  async waitReady(ms = 6000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.ready) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  sendAudio(b64) {
    if (!this.open || !this.ready) return;
    // ✅ REQUIRED: include type
    this.ws.send(JSON.stringify({
      type: "user_audio_chunk",
      user_audio_chunk: b64
    }));
  }

  commit() {
    if (!this.open || !this.ready) return;
    // ✅ REQUIRED: include type
    this.ws.send(JSON.stringify({
      type: "user_audio_commit",
      user_audio_commit: true
    }));
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

/* ───────────── Call session ───────────── */

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;

    this.isActive = true;

    // Twilio output buffer (mu-law)
    this.outBuf = Buffer.alloc(0);
    this.frames = 0;

    // Agent audio timing
    this.lastAgentAudioAt = 0;

    // User VAD / commit
    this.ENERGY_THRESHOLD = 0.02; // tune to your line
    this.SILENCE_MS_TO_COMMIT = 800;
    this.MIN_SPOKE_MS = 500;

    this.userTalking = false;
    this.userSpeechStartAt = null;
    this.lastVoiceAt = 0;

    // Anti-echo
    this.ANTI_ECHO_HOLD_MS = 800; // short cushion after last agent audio

    // Timers
    this.playTimer = null;
    this.commitTimer = null;

    // ElevenLabs
    this.eleven = null;

    console.log(`[Session ${this.streamSid}] Created`);
  }

  async start() {
    this.eleven = new ElevenLabs({
      apiKey: ELEVENLABS_API_KEY,
      agentId: ELEVENLABS_AGENT_ID,
      onAudio: (b64) => this.fromEleven(b64),
      onText: (t) => console.log(`[Session ${this.streamSid}] [ElevenLabs] 💬 Agent: ${t.substring(0, 100)}`),
      onUserText: (t) => console.log(`[Session ${this.streamSid}] [ElevenLabs] 👤 User: ${t}`),
      onLogPrefix: `[Session ${this.streamSid}] `
    });

    await this.eleven.connect();
    const ok = await this.eleven.waitReady(6000);
    if (!ok) console.log(`[Session ${this.streamSid}] ⚠️ ElevenLabs not ready in time`);

    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

    this.startPlayer();

    // auto-commit checker
    this.commitTimer = setInterval(() => this.maybeCommit(), 100);

    // Trigger greeting AFTER ready (commit an empty turn)
    this.eleven.commit();
  }

  startPlayer() {
    if (this.playTimer) return;

    this.playTimer = setInterval(() => {
      if (!this.isActive) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      // ✅ clear "ghost tail" (<1 frame) if agent audio stopped a bit ago
      if (
        this.outBuf.length > 0 &&
        this.outBuf.length < TWILIO_FRAME_BYTES &&
        (now - this.lastAgentAudioAt) > 300
      ) {
        this.outBuf = Buffer.alloc(0);
      }

      // Need a full frame to send; otherwise just send silence
      let frame;
      if (this.outBuf.length >= TWILIO_FRAME_BYTES) {
        frame = this.outBuf.subarray(0, TWILIO_FRAME_BYTES);
        this.outBuf = this.outBuf.subarray(TWILIO_FRAME_BYTES);
      } else {
        frame = MULAW_SILENCE_FRAME;
      }

      try {
        this.twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: frame.toString("base64") }
        }));
      } catch {
        return this.close("twilio_send_error");
      }

      this.frames++;
      if (this.frames % 50 === 0) {
        console.log(`[Twilio ${this.streamSid.slice(0, 8)}] ▶️ frames=${this.frames} queue=${this.outBuf.length}`);
      }
    }, 20);
  }

  fromTwilio(b64) {
    if (!this.isActive || !this.eleven) return;

    try {
      const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
      const e = rmsEnergy(pcm8);
      const now = Date.now();

      // ✅ Robust anti-echo:
      // - if there is still audio queued to play, do NOT listen
      // - plus a short cushion after last agent audio
      const inAntiEcho =
        (this.outBuf.length > 0) ||
        (now - this.lastAgentAudioAt < this.ANTI_ECHO_HOLD_MS);

      if (inAntiEcho) return;

      // VAD start/keep talking
      if (e > this.ENERGY_THRESHOLD) {
        this.lastVoiceAt = now;
        if (!this.userTalking) {
          this.userTalking = true;
          this.userSpeechStartAt = now;
          console.log(`[Session ${this.streamSid.slice(0, 8)}] 🎤 User started speaking (energy=${e.toFixed(3)})`);
        }
      }

      // If user is in talking mode, keep streaming audio even if energy dips
      if (this.userTalking) {
        const pcm16 = upsample8to16(pcm8);
        this.eleven.sendAudio(pcm16ToBase64(pcm16));
      }
    } catch (err) {
      console.log(`[Session ${this.streamSid}] fromTwilio error: ${err?.message || err}`);
      this.close("from_twilio_error");
    }
  }

  maybeCommit() {
    if (!this.isActive) return;
    if (!this.userTalking) return;

    const now = Date.now();
    const silentFor = now - this.lastVoiceAt;
    const spokeFor = this.userSpeechStartAt ? (now - this.userSpeechStartAt) : 0;

    if (silentFor >= this.SILENCE_MS_TO_COMMIT && spokeFor >= this.MIN_SPOKE_MS) {
      console.log(`[Session ${this.streamSid}] ⚡ Auto-commit (silence ${silentFor}ms, spoke ${spokeFor}ms)`);
      this.userTalking = false;
      this.userSpeechStartAt = null;
      this.eleven?.commit();
    }
  }

  fromEleven(b64) {
    if (!this.isActive) return;
    try {
      this.lastAgentAudioAt = Date.now();

      const pcm16 = base64ToPcm16(b64);
      const pcm8 = downsample16to8(pcm16);
      const mulaw = encodeMulaw(pcm8);

      this.outBuf = Buffer.concat([this.outBuf, mulaw]);
    } catch (err) {
      console.log(`[Session ${this.streamSid}] fromEleven error: ${err?.message || err}`);
      this.close("from_eleven_error");
    }
  }

  close(reason = "unknown") {
    if (!this.isActive) return;
    this.isActive = false;
    console.log(`[Session ${this.streamSid}] Closing reason=${reason}`);
    try { clearInterval(this.playTimer); } catch {}
    try { clearInterval(this.commitTimer); } catch {}
    try { this.eleven?.close(); } catch {}
  }
}

/* ───────────── HTTP + WS server ───────────── */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
    // IMPORTANT: Twilio needs a FULL https URL. In Twilio console you must set:
    // https://<your-railway-domain>/twiml
    const wsUrl = `wss://${req.headers.host}/twilio-stream`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
  }

  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  console.log(`[Server] New WebSocket connection from ${req.url}`);

  let session = null;

  ws.on("close", (code, reason) => {
    console.log(`[Twilio] WS close code=${code} reason=${reason?.toString?.() || ""}`);
    session?.close("twilio_ws_close");
    session = null;
  });

  ws.on("error", (err) => {
    console.log(`[Twilio] WS error: ${err?.message || err}`);
    session?.close("twilio_ws_error");
    session = null;
  });

  ws.on("message", async (d) => {
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }

    if (m.event === "connected") console.log("[Twilio] Connected");

    if (m.event === "start") {
      const { streamSid, callSid } = m.start;
      console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);

      session = new CallSession(streamSid, ws);
      try {
        await session.start();
      } catch (e) {
        console.log(`[Session ${streamSid}] start error: ${e?.message || e}`);
        session?.close("session_start_error");
      }
    }

    if (m.event === "media") session?.fromTwilio(m.media.payload);

    if (m.event === "stop") {
      console.log("[Twilio] 📞 stop");
      session?.close("twilio_stop");
      session = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   TwiML:  https://your-domain/twiml`);
  console.log(`   Health: https://your-domain/health`);
});
