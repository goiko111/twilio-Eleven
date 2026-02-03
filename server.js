/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (STABLE)
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
    out[i * 2 + 1] = samples[i];
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
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], i * 2);
  }
  return buf.toString("base64");
}

function base64ToPcm16(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
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

    await new Promise((res) => this.ws.on("open", res));
  }

  sendAudio(b64) {
    if (this.ready) {
      this.ws.send(JSON.stringify({ user_audio_chunk: b64 }));
    }
  }

  commit() {
    if (this.ready) {
      this.ws.send(JSON.stringify({ type: "user_audio_commit" }));
    }
  }

  triggerGreeting() {
    this.commit();
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

/* ───────────────────── CALL SESSION ───────────────────── */

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;
    this.eleven = null;
    this.buffer = Buffer.alloc(0);

    this.player = setInterval(() => {
      if (this.buffer.length < 160) return;
      const frame = this.buffer.subarray(0, 160);
      this.buffer = this.buffer.subarray(160);
      this.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: frame.toString("base64") }
      }));
    }, 20);
  }

  async start() {
    this.eleven = new ElevenLabs((b64) => this.fromEleven(b64));
    await this.eleven.connect();
    this.eleven.triggerGreeting();
  }

  fromTwilio(b64) {
    const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
    const pcm16 = upsample8to16(pcm8);
    this.eleven.sendAudio(pcm16ToBase64(pcm16));
  }

  endUserTurn() {
    this.eleven.commit();
  }

  fromEleven(b64) {
    const pcm16 = base64ToPcm16(b64);
    const pcm8 = downsample16to8(pcm16);
    this.buffer = Buffer.concat([this.buffer, encodeMulaw(pcm8)]);
  }

  close() {
    clearInterval(this.player);
    this.eleven?.close();
  }
}

/* ───────────────────── SERVER ───────────────────── */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  if (req.url === "/twiml") {
    const wsUrl = `wss://${req.headers.host}/twilio-stream`;
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
    return;
  }

  res.writeHead(404).end();
});

const wss = new WebSocket.Server({ server });
const sessions = new Map();

wss.on("connection", (ws) => {
  let session = null;

  ws.on("message", async (d) => {
    const m = JSON.parse(d.toString());
    if (m.event === "start") {
      session = new CallSession(m.start.streamSid, ws);
      sessions.set(m.start.streamSid, session);
      await session.start();
    }
    if (m.event === "media") {
      session?.fromTwilio(m.media.payload);
    }
    if (m.event === "stop") {
      session?.close();
    }
  });

  ws.on("close", () => session?.close());
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

process.on("SIGTERM", () => {
  sessions.forEach((s) => s.close());
  process.exit(0);
});
