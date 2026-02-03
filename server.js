/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (stable + low-latency)
 * Node 18+
 *
 * Env:
 *  - ELEVENLABS_API_KEY
 *  - ELEVENLABS_AGENT_ID
 *  - PORT (optional)
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

/* ───────────────────────── Audio utils (G.711 μ-law) ───────────────────────── */

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
  // duplicación simple (telephony ok). Si quieres mejor calidad: interpolación lineal.
  const out = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = samples[i];
    out[i * 2 + 1] = samples[i];
  }
  return out;
}

function downsample16to8(samples) {
  const out = new Int16Array(Math.floor(samples.length / 2));
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

function genSilence16k(ms) {
  const n = Math.max(1, Math.floor((16000 * ms) / 1000));
  return new Int16Array(n); // zeros
}

/* 20ms frames at 8kHz μ-law */
const TWILIO_FRAME_BYTES = 160;
const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, 0xff);

/* ─────────────────────────── ElevenLabs client ─────────────────────────── */

class ElevenLabs {
  constructor({ onAudio, onLog }) {
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

    await new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });

    this.ws.on("open", () => this.onLog?.("[11L] WS open"));
    this.ws.on("close", (code, reason) => {
      this.onLog?.(`[11L] WS close code=${code} reason=${reason?.toString?.() || ""}`);
      this.ready = false;
    });
    this.ws.on("error", (err) => this.onLog?.(`[11L] WS error: ${err?.message || err}`));

    this.ws.on("message", (d) => {
      let m;
      try {
        m = JSON.parse(d.toString());
      } catch {
        return;
      }

      if (m.type === "conversation_initiation_metadata") {
        this.ready = true;
        this.onLog?.("[11L] ✅ ready");
        this._readyResolver?.();
      }

      if (m.type === "audio") {
        const b64 = m.audio_event?.audio_base_64 || m.audio?.chunk || m.audio?.audio_base_64;
        if (b64) this.onAudio?.(b64);
      }

      if (m.type === "agent_response") {
        const txt = m.agent_response_event?.agent_response;
        if (txt) this.onLog?.(`[11L] 💬 Agent: ${String(txt).slice(0, 120)}`);
      }

      if (m.type === "user_transcript") {
        const txt = m.user_transcription_event?.user_transcript;
        if (txt) this.onLog?.(`[11L] 👤 User: ${txt}`);
      }

      if (m.type === "ping") {
        try {
          this.ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event?.event_id || m.event_id }));
        } catch {}
      }
    });
  }

  async waitReady(timeoutMs = 6000) {
    if (this.ready) return true;
    let t;
    const timeout = new Promise((res) => (t = setTimeout(() => res(false), timeoutMs)));
    const ok = await Promise.race([this.readyPromise.then(() => true), timeout]);
    clearTimeout(t);
    return ok;
  }

  sendAudio(b64) {
    if (!this.ready) return false;
    try {
      // ✅ include type (más compatible)
      this.ws.send(JSON.stringify({ type: "user_audio_chunk", user_audio_chunk: b64 }));
      return true;
    } catch {
      return false;
    }
  }

  commit() {
    if (!this.ready) return false;
    try {
      // ✅ include type (más compatible)
      this.ws.send(JSON.stringify({ type: "user_audio_commit", user_audio_commit: true }));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

/* ─────────────────────────── Call session ─────────────────────────── */

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.sid8 = streamSid.slice(0, 8);
    this.twilioWs = twilioWs;
    this.closed = false;

    // 11L
    this.eleven = null;

    // Out to Twilio
    this.outBuf = Buffer.alloc(0);
    this.frames = 0;

    // Anti-echo / playback status
    this.agentPlaying = false;
    this.lastAgentAudioAt = 0;

    // VAD tuning (telephony)
    this.ENERGY_THRESHOLD = 0.015; // ajusta si hace falta: 0.010–0.020 típico
    this.INTERRUPT_THRESHOLD = 0.10; // barge-in si gritan/alto
    this.SILENCE_MS_TO_COMMIT = 450; // ↓ para menos latencia
    this.MIN_SPOKE_MS = 220;         // mínimo de habla real antes de commit
    this.ANTI_ECHO_POST_MS = 800;    // colchón tras último audio agente

    // User turn state
    this.userTalking = false;
    this.userSpeechStartAt = 0;
    this.lastVoiceAt = 0;
    this.commitCount = 0;

    // timers
    this.playTimer = null;
    this.commitTimer = null;

    console.log(`[Session ${streamSid}] Created`);
  }

  log(msg) {
    console.log(`[${this.sid8}] ${msg}`);
  }

  async start() {
    this.eleven = new ElevenLabs({
      onAudio: (b64) => this.fromEleven(b64),
      onLog: (msg) => this.log(msg),
    });

    await this.eleven.connect();
    if (this.closed) return;

    const ok = await this.eleven.waitReady(6000);
    if (!ok) {
      this.log("[11L] ⚠️ not ready (timeout) - continuing anyway");
    }

    // Start player & commit loop
    this.startPlayer();
    this.startCommitLoop();

    // Trigger greeting (silence chunk + commit)
    // Si tu agente ya habla solo, esto no molesta.
    setTimeout(() => {
      if (this.closed || !this.eleven?.ready) return;
      const s = genSilence16k(100);
      this.eleven.sendAudio(pcm16ToBase64(s));
      this.eleven.commit();
      this.log("[11L] 🚀 greeting trigger sent");
    }, 250);

    this.log("ElevenLabs connected");
  }

  startPlayer() {
    if (this.playTimer) return;

    this.playTimer = setInterval(() => {
      if (this.closed) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      // ✅ si queda “resto” < 1 frame y hace rato que no llega audio del agente, limpia cola fantasma
      if (this.outBuf.length > 0 && this.outBuf.length < TWILIO_FRAME_BYTES && (now - this.lastAgentAudioAt) > 300) {
        this.outBuf = Buffer.alloc(0);
      }

      if (this.outBuf.length < TWILIO_FRAME_BYTES) {
        // opcional: mandar silencio para evitar glitches (Twilio lo tolera)
        // pero NO actualizamos agentPlaying por esto.
        try {
          this.twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid: this.streamSid,
              media: { payload: MULAW_SILENCE_FRAME.toString("base64") },
            })
          );
          this.frames++;
          if (this.frames % 200 === 0) this.log(`[Twilio] ▶️ f=${this.frames} q=${this.outBuf.length}`);
        } catch {}
      } else {
        const frame = this.outBuf.subarray(0, TWILIO_FRAME_BYTES);
        this.outBuf = this.outBuf.subarray(TWILIO_FRAME_BYTES);

        try {
          this.twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid: this.streamSid,
              media: { payload: frame.toString("base64") },
            })
          );
        } catch {}

        this.frames++;
        if (this.frames % 50 === 0) this.log(`[Twilio] ▶️ f=${this.frames} q=${this.outBuf.length}`);
      }

      // ✅ agente “sonando” mientras haya cola o acabe de llegar audio
      this.agentPlaying = (this.outBuf.length > 0) || (now - this.lastAgentAudioAt < 400);
    }, 20);
  }

  startCommitLoop() {
    if (this.commitTimer) return;

    this.commitTimer = setInterval(() => {
      if (this.closed) return;
      this.maybeCommit();
    }, 50); // más frecuente => menos latencia
  }

  maybeCommit() {
    if (!this.userTalking) return;
    if (!this.eleven?.ready) return;

    const now = Date.now();
    const silenceMs = now - this.lastVoiceAt;
    const spokeMs = now - this.userSpeechStartAt;

    if (spokeMs < this.MIN_SPOKE_MS) return;

    if (silenceMs >= this.SILENCE_MS_TO_COMMIT) {
      this.userTalking = false;
      this.commitCount++;

      this.log(`⚡ Commit (silence=${Math.round(silenceMs)}ms spoke=${Math.round(spokeMs)}ms)`);
      this.eleven.commit();
      this.log(`[11L] 📤 Commit #${this.commitCount}`);
    }
  }

  fromTwilio(b64) {
    if (this.closed || !this.eleven?.ready) return;

    let pcm8;
    try {
      pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
    } catch {
      return;
    }

    const e = rmsEnergy(pcm8);
    const now = Date.now();

    // ✅ Anti-echo robusto:
    //  - si todavía hay audio por reproducir (outBuf > 0), NO escuches al usuario
    //  - o si acaba de sonar el agente (colchón)
    const inAntiEcho = (this.outBuf.length > 0) || (now - this.lastAgentAudioAt < this.ANTI_ECHO_POST_MS);

    // Barge-in opcional: si el usuario habla MUY fuerte, dejamos pasar 1 chunk aunque haya anti-echo
    const allowInterrupt = e >= this.INTERRUPT_THRESHOLD;

    if (inAntiEcho && !allowInterrupt) return;

    // VAD local para commit
    if (e > this.ENERGY_THRESHOLD) {
      this.lastVoiceAt = now;
      if (!this.userTalking) {
        this.userTalking = true;
        this.userSpeechStartAt = now;
        this.log(`🎤 User started speaking (energy=${e.toFixed(3)})`);
      }
    }

    // ✅ SIEMPRE enviar audio a 11L (cuando no estamos en anti-echo)
    const pcm16 = upsample8to16(pcm8);
    const sent = this.eleven.sendAudio(pcm16ToBase64(pcm16));
    if (!sent) return;
  }

  fromEleven(b64pcm16) {
    if (this.closed) return;

    try {
      const pcm16 = base64ToPcm16(b64pcm16);
      const pcm8 = downsample16to8(pcm16);
      const mulaw = encodeMulaw(pcm8);

      this.lastAgentAudioAt = Date.now();
      // ✅ añade al buffer
      this.outBuf = Buffer.concat([this.outBuf, mulaw]);
    } catch (err) {
      this.log(`[11L] audio decode error: ${err?.message || err}`);
    }
  }

  close(reason = "unknown") {
    if (this.closed) return;
    this.closed = true;

    this.log(`Closing reason=${reason}`);

    if (this.playTimer) clearInterval(this.playTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);

    try {
      this.eleven?.close();
    } catch {}
  }
}

/* ─────────────────────────── HTTP + WS server ─────────────────────────── */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  if (req.url === "/twiml") {
    // OJO: en Railway/Render suele venir con proxy. Esto genera el host que ve Twilio.
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").includes("https") ? "wss" : "ws";

    const wsUrl = `${proto}://${host}/twilio-stream`;

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
  res.end("not found");
});

const wss = new WebSocket.Server({ server });
const sessions = new Map();

wss.on("connection", (ws, req) => {
  console.log(`[Server] New WebSocket connection from ${req.url}`);

  let session = null;

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        console.log("[Twilio] Connected");
        break;

      case "start": {
        const streamSid = msg.start?.streamSid;
        const callSid = msg.start?.callSid;
        console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);

        session = new CallSession(streamSid, ws);
        sessions.set(streamSid, session);
        await session.start();
        break;
      }

      case "media":
        if (session) session.fromTwilio(msg.media?.payload);
        break;

      case "stop":
        console.log("[Twilio] 📞 stop");
        if (session) {
          session.close("twilio_stop");
          sessions.delete(session.streamSid);
          session = null;
        }
        break;

      default:
        // console.log(`[Twilio] event=${msg.event}`);
        break;
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

  ws.on("error", (err) => {
    console.log(`[Twilio] WS error: ${err?.message || err}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}
   TwiML:  https://your-domain/twiml
   Health: https://your-domain/health`);
});

process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM - shutting down");
  sessions.forEach((s) => s.close("sigterm"));
  try {
    wss.close();
    server.close();
  } catch {}
});
