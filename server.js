/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (v3.3 - anti-echo + correct commit)
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

/* ───────────── Audio utils (G.711 μ-law) ───────────── */

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

/* 20ms frames */
const TWILIO_FRAME_BYTES = 160;
const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, 0xff);

/* ───────────── ElevenLabs client ───────────── */

class ElevenLabs {
  constructor(onAudio, onLog) {
    this.ws = null;
    this.onAudio = onAudio;
    this.onLog = onLog;
    this.ready = false;
    this._readyResolver = null;
    this.readyPromise = new Promise((res) => (this._readyResolver = res));
  }

  async connect() {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (!r.ok) throw new Error(await r.text());
    const { signed_url } = await r.json();

    this.ws = new WebSocket(signed_url);

    this.ws.on("open", () => this.onLog?.("[ElevenLabs] WS open"));
    this.ws.on("close", (code, reason) => {
      this.onLog?.(`[ElevenLabs] WS close code=${code} reason=${reason?.toString?.() || ""}`);
      this.ready = false;
    });
    this.ws.on("error", (err) => this.onLog?.(`[ElevenLabs] WS error: ${err?.message || err}`));

    this.ws.on("message", (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }

      if (m.type === "conversation_initiation_metadata") {
        this.ready = true;
        this.onLog?.("[ElevenLabs] ✅ ready");
        this._readyResolver?.();
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

    // wait for ws open
    await new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
  }

  async waitReady(timeoutMs = 5000) {
    if (this.ready) return true;
    let t;
    const timeout = new Promise((res) => (t = setTimeout(() => res(false), timeoutMs)));
    const ok = await Promise.race([this.readyPromise.then(() => true), timeout]);
    clearTimeout(t);
    return ok;
  }

  sendAudio(b64) {
    if (!this.ready) return;
    try { this.ws.send(JSON.stringify({ user_audio_chunk: b64 })); } catch {}
  }

  commit() {
    if (!this.ready) return;
    // ✅ Correct ConvAI commit
    try { this.ws.send(JSON.stringify({ user_audio_commit: true })); } catch {}
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

/* ───────────── Call session (VAD + anti-echo) ───────────── */

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;
    this.isActive = true;

    this.eleven = null;

    this.outBuf = Buffer.alloc(0);
    this.framesSent = 0;

    // Agent playback tracking (anti-echo)
    this.agentPlaying = false;
    this.lastAgentAudioAt = 0;

    // VAD config
    this.ENERGY_THRESHOLD = 0.015;     // sube/baja según tu línea (en tus logs voz ~0.08-0.17)
    this.SILENCE_MS_TO_COMMIT = 700;
    this.MIN_SPOKE_MS = 250;
    this.ANTI_ECHO_HOLD_MS = 400;      // no escuchar “usuario” justo tras reproducir agente

    this.userTalking = false;
    this.userSpeechStartAt = null;
    this.lastVoiceAt = 0;

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

    const ok = await this.eleven.waitReady(6000);
    if (!ok) console.log(`[Session ${this.streamSid}] ⚠️ ElevenLabs not ready in time`);

    // Trigger greeting AFTER ready
    this.eleven.commit();
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
      this.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: frame.toString("base64") }
      }));
      this.framesSent++;

      if (this.framesSent % 50 === 0) {
        console.log(`[Twilio ${this.streamSid.slice(0, 8)}] ▶️ frames=${this.framesSent} queue=${this.outBuf.length}`);
      }
    } catch (e) {
      this.close("twilio_send_error");
    }
  }

  fromTwilio(b64) {
    if (!this.isActive || !this.eleven) return;

    try {
      const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
      const e = rmsEnergy(pcm8);
      const now = Date.now();

      // ✅ Anti-echo: if agent is/was playing recently, ignore VAD + don’t stream
      const inAntiEchoWindow = this.agentPlaying || (now - this.lastAgentAudioAt < this.ANTI_ECHO_HOLD_MS);
      if (inAntiEchoWindow) return;

      // VAD
      if (e > this.ENERGY_THRESHOLD) {
        this.lastVoiceAt = now;
        if (!this.userTalking) {
          this.userTalking = true;
          this.userSpeechStartAt = now;
        }
        // Only stream while speaking
        const pcm16 = upsample8to16(pcm8);
        this.eleven.sendAudio(pcm16ToBase64(pcm16));
      }
    } catch (err) {
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
      console.log(`[Session ${this.streamSid}] ⚡ Commit (silence ${silentFor}ms, spoke ${spokeFor}ms)`);
      this.userTalking = false;
      this.userSpeechStartAt = null;
      this.eleven?.commit();
    }
  }

  fromEleven(b64) {
    if (!this.isActive) return;
    try {
      // Mark agent audio playing
      this.agentPlaying = true;
      this.lastAgentAudioAt = Date.now();

      const pcm16 = base64ToPcm16(b64);
      const pcm8 = downsample16to8(pcm16);
      const mulaw = encodeMulaw(pcm8);

      this.outBuf = Buffer.concat([this.outBuf, mulaw]);

      // When buffer drains, agentPlaying will naturally stop after hold window
      if (this.outBuf.length < 320) {
        // keep flag true briefly; anti-echo window handles it
        setTimeout(() => {
          if (!this.isActive) return;
          if (Date.now() - this.lastAgentAudioAt >= this.ANTI_ECHO_HOLD_MS) {
            this.agentPlaying = false;
          }
        }, this.ANTI_ECHO_HOLD_MS);
      }
    } catch (err) {
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

/* ───────────── HTTP + WS ───────────── */

const server = http.createServer((req, res) => {
  if (req.url === "/health") return res.writeHead(200).end("ok");

  if (req.url === "/twiml") {
    const wsUrl = `wss://${req.headers.host}/twilio-stream`;
    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end(`<?xml version="1.0"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
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
    try { m = JSON.parse(d.toString()); } catch { return; }

    if (m.event === "connected") console.log("[Twilio] Connected");

    if (m.event === "start") {
      const { streamSid, callSid } = m.start;
      console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);
      session = new CallSession(streamSid, ws);
      try { await session.start(); } catch (e) { session?.close("session_start_error"); }
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
