/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (v3.2 STABLE)
 * - Prevent commits after close
 * - Logs close reasons/errors
 * - Sends comfort-silence frames to Twilio to avoid early hangups
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

/* 20ms silence frame in μ-law: use 0xFF (common μ-law “silence”) */
const TWILIO_FRAME_BYTES = 160;
const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, 0xff);

/* ───────────────────── ELEVENLABS CLIENT ───────────────────── */

class ElevenLabs {
  constructor(onAudio, onLog) {
    this.ws = null;
    this.onAudio = onAudio;
    this.onLog = onLog;
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

    this.ws.on("open", () => {
      this.onLog?.("[ElevenLabs] WS open");
    });

    this.ws.on("close", (code, reason) => {
      this.onLog?.(`[ElevenLabs] WS close code=${code} reason=${reason?.toString?.() || ""}`);
      this.ready = false;
    });

    this.ws.on("error", (err) => {
      this.onLog?.(`[ElevenLabs] WS error: ${err?.message || err}`);
    });

    this.ws.on("message", (d) => {
      let m;
      try {
        m = JSON.parse(d.toString());
      } catch (e) {
        this.onLog?.("[ElevenLabs] Bad JSON message");
        return;
      }

      if (m.type === "conversation_initiation_metadata") {
        this.ready = true;
        this.onLog?.("[ElevenLabs] ✅ ready");
      }

      if (m.type === "audio" && m.audio_event?.audio_base_64) {
        this.onAudio(m.audio_event.audio_base_64);
      }

      if (m.type === "ping") {
        try {
          this.ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event.event_id }));
        } catch {}
      }
    });

    await new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
  }

  sendAudio(b64) {
    if (!this.ready) return;
    try {
      this.ws.send(JSON.stringify({ user_audio_chunk: b64 }));
    } catch {}
  }

  commit() {
    if (!this.ready) return;
    try {
      this.ws.send(JSON.stringify({ type: "user_audio_commit" }));
    } catch {}
    try {
      this.ws.send(JSON.stringify({ user_audio_commit: true }));
    } catch {}
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

    this.isActive = true;

    this.eleven = null;

    this.outBuf = Buffer.alloc(0);

    this.lastVoiceAt = Date.now();
    this.userTalking = false;

    this.SILENCE_MS_TO_COMMIT = 700;
    this.ENERGY_THRESHOLD = 0.01;
    this.MIN_AUDIO_BEFORE_COMMIT_MS = 250;
    this.userSpeechStartAt = null;

    this.framesSent = 0;
    this.lastTwilioSendAt = Date.now();

    this.player = setInterval(() => this.playFrame(), 20);
    this.commitTimer = setInterval(() => this.maybeCommit(), 100);

    console.log(`[Session ${streamSid}] Created`);
  }

  async start() {
    this.eleven = new ElevenLabs(
      (b64) => this.fromEleven(b64),
      (msg) => console.log(`[Session ${this.streamSid}] ${msg}`)
    );
    await this.eleven.connect();
    if (!this.isActive) return;
    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);
    this.eleven.triggerGreeting();
  }

  playFrame() {
    if (!this.isActive) return;
    if (this.twilioWs.readyState !== WebSocket.OPEN) return;

    // If we have audio, send it. Otherwise, send silence to keep Twilio alive.
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
      this.framesSent++;
      this.lastTwilioSendAt = Date.now();

      if (this.framesSent % 50 === 0) {
        console.log(`[Twilio ${this.streamSid.slice(0, 8)}] ▶️ frames=${this.framesSent} queue=${this.outBuf.length}`);
      }
    } catch (e) {
      console.log(`[Session ${this.streamSid}] Twilio send error -> closing: ${e?.message || e}`);
      this.close("twilio_send_error");
    }
  }

  fromTwilio(b64) {
    if (!this.isActive) return;
    if (!this.eleven) return;

    try {
      const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
      const e = rmsEnergy(pcm8);

      const now = Date.now();
      if (e > this.ENERGY_THRESHOLD) {
        this.lastVoiceAt = now;
        if (!this.userTalking) {
          this.userTalking = true;
          this.userSpeechStartAt = now;
        }
      }

      const pcm16 = upsample8to16(pcm8);
      this.eleven.sendAudio(pcm16ToBase64(pcm16));
    } catch (err) {
      console.log(`[Session ${this.streamSid}] fromTwilio error -> closing: ${err?.message || err}`);
      this.close("from_twilio_error");
    }
  }

  maybeCommit() {
    if (!this.isActive) return;
    if (!this.userTalking) return;

    const now = Date.now();
    const silentFor = now - this.lastVoiceAt;
    const spokeFor = this.userSpeechStartAt ? (now - this.userSpeechStartAt) : 0;

    if (silentFor >= this.SILENCE_MS_TO_COMMIT && spokeFor >= this.MIN_AUDIO_BEFORE_COMMIT_MS) {
      console.log(`[Session ${this.streamSid}] ⚡ Auto-commit (silence ${silentFor}ms, spoke ${spokeFor}ms)`);
      this.userTalking = false;
      this.userSpeechStartAt = null;
      this.eleven?.commit();
    }
  }

  fromEleven(b64) {
    if (!this.isActive) return;
    try {
      const pcm16 = base64ToPcm16(b64);
      const pcm8 = downsample16to8(pcm16);
      const mulaw = encodeMulaw(pcm8);

      // ✅ IMPORTANT: correct concat
      this.outBuf = Buffer.concat([this.outBuf, mulaw]);
    } catch (err) {
      console.log(`[Session ${this.streamSid}] fromEleven error -> closing: ${err?.message || err}`);
      this.close("from_eleven_error");
    }
  }

  close(reason = "unknown") {
    if (!this.isActive) return;
    this.isActive = false;
    console.log(`[Session ${this.streamSid}] Closing reason=${reason}`);

    clearInterval(this.player);
    clearInterval(this.commitTimer);

    try { this.eleven?.close(); } catch {}
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
    try {
      m = JSON.parse(d.toString());
    } catch {
      console.log("[Twilio] Bad JSON message");
      return;
    }

    if (m.event === "connected") {
      console.log("[Twilio] Connected");
    }

    if (m.event === "start") {
      const { streamSid, callSid } = m.start;
      console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);
      session = new CallSession(streamSid, ws);
      try {
        await session.start();
      } catch (e) {
        console.log(`[Twilio] session.start error: ${e?.message || e}`);
        session?.close("session_start_error");
      }
    }

    if (m.event === "media") {
      session?.fromTwilio(m.media.payload);
    }

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
