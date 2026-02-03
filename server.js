/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (FIXED)
 * - Twilio Media Streams (8kHz mu-law) <-> ElevenLabs ConvAI (16kHz PCM16 LE base64)
 * - Simple energy VAD + auto-commit on silence
 * - Anti-echo hold window while agent is playing
 * - ✅ FIX: Sends ALL audio to ElevenLabs (not just when voice detected)
 *
 * Env:
 *   PORT
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_AGENT_ID
 */

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.log("⚠️ Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
}

/* ───────────────────────── Audio utils (G.711 μ-law) ───────────────────────── */

const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulaw() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) ? -1 : 1;
    let exp = (mu >> 4) & 0x07;
    let mant = mu & 0x0f;
    let sample = (mant << 3) + 0x84;
    sample <<= exp;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 33;

  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;

  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let mu = ~(sign | (exponent << 4) | mantissa);
  return mu & 0xff;
}

function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE_TABLE[buf[i]];
  return out;
}

function encodeMulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

function upsample8to16(pcm8) {
  const out = new Int16Array(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) {
    const a = pcm8[i];
    const b = pcm8[Math.min(i + 1, pcm8.length - 1)];
    out[i * 2] = a;
    out[i * 2 + 1] = (a + b) >> 1;
  }
  return out;
}

function downsample16to8(pcm16) {
  const out = new Int16Array(Math.floor(pcm16.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = pcm16[i * 2];
  return out;
}

function pcm16ToBase64(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
  return b.toString("base64");
}

function base64ToPcm16(b64) {
  const b = Buffer.from(b64, "base64");
  const out = new Int16Array(b.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
  return out;
}

function rmsEnergy(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i] / 32768;
    sum += x * x;
  }
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

function silence16k(ms) {
  const n = Math.floor((ms / 1000) * 16000);
  return new Int16Array(n);
}

/* ───────────────────────── ElevenLabs client ───────────────────────── */

class ElevenLabs {
  constructor({ apiKey, agentId, onAudio, logPrefix }) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.onAudio = onAudio;
    this.logPrefix = logPrefix || "[ElevenLabs]";
    this.ws = null;
    this.ready = false;
    this.open = false;
  }

  log(msg) {
    console.log(`${this.logPrefix} ${msg}`);
  }

  async connect() {
    const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.agentId}`;
    const res = await fetch(url, { headers: { "xi-api-key": this.apiKey } });
    if (!res.ok) throw new Error(`signed-url failed: ${await res.text()}`);
    const { signed_url } = await res.json();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(signed_url);

      this.ws.on("open", () => {
        this.open = true;
        this.log("WS open");
      });

      this.ws.on("message", (d) => {
        let m;
        try {
          m = JSON.parse(d.toString());
        } catch {
          return;
        }

        // Ready signal
        if (m.type === "conversation_initiation_metadata") {
          this.ready = true;
          this.log("✅ ready");
          resolve(true);
          return;
        }

        // Audio (ConvAI devuelve audio_event.audio_base_64 normalmente)
        if (m.type === "audio") {
          const chunk =
            m.audio_event?.audio_base_64 ||
            m.audio?.chunk ||
            m.audio?.audio_base_64 ||
            m.audio_event?.chunk;

          if (chunk) this.onAudio?.(chunk);
          return;
        }

        // PING/PONG
        if (m.type === "ping") {
          const event_id = m.ping_event?.event_id ?? m.event_id;
          if (event_id && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "pong", event_id }));
          }
          return;
        }

        // Logs útiles
        if (m.type === "agent_response") {
          const t = m.agent_response_event?.agent_response;
          if (t) this.log(`💬 Agent: ${t.slice(0, 80)}`);
          return;
        }
        if (m.type === "user_transcript") {
          const t = m.user_transcription_event?.user_transcript;
          if (t) this.log(`👤 User: ${t.slice(0, 80)}`);
          return;
        }
      });

      this.ws.on("close", (code, reason) => {
        this.open = false;
        this.ready = false;
        this.log(`WS close code=${code} reason=${reason?.toString?.() || ""}`);
      });

      this.ws.on("error", (e) => {
        this.log(`WS error: ${e?.message || e}`);
        reject(e);
      });

      setTimeout(() => resolve(false), 8000);
    });
  }

  async waitReady(ms = 6000) {
    const t0 = Date.now();
    while (!this.ready && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
    return this.ready;
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  sendAudio(b64pcm16) {
    if (!this.ready) return false;
    return this.send({ type: "user_audio_chunk", user_audio_chunk: b64pcm16 });
  }

  commit() {
    if (!this.ready) return false;
    return this.send({ type: "user_audio_commit", user_audio_commit: true });
  }

  // Trigger greeting: 100ms silence + commit
  triggerGreeting() {
    if (!this.ready) return false;
    const s = pcm16ToBase64(silence16k(100));
    this.send({ type: "user_audio_chunk", user_audio_chunk: s });
    return this.commit();
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

/* ───────────────────────── Call session ───────────────────────── */

const TWILIO_FRAME_BYTES = 160; // 20ms at 8kHz mulaw
const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, 0xff);

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;

    // playback
    this.outBuf = Buffer.alloc(0);
    this.framesSent = 0;

    // states
    this.isActive = true;
    this.agentPlaying = false;
    this.lastAgentAudioAt = 0;

    // VAD / timing (telephony tuned)
    this.ENERGY_THRESHOLD = 0.02;       // speech typically >0.08; noise ~0.0002-0.003
    this.SILENCE_MS_TO_COMMIT = 750;    // auto-commit after 750ms silence
    this.MIN_SPOKE_MS = 300;            // ignore micro blips
    this.ANTI_ECHO_HOLD_MS = 900;       // ignore user audio shortly after agent audio

    this.userTalking = false;
    this.userSpeechStartAt = null;
    this.lastVoiceAt = Date.now();

    this.player = null;
    this.commitTimer = null;

    this.eleven = null;

    console.log(`[Session ${this.streamSid}] Created`);
  }

  async start() {
    this.eleven = new ElevenLabs({
      apiKey: ELEVENLABS_API_KEY,
      agentId: ELEVENLABS_AGENT_ID,
      onAudio: (b64) => this.fromEleven(b64),
      logPrefix: `[Session ${this.streamSid}] [ElevenLabs]`,
    });

    await this.eleven.connect();
    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

    // Start Twilio player (20ms frames)
    this.player = setInterval(() => this.playFrame(), 20);

    // Commit checker
    this.commitTimer = setInterval(() => this.maybeCommit(), 50);

    // Ensure ready then trigger greeting
    const ok = await this.eleven.waitReady(6000);
    if (!ok) console.log(`[Session ${this.streamSid}] ⚠️ ElevenLabs not ready in time`);
    else this.eleven.triggerGreeting();
  }

  playFrame() {
    if (!this.isActive) return;
    if (this.twilioWs.readyState !== WebSocket.OPEN) return;

    let frame;
    if (this.outBuf.length >= TWILIO_FRAME_BYTES) {
      frame = this.outBuf.subarray(0, TWILIO_FRAME_BYTES);
      this.outBuf = this.outBuf.subarray(TWILIO_FRAME_BYTES);
    } else {
      frame = MULAW_SILENCE_FRAME;
    }

    try {
      this.twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: frame.toString("base64") },
        })
      );
      this.framesSent++;
      if (this.framesSent % 50 === 0) {
        console.log(
          `[Twilio ${this.streamSid.slice(0, 8)}] ▶️ frames=${this.framesSent} queue=${this.outBuf.length}`
        );
      }
    } catch {
      this.close("twilio_send_error");
    }
  }

  // ✅ FIX: Enviar TODO el audio a ElevenLabs, no solo cuando detectamos voz
  fromTwilio(b64) {
    if (!this.isActive || !this.eleven) return;

    try {
      const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
      const e = rmsEnergy(pcm8);
      const now = Date.now();

      // Anti-echo: ignore while agent is/was playing recently
      const inAntiEcho = this.agentPlaying || (now - this.lastAgentAudioAt < this.ANTI_ECHO_HOLD_MS);
      if (inAntiEcho) return;

      // Track voice activity for auto-commit (VAD local)
      if (e > this.ENERGY_THRESHOLD) {
        this.lastVoiceAt = now;
        if (!this.userTalking) {
          this.userTalking = true;
          this.userSpeechStartAt = now;
          console.log(`[Session ${this.streamSid.slice(0, 8)}] 🎤 User started speaking`);
        }
      }

      // ✅ SIEMPRE enviar audio a ElevenLabs (su VAD lo procesa)
      const pcm16 = upsample8to16(pcm8);
      this.eleven.sendAudio(pcm16ToBase64(pcm16));

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
    const spokeFor = this.userSpeechStartAt ? now - this.userSpeechStartAt : 0;

    if (silentFor >= this.SILENCE_MS_TO_COMMIT && spokeFor >= this.MIN_SPOKE_MS) {
      console.log(
        `[Session ${this.streamSid}] ⚡ Auto-commit (silence ${silentFor}ms, spoke ${spokeFor}ms)`
      );
      this.userTalking = false;
      this.userSpeechStartAt = null;
      this.eleven.commit();
    }
  }

  fromEleven(b64) {
    if (!this.isActive) return;

    try {
      // mark agent playing + anti-echo window
      this.agentPlaying = true;
      this.lastAgentAudioAt = Date.now();

      const pcm16 = base64ToPcm16(b64);
      const pcm8 = downsample16to8(pcm16);
      const mulaw = encodeMulaw(pcm8);

      // enqueue for Twilio playback
      this.outBuf = Buffer.concat([this.outBuf, mulaw]);

      // If no new agent audio arrives, drop agentPlaying after hold
      setTimeout(() => {
        if (!this.isActive) return;
        if (Date.now() - this.lastAgentAudioAt >= this.ANTI_ECHO_HOLD_MS) {
          this.agentPlaying = false;
        }
      }, this.ANTI_ECHO_HOLD_MS);
    } catch (err) {
      console.log(`[Session ${this.streamSid}] fromEleven error: ${err?.message || err}`);
      this.close("from_eleven_error");
    }
  }

  close(reason = "unknown") {
    if (!this.isActive) return;
    this.isActive = false;

    console.log(`[Session ${this.streamSid}] Closing reason=${reason}`);

    try { clearInterval(this.player); } catch {}
    try { clearInterval(this.commitTimer); } catch {}
    try { this.eleven?.close(); } catch {}
  }
}

/* ───────────────────────── HTTP + WS server ───────────────────────── */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
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

  ws.on("message", async (d) => {
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }

    if (m.event === "connected") console.log("[Twilio] Connected");

    if (m.event === "start") {
      const { streamSid, callSid } = m.start || {};
      console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);
      session = new CallSession(streamSid, ws);
      try { await session.start(); } catch (e) {
        console.log(`[Twilio] session.start error: ${e?.message || e}`);
        session?.close("session_start_error");
      }
    }

    if (m.event === "media") {
      session?.fromTwilio(m.media?.payload);
    }

    if (m.event === "stop") {
      console.log("[Twilio] 📞 stop");
      session?.close("twilio_stop");
      session = null;
    }
  });

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
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   TwiML:  https://your-domain/twiml`);
  console.log(`   Health: https://your-domain/health`);
});
