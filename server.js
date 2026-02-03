/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (STABLE + AUTO-COMMIT)
 * Node 18+
 */

const http = require("http");
const WebSocket = require("ws");
const fetch = global.fetch;

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.warn("⚠️ Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
}

/* ───────────────────────── AUDIO UTILS ───────────────────────── */

const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulaw() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = mu & 0x80 ? -1 : 1;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    MULAW_DECODE_TABLE[i] = sign * (sample - 0x84);
  }
})();

function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE_TABLE[buf[i]];
  return out;
}

function encodeMulaw(samples) {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s += 33;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
    const mant = (s >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | mant);
  }
  return out;
}

function upsample8to16(samples) {
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = samples[i];
    out[i * 2 + 1] = samples[i]; // zero-order hold, simple & stable
  }
  return out;
}

function downsample16to8(samples) {
  const out = new Int16Array(samples.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = samples[i * 2];
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

function rmsEnergy(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = samples[i] / 32768;
    sum += n * n;
  }
  return Math.sqrt(sum / samples.length);
}

/* ───────────────────── ELEVENLABS CLIENT ───────────────────── */

class ElevenLabs {
  constructor(onAudio) {
    this.ws = null;
    this.onAudio = onAudio;
    this.ready = false;
  }

  async connect() {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`ElevenLabs get-signed-url failed: ${t}`);
    }

    const { signed_url } = await r.json();
    this.ws = new WebSocket(signed_url);

    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());

      if (m.type === "conversation_initiation_metadata") {
        this.ready = true;
      }

      if (m.type === "audio" && m.audio_event?.audio_base_64) {
        this.onAudio(m.audio_event.audio_base_64);
      }

      if (m.type === "ping") {
        this.ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event.event_id }));
      }
    });

    await new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
  }

  sendAudio(b64) {
    if (!this.ready) return;
    this.ws.send(JSON.stringify({ user_audio_chunk: b64 }));
  }

  commit() {
    if (!this.ready) return;
    // Compat: algunos agentes aceptan uno u otro
    this.ws.send(JSON.stringify({ type: "user_audio_commit" }));
    this.ws.send(JSON.stringify({ user_audio_commit: true }));
  }

  triggerGreeting() {
    this.commit();
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

/* ───────────────────── CALL SESSION ───────────────────── */

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;

    this.eleven = null;

    // Twilio playback buffer (mu-law bytes)
    this.outBuf = Buffer.alloc(0);

    // Simple “silence commit” state
    this.lastVoiceAt = Date.now();
    this.userTalking = false;

    // Tunables
    this.SILENCE_MS_TO_COMMIT = 700;   // cuando te callas 700ms -> commit
    this.ENERGY_THRESHOLD = 0.01;      // umbral para decir “hay voz”
    this.MIN_AUDIO_BEFORE_COMMIT_MS = 250; // no commit por golpes/ruido
    this.userSpeechStartAt = null;

    // Player 20ms frames
    this.player = setInterval(() => this.playFrame(), 20);

    // Commit watcher
    this.commitTimer = setInterval(() => this.maybeCommit(), 100);

    console.log(`[Session ${streamSid}] Created`);
  }

  async start() {
    this.eleven = new ElevenLabs((b64) => this.fromEleven(b64));
    await this.eleven.connect();
    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);
    this.eleven.triggerGreeting();
  }

  playFrame() {
    if (this.twilioWs.readyState !== WebSocket.OPEN) return;
    if (this.outBuf.length < 160) return;

    const frame = this.outBuf.subarray(0, 160);
    this.outBuf = this.outBuf.subarray(160);

    this.twilioWs.send(JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: frame.toString("base64") }
    }));
  }

  fromTwilio(b64) {
    const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
    const e = rmsEnergy(pcm8);

    // Track “voice activity” very simply
    const now = Date.now();
    if (e > this.ENERGY_THRESHOLD) {
      this.lastVoiceAt = now;
      if (!this.userTalking) {
        this.userTalking = true;
        this.userSpeechStartAt = now;
      }
    }

    // Always forward audio to ElevenLabs (it will decide internally)
    const pcm16 = upsample8to16(pcm8);
    this.eleven.sendAudio(pcm16ToBase64(pcm16));
  }

  maybeCommit() {
    if (!this.userTalking) return;

    const now = Date.now();
    const silentFor = now - this.lastVoiceAt;
    const spokeFor = this.userSpeechStartAt ? (now - this.userSpeechStartAt) : 0;

    if (silentFor >= this.SILENCE_MS_TO_COMMIT && spokeFor >= this.MIN_AUDIO_BEFORE_COMMIT_MS) {
      console.log(`[Session ${this.streamSid}] ⚡ Auto-commit (silence ${silentFor}ms, spoke ${spokeFor}ms)`);
      this.userTalking = false;
      this.userSpeechStartAt = null;
      this.eleven.commit();
    }
  }

  fromEleven(b64) {
    const pcm16 = base64ToPcm16(b64);
    const pcm8 = downsample16to8(pcm16);
    const mulaw = encodeMulaw(pcm8);
    this.outBuf = Buffer.concat([this.outBuf,]()
