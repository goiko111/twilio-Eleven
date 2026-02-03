/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge (robust + low-latency)
 * Node 18+
 *
 * ENV:
 *  - ELEVENLABS_API_KEY
 *  - ELEVENLABS_AGENT_ID
 *  - PORT (optional)
 */

const http = require("http");
const WebSocket = require("ws");


// ─────────────────────────────────────────────────────────────────────────────
// Audio constants
// ─────────────────────────────────────────────────────────────────────────────
const TWILIO_SR = 8000;
const ELEVEN_SR = 16000;

// Twilio media stream is 8kHz μ-law, 20ms frames → 160 bytes.
const TWILIO_FRAME_BYTES = 160;

// μ-law “silence” byte is typically 0xFF. We'll send silence frames only when needed.
const MULAW_SILENCE_BYTE = 0xff;
const MULAW_SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_BYTES, MULAW_SILENCE_BYTE);

// ─────────────────────────────────────────────────────────────────────────────
// VAD / Turn tuning (telephony)
// ─────────────────────────────────────────────────────────────────────────────
const VAD = {
  ENERGY_THRESHOLD: 0.012,       // start voice
  START_SPEECH_FRAMES: 3,        // 60ms above threshold to confirm speech
  MAX_SILENCE_TO_SEND_MS: 220,   // keep streaming a bit after speech ends
  SILENCE_TO_COMMIT_MS: 450,     // commit after ~450ms silence (low latency)
  MIN_SPOKE_MS: 250,             // avoid committing tiny blips
  MIN_CHUNKS: 8,                 // ensure we sent enough audio before commit
};

// Anti-echo: block user audio while agent audio is in queue or just played.
const ANTI_ECHO = {
  HOLD_MS_AFTER_AGENT_AUDIO: 800,   // short hold after last agent audio
  GHOST_QUEUE_CLEAR_MS: 300,        // if <1 frame stuck for >300ms → clear
  AGENT_RECENT_MS: 400,             // consider agent "playing" if audio seen recently
};

// ─────────────────────────────────────────────────────────────────────────────
// μ-law decode/encode (G.711)
// ─────────────────────────────────────────────────────────────────────────────
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
  let mulawByte = ~(sign | (exponent << 4) | mantissa);

  return mulawByte & 0xff;
}

function decodeMulaw(mulawBuf) {
  const pcm = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) pcm[i] = MULAW_DECODE_TABLE[mulawBuf[i]];
  return pcm;
}

function encodeMulaw(pcm) {
  const mulaw = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) mulaw[i] = linearToMulaw(pcm[i]);
  return mulaw;
}

function upsample8to16(pcm8) {
  const pcm16 = new Int16Array(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) {
    const curr = pcm8[i];
    const next = pcm8[Math.min(i + 1, pcm8.length - 1)];
    pcm16[i * 2] = curr;
    pcm16[i * 2 + 1] = (curr + next) >> 1;
  }
  return pcm16;
}

function downsample16to8(pcm16) {
  const pcm8 = new Int16Array(Math.floor(pcm16.length / 2));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = pcm16[i * 2];
  return pcm8;
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

function rmsEnergy(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const n = pcm[i] / 32768;
    sum += n * n;
  }
  return Math.sqrt(sum / pcm.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs client
// ─────────────────────────────────────────────────────────────────────────────
class ElevenLabs {
  constructor({ apiKey, agentId, onAudio, onUserTranscript, onAgentText, logPrefix }) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.onAudio = onAudio;
    this.onUserTranscript = onUserTranscript;
    this.onAgentText = onAgentText;
    this.logPrefix = logPrefix || "[11L]";

    this.ws = null;
    this.ready = false;
    this.closed = false;

    this._readyResolvers = [];
  }

  async connect() {
    const url = await this._getSignedUrl();
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log(`${this.logPrefix} WS open`);
      });

      this.ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        this._handle(msg);

        if (msg.type === "conversation_initiation_metadata" && !this.ready) {
          this.ready = true;
          console.log(`${this.logPrefix} ✅ ready`);
          this._readyResolvers.forEach((r) => r(true));
          this._readyResolvers = [];
          resolve();
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(`${this.logPrefix} WS close code=${code} reason=${reason?.toString?.() || ""}`);
        this.ready = false;
        this.closed = true;
        this._readyResolvers.forEach((r) => r(false));
        this._readyResolvers = [];
      });

      this.ws.on("error", (err) => {
        console.log(`${this.logPrefix} WS error: ${err?.message || err}`);
        reject(err);
      });
    });
  }

  async _getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.agentId}`,
      { headers: { "xi-api-key": this.apiKey } }
    );
    if (!res.ok) throw new Error(`ElevenLabs signed-url failed: ${await res.text()}`);
    const j = await res.json();
    if (!j?.signed_url) throw new Error("ElevenLabs: signed_url missing");
    return j.signed_url;
  }

  waitReady(ms = 6000) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this._readyResolvers.push((ok) => { clearTimeout(t); resolve(ok); });
    });
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  // ✅ IMPORTANT: include type
  sendAudio(base64Pcm16_16k) {
    if (!this.ready || this.closed) return false;
    return this._send({ type: "user_audio_chunk", user_audio_chunk: base64Pcm16_16k });
  }

  commit() {
    if (!this.ready || this.closed) return false;
    return this._send({ type: "user_audio_commit" });
  }

  // Optional: start conversation with a commit (some agents speak on connect)
  triggerGreeting() {
    // minimal: commit an empty turn
    return this.commit();
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }

  _handle(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "ping") {
      const eventId = msg.ping_event?.event_id || msg.event_id;
      if (eventId) this._send({ type: "pong", event_id: eventId });
      return;
    }

    if (msg.type === "audio") {
      const chunk =
        msg.audio?.chunk ||
        msg.audio_event?.audio_base_64 ||
        msg.audio_event?.chunk ||
        msg.audio?.audio_base_64;

      if (chunk) this.onAudio?.(chunk);
      return;
    }

    if (msg.type === "user_transcript") {
      const t = msg.user_transcription_event?.user_transcript;
      if (t) this.onUserTranscript?.(t);
      return;
    }

    if (msg.type === "agent_response") {
      const t = msg.agent_response_event?.agent_response;
      if (t) this.onAgentText?.(t);
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Call session
// ─────────────────────────────────────────────────────────────────────────────
class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;

    this.closed = false;

    // Twilio outbound buffer (mulaw)
    this.outBuf = Buffer.alloc(0);
    this.frames = 0;

    // Agent state
    this.agentPlaying = false;
    this.lastAgentAudioAt = 0;

    // User state
    this.userTalking = false;
    this.userSpeechStartAt = null;
    this.lastVoiceAt = 0;
    this.speechFrames = 0;
    this.sentChunks = 0;
    this.commitCount = 0;

    // timers
    this.playTimer = null;
    this.commitTimer = null;

    this.eleven = null;

    console.log(`[Session ${this.streamSid}] Created`);
  }

  async start() {
    this.eleven = new ElevenLabs({
      apiKey: ELEVENLABS_API_KEY,
      agentId: ELEVENLABS_AGENT_ID,
      logPrefix: `[Session ${this.streamSid.slice(0, 8)}] [11L]`,
      onAudio: (b64) => this.fromEleven(b64),
      onUserTranscript: (t) => console.log(`[Session ${this.streamSid.slice(0, 8)}] [11L] 👤 User: ${t}`),
      onAgentText: (t) => console.log(`[Session ${this.streamSid.slice(0, 8)}] [11L] 💬 Agent: ${t.slice(0, 90)}`),
    });

    await this.eleven.connect();
    const ok = await this.eleven.waitReady(6000);
    if (!ok) console.log(`[Session ${this.streamSid}] ⚠️ ElevenLabs not ready in time`);
    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

    this.startPlayer();
    this.startCommitLoop();

    // Kick greeting
    this.eleven.triggerGreeting();
  }

  startPlayer() {
    if (this.playTimer) return;

    this.playTimer = setInterval(() => {
      if (this.closed) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      // ✅ clear “ghost queue” (<1 frame stuck, no agent audio for a bit)
      if (
        this.outBuf.length > 0 &&
        this.outBuf.length < TWILIO_FRAME_BYTES &&
        (now - this.lastAgentAudioAt) > ANTI_ECHO.GHOST_QUEUE_CLEAR_MS
      ) {
        this.outBuf = Buffer.alloc(0);
      }

      let frame;
      if (this.outBuf.length >= TWILIO_FRAME_BYTES) {
        frame = this.outBuf.subarray(0, TWILIO_FRAME_BYTES);
        this.outBuf = this.outBuf.subarray(TWILIO_FRAME_BYTES);
      } else {
        // send silence to keep stream stable
        frame = MULAW_SILENCE_FRAME;
      }

      try {
        this.twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: frame.toString("base64") }
        }));
      } catch (e) {
        this.close("twilio_send_error");
        return;
      }

      this.frames++;
      if (this.frames % 50 === 0) {
        console.log(`[Twilio ${this.streamSid.slice(0, 8)}] ▶️ f=${this.frames} q=${this.outBuf.length}`);
      }

      // ✅ agent "playing" while queue has audio OR recently received agent audio
      this.agentPlaying =
        (this.outBuf.length > 0) ||
        (now - this.lastAgentAudioAt < ANTI_ECHO.AGENT_RECENT_MS);

    }, 20);
  }

  startCommitLoop() {
    if (this.commitTimer) return;
    this.commitTimer = setInterval(() => this.maybeCommit(), 40);
  }

  fromTwilio(b64) {
    if (this.closed || !this.eleven) return;

    try {
      const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
      const e = rmsEnergy(pcm8);
      const now = Date.now();

      // ✅ Robust anti-echo:
      const inAntiEcho =
        (this.outBuf.length > 0) ||
        (now - this.lastAgentAudioAt < ANTI_ECHO.HOLD_MS_AFTER_AGENT_AUDIO);

      if (inAntiEcho) return;

      // VAD: detect speech start
      if (e > VAD.ENERGY_THRESHOLD) {
        this.speechFrames++;
        this.lastVoiceAt = now;

        if (!this.userTalking && this.speechFrames >= VAD.START_SPEECH_FRAMES) {
          this.userTalking = true;
          this.userSpeechStartAt = now;
          this.sentChunks = 0;
          console.log(`[Session ${this.streamSid.slice(0, 8)}] 🎤 User started speaking (energy=${e.toFixed(3)})`);
        }
      } else {
        // decay speechFrames fast
        this.speechFrames = Math.max(0, this.speechFrames - 1);
      }

      // Stream policy:
      // - If userTalking, stream every frame (including short trailing silence),
      //   but stop streaming if silence has lasted too long.
      if (this.userTalking) {
        const silentFor = now - this.lastVoiceAt;

        if (silentFor <= VAD.MAX_SILENCE_TO_SEND_MS) {
          const pcm16 = upsample8to16(pcm8);
          const ok = this.eleven.sendAudio(pcm16ToBase64(pcm16));
          if (ok) this.sentChunks++;
        }
      }

    } catch (err) {
      console.log(`[Session ${this.streamSid.slice(0, 8)}] fromTwilio error: ${err?.message || err}`);
      this.close("from_twilio_error");
    }
  }

  maybeCommit() {
    if (this.closed) return;
    if (!this.userTalking) return;

    const now = Date.now();
    const silentFor = now - this.lastVoiceAt;
    const spokeFor = this.userSpeechStartAt ? (now - this.userSpeechStartAt) : 0;

    if (silentFor >= VAD.SILENCE_TO_COMMIT_MS && spokeFor >= VAD.MIN_SPOKE_MS) {
      // prevent empty commits
      if (this.sentChunks < VAD.MIN_CHUNKS) {
        // if too few chunks, just reset and wait for next turn
        this.userTalking = false;
        this.userSpeechStartAt = null;
        this.speechFrames = 0;
        return;
      }

      this.commitCount++;
      console.log(`[Session ${this.streamSid.slice(0, 8)}] ⚡ Commit (silence=${silentFor}ms spoke=${spokeFor}ms)`);
      console.log(`[Session ${this.streamSid.slice(0, 8)}] [11L] 📤 Commit #${this.commitCount} (${this.sentChunks} chunks)`);

      this.userTalking = false;
      this.userSpeechStartAt = null;
      this.speechFrames = 0;

      this.eleven?.commit();
    }
  }

  fromEleven(b64Pcm16_16k) {
    if (this.closed) return;

    try {
      this.lastAgentAudioAt = Date.now();

      const pcm16 = base64ToPcm16(b64Pcm16_16k);
      const pcm8 = downsample16to8(pcm16);
      const mulaw = encodeMulaw(pcm8);

      this.outBuf = Buffer.concat([this.outBuf, mulaw]);

    } catch (err) {
      console.log(`[Session ${this.streamSid.slice(0, 8)}] fromEleven error: ${err?.message || err}`);
      this.close("from_eleven_error");
    }
  }

  close(reason = "unknown") {
    if (this.closed) return;
    this.closed = true;

    console.log(`[Session ${this.streamSid}] Closing reason=${reason}`);
    try { clearInterval(this.playTimer); } catch {}
    try { clearInterval(this.commitTimer); } catch {}
    try { this.eleven?.close(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (/health, /twiml) + WS (/twilio-stream)
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  if (req.url === "/twiml") {
    // ✅ Use x-forwarded-host for Railway/Render, fallback to host
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = "wss"; // Twilio Media Streams requires wss in production
    const wsUrl = `${proto}://${host}/twilio-stream`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="bridge" value="true"/>
    </Stream>
  </Connect>
</Response>`);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
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

    if (m.event === "connected") {
      console.log("[Twilio] Connected");
      return;
    }

    if (m.event === "start") {
      const { streamSid, callSid } = m.start || {};
      console.log(`[Twilio] 📞 start streamSid=${streamSid} callSid=${callSid}`);

      session = new CallSession(streamSid, ws);
      try {
        await session.start();
      } catch (e) {
        console.log(`[Twilio] Session start error: ${e?.message || e}`);
        session?.close("session_start_error");
        session = null;
      }
      return;
    }

    if (m.event === "media") {
      session?.fromTwilio(m.media?.payload);
      return;
    }

    if (m.event === "stop") {
      console.log("[Twilio] 📞 stop");
      session?.close("twilio_stop");
      session = null;
      return;
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   TwiML:  https://your-domain/twiml`);
  console.log(`   Health: https://your-domain/health`);
});
