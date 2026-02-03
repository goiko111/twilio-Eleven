/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge v3.1 (COPY/PASTE)
 *
 * Fixes:
 * - ✅ Twilio playback in 20ms frames (160 bytes mulaw @8k) via queue
 * - ✅ ElevenLabs user turn commit uses { type: "user_audio_commit" } (THIS WAS THE BUG)
 * - ✅ ElevenLabs audio chunks sent as { user_audio_chunk: base64PCM16_16k } (no type wrapper)
 * - ✅ Agent turn-end waits for Twilio queue to drain (prevents “hablo y no me oye”)
 *
 * ENV:
 * - ELEVENLABS_API_KEY
 * - ELEVENLABS_AGENT_ID
 * - PORT (optional)
 */

const WebSocket = require("ws");
const http = require("http");

// ============================================================================
// CONFIG
// ============================================================================

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

// Noise floor telephony ~0.0002, speech often 0.05–0.20
const VAD_CONFIG = {
  silenceThresholdMs: 800,
  energyThreshold: 0.02,
  frameSize: 160, // 20ms @ 8kHz
  minSpeechFrames: 4,
  maxSilenceBeforeGate: 500,
  interruptionThreshold: 0.08,
  minAudioChunksForCommit: 20,
};

const LOG_ENERGY_EVERY_N_FRAMES = 50; // ~1s

// IMPORTANT: don't end agent too early; also wait for Twilio queue drain
const AGENT_AUDIO_TIMEOUT_MS = 1500;

const TWILIO_SAMPLE_RATE = 8000;
const ELEVENLABS_SAMPLE_RATE = 16000;

const TWILIO_FRAME_BYTES = 160; // 20ms of mulaw @ 8k => 160 bytes

const OUTBOUND_GREETING_DELAY_MS = 800;
const GREETING_TIMEOUT_MS = 2500;

// ============================================================================
// AUDIO UTILS (mulaw <-> pcm16) + resample
// ============================================================================

const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i;
    let sign = mulaw & 0x80 ? -1 : 1;
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

function decodeMulaw(mulawBuffer) {
  const pcm = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) pcm[i] = MULAW_DECODE_TABLE[mulawBuffer[i]];
  return pcm;
}

function encodeMulaw(pcmSamples) {
  const mulaw = Buffer.alloc(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) mulaw[i] = linearToMulaw(pcmSamples[i]);
  return mulaw;
}

function upsample8to16(samples8k) {
  const samples16k = new Int16Array(samples8k.length * 2);
  for (let i = 0; i < samples8k.length; i++) {
    const curr = samples8k[i];
    const next = samples8k[Math.min(i + 1, samples8k.length - 1)];
    samples16k[i * 2] = curr;
    samples16k[i * 2 + 1] = Math.round((curr + next) / 2);
  }
  return samples16k;
}

function downsample16to8(samples16k) {
  const samples8k = new Int16Array(Math.floor(samples16k.length / 2));
  for (let i = 0; i < samples8k.length; i++) samples8k[i] = samples16k[i * 2];
  return samples8k;
}

function pcm16ToBase64(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], i * 2);
  return buffer.toString("base64");
}

function base64ToPcm16(base64) {
  const buffer = Buffer.from(base64, "base64");
  const samples = new Int16Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2);
  return samples;
}

function generateSilence16k(durationMs) {
  const numSamples = Math.floor((durationMs / 1000) * ELEVENLABS_SAMPLE_RATE);
  return new Int16Array(numSamples);
}

// ============================================================================
// VAD
// ============================================================================

class SimpleVAD {
  constructor(config = VAD_CONFIG) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.silentFrames = 0;
    this.speechFrames = 0;
    this.isSpeaking = false;
    this.turnCommitted = false;
    this.audioGated = false;
    this.audioChunksSent = 0;
    this.frameCount = 0;
    this.maxEnergy = 0;
    this.recentEnergies = [];
  }

  calculateEnergy(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768;
      sum += normalized * normalized;
    }
    return Math.sqrt(sum / samples.length);
  }

  processFrame(samples, sessionId = "") {
    this.frameCount++;

    if (this.turnCommitted) {
      return { isSpeech: false, turnEnded: false, shouldSendAudio: false, silenceMs: 999 };
    }

    const energy = this.calculateEnergy(samples);

    this.recentEnergies.push(energy);
    if (this.recentEnergies.length > 10) this.recentEnergies.shift();
    if (energy > this.maxEnergy) this.maxEnergy = energy;

    if (this.frameCount % LOG_ENERGY_EVERY_N_FRAMES === 0) {
      const avgEnergy = this.recentEnergies.reduce((a, b) => a + b, 0) / this.recentEnergies.length;
      console.log(
        `[VAD ${sessionId}] 📊 Energy: current=${energy.toFixed(4)}, avg=${avgEnergy.toFixed(
          4
        )}, max=${this.maxEnergy.toFixed(4)}, threshold=${this.config.energyThreshold}, speaking=${this.isSpeaking}`
      );
    }

    const isSpeech = energy > this.config.energyThreshold;

    if (isSpeech) {
      this.speechFrames++;
      this.silentFrames = 0;
      this.audioGated = false;

      if (this.speechFrames >= this.config.minSpeechFrames) {
        if (!this.isSpeaking) console.log(`[VAD ${sessionId}] 🎤 Speech started (energy: ${energy.toFixed(4)})`);
        this.isSpeaking = true;
      }
      return { isSpeech: true, turnEnded: false, shouldSendAudio: true, silenceMs: 0 };
    }

    this.silentFrames++;
    const silenceMs = (this.silentFrames * this.config.frameSize / TWILIO_SAMPLE_RATE) * 1000;

    if (!this.isSpeaking) return { isSpeech: false, turnEnded: false, shouldSendAudio: false, silenceMs: 0 };

    if (silenceMs >= this.config.maxSilenceBeforeGate) this.audioGated = true;

    if (silenceMs >= this.config.silenceThresholdMs) {
      this.turnCommitted = true;
      return { isSpeech: false, turnEnded: true, shouldSendAudio: false, silenceMs };
    }

    return { isSpeech: false, turnEnded: false, shouldSendAudio: !this.audioGated, silenceMs };
  }

  resetForNewTurn() {
    this.silentFrames = 0;
    this.speechFrames = 0;
    this.isSpeaking = false;
    this.turnCommitted = false;
    this.audioGated = false;
    this.audioChunksSent = 0;
    this.frameCount = 0;
    this.maxEnergy = 0;
    this.recentEnergies = [];
  }

  incrementAudioChunks() {
    this.audioChunksSent++;
  }

  hasEnoughAudioForCommit() {
    return this.audioChunksSent >= this.config.minAudioChunksForCommit;
  }
}

// ============================================================================
// ELEVENLABS CLIENT
// ============================================================================

class ElevenLabsClient {
  constructor(apiKey, agentId, onAudio, onError, onAgentStateChange) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.onAudio = onAudio;
    this.onError = onError;
    this.onAgentStateChange = onAgentStateChange;

    this.ws = null;
    this.isConnected = false;
    this.isSessionReady = false;

    this.isAgentSpeaking = false;
    this.hasReceivedAudio = false;

    this.turnCommitTime = null;
    this.greetingTriggered = false;

    this.agentAudioTimeout = null;
    this.pendingTurnEnd = false;
  }

  async connect() {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.agentId}`,
          { headers: { "xi-api-key": this.apiKey } }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to get signed URL: ${error}`);
        }

        const { signed_url } = await response.json();
        console.log("[ElevenLabs] Got signed URL, connecting...");

        this.ws = new WebSocket(signed_url);

        this.ws.on("open", () => {
          console.log("[ElevenLabs] WebSocket connected");
          this.isConnected = true;
        });

        this.ws.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);

            if (message.type === "conversation_initiation_metadata" && !this.isSessionReady) {
              this.isSessionReady = true;
              console.log("[ElevenLabs] ✅ Session ready");
              resolve();
            }
          } catch (e) {
            console.error("[ElevenLabs] Failed to parse message:", e);
          }
        });

        this.ws.on("close", (code, reason) => {
          console.log(`[ElevenLabs] WebSocket closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.isSessionReady = false;
          this.hasReceivedAudio = false;
          this.isAgentSpeaking = false;
        });

        this.ws.on("error", (error) => {
          console.error("[ElevenLabs] WebSocket error:", error.message);
          this.onError?.(error);
          reject(error);
        });

        setTimeout(() => {
          if (!this.isSessionReady) {
            console.log("[ElevenLabs] Connection timeout");
            resolve();
          }
        }, 5000);
      } catch (error) {
        console.error("[ElevenLabs] Connection error:", error);
        reject(error);
      }
    });
  }

  handleMessage(message) {
    if (message.type !== "ping") {
      console.log(`[ElevenLabs] 📨 Event type: ${message.type}`, JSON.stringify(message).substring(0, 200));
    }

    switch (message.type) {
      case "audio": {
        const audioChunk =
          message.audio?.chunk ||
          message.audio_event?.audio_base_64 ||
          message.audio_event?.chunk ||
          message.audio?.audio_base_64;

        if (!audioChunk) return;

        if (!this.hasReceivedAudio) {
          this.hasReceivedAudio = true;
          const latency = this.turnCommitTime ? Date.now() - this.turnCommitTime : 0;
          console.log(`[ElevenLabs] 🔊 First audio chunk received (latency: ${latency}ms, size: ${audioChunk.length})`);
        }

        if (!this.isAgentSpeaking) {
          this.isAgentSpeaking = true;
          this.pendingTurnEnd = false;
          console.log("[ElevenLabs] 🎙️ Agent started speaking");
          this.onAgentStateChange?.(true, false);
        }

        this.resetAgentAudioTimeout();
        this.onAudio(audioChunk);
        break;
      }

      case "agent_response":
        console.log("[ElevenLabs] 💬 Agent text:", message.agent_response_event?.agent_response?.substring(0, 80));
        break;

      case "user_transcript":
        console.log("[ElevenLabs] 👤 User said:", message.user_transcription_event?.user_transcript);
        break;

      case "turn_end":
        // Some agents emit explicit end events
        console.log("[ElevenLabs] Agent turn ended (event)");
        this.isAgentSpeaking = false;
        this.hasReceivedAudio = false;
        this.pendingTurnEnd = false;
        this.onAgentStateChange?.(false, false);
        break;

      case "ping": {
        const pingEventId = message.ping_event?.event_id || message.event_id;
        if (pingEventId && this.ws?.readyState === WebSocket.OPEN) {
          const payload = JSON.stringify({ type: "pong", event_id: pingEventId });
          this.ws.send(payload);
        }
        break;
      }

      case "conversation_initiation_metadata":
        console.log(
          "[ElevenLabs] Session initialized, config:",
          JSON.stringify(message.conversation_initiation_metadata_event || {}).substring(0, 200)
        );
        break;

      default:
        break;
    }
  }

  // Send raw objects
  send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(obj);

    // Avoid noisy logs for audio chunks
    if (!obj.user_audio_chunk && obj.type !== "pong") {
      console.log(`[ElevenLabs] 📤 Sending: ${payload.substring(0, 150)}`);
    }
    this.ws.send(payload);
  }

  // OUTBOUND greeting: send 100ms silence chunk then commit using type
  triggerGreeting() {
    if (this.greetingTriggered || !this.isSessionReady) return;

    this.greetingTriggered = true;
    console.log("[ElevenLabs] 🚀 Triggering agent greeting...");

    const silence = generateSilence16k(100);
    const base64Silence = pcm16ToBase64(silence);

    // chunk: no type wrapper
    this.send({ user_audio_chunk: base64Silence });

    this.turnCommitTime = Date.now();

    // ✅ commit MUST be with type (this was your bug)
    this.send({ type: "user_audio_commit" });

    console.log("[ElevenLabs] ✅ Greeting trigger sent");
  }

  // User audio chunks: no type wrapper
  sendAudio(base64Pcm16_16k) {
    if (!this.isConnected || !this.isSessionReady) return false;
    this.send({ user_audio_chunk: base64Pcm16_16k });
    return true;
  }

  // ✅ commit MUST be with type
  endTurn() {
    if (!this.isConnected || !this.isSessionReady) return;
    this.turnCommitTime = Date.now();
    console.log("[ElevenLabs] ⚡ User turn commit");
    this.send({ type: "user_audio_commit" });
  }

  resetAgentAudioTimeout() {
    if (this.agentAudioTimeout) clearTimeout(this.agentAudioTimeout);

    this.agentAudioTimeout = setTimeout(() => {
      if (this.isAgentSpeaking) {
        // Mark pending; CallSession will confirm when Twilio queue drains
        this.pendingTurnEnd = true;
        console.log("[ElevenLabs] ⏱️ Agent audio timeout - pending turn end (wait queue drain)");
        this.onAgentStateChange?.(false, true);
      }
    }, AGENT_AUDIO_TIMEOUT_MS);
  }

  confirmTurnEnded() {
    if (!this.pendingTurnEnd) return;
    console.log("[ElevenLabs] ✅ Turn end confirmed (queue drained)");
    this.isAgentSpeaking = false;
    this.hasReceivedAudio = false;
    this.pendingTurnEnd = false;
  }

  close() {
    if (this.agentAudioTimeout) clearTimeout(this.agentAudioTimeout);
    this.ws?.close();
  }
}

// ============================================================================
// CALL SESSION
// ============================================================================

class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;

    this.elevenLabs = null;
    this.vad = new SimpleVAD();

    this.isActive = true;

    this.agentSpeaking = false;
    this.waitingForGreeting = true;

    this.audioSentCount = 0;

    // Twilio playback queue
    this.outQueue = Buffer.alloc(0);
    this.playInterval = null;
    this.framesSent = 0;

    this.greetingTimeout = null;
    this.greetingFallbackTimeout = null;

    console.log(`[Session ${streamSid}] Created`);
  }

  async start() {
    try {
      this.elevenLabs = new ElevenLabsClient(
        ELEVENLABS_API_KEY,
        ELEVENLABS_AGENT_ID,
        (audioBase64) => this.handleElevenLabsAudio(audioBase64),
        (error) => this.handleElevenLabsError(error),
        (isSpeaking, isPending) => this.handleAgentStateChange(isSpeaking, isPending)
      );

      await this.elevenLabs.connect();
      console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

      this.startTwilioPlayer();

      // Trigger greeting after delay (only inside session)
      this.greetingTimeout = setTimeout(() => {
        if (this.isActive && this.elevenLabs?.isSessionReady) this.elevenLabs.triggerGreeting();
      }, OUTBOUND_GREETING_DELAY_MS);

      // Fallback: if greeting never arrives, allow user audio
      this.greetingFallbackTimeout = setTimeout(() => {
        if (this.waitingForGreeting) {
          console.log(`[Session ${this.streamSid}] ⚠️ Greeting timeout, enabling user audio anyway`);
          this.waitingForGreeting = false;
        }
      }, GREETING_TIMEOUT_MS);
    } catch (err) {
      console.error(`[Session ${this.streamSid}] Failed to start:`, err);
      this.close();
    }
  }

  startTwilioPlayer() {
    if (this.playInterval) return;

    this.playInterval = setInterval(() => {
      if (!this.isActive) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;
      if (this.outQueue.length < TWILIO_FRAME_BYTES) return;

      const frame = this.outQueue.subarray(0, TWILIO_FRAME_BYTES);
      this.outQueue = this.outQueue.subarray(TWILIO_FRAME_BYTES);

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
          `[Twilio ${this.streamSid.substring(0, 8)}] ▶️ Playing... frames=${this.framesSent}, queue=${this.outQueue.length} bytes`
        );
      }
    }, 20);

    console.log(`[Session ${this.streamSid}] Twilio player started`);
  }

  enqueueToTwilio(mulawBuffer) {
    this.outQueue = Buffer.concat([this.outQueue, mulawBuffer]);
  }

  handleAgentStateChange(isSpeaking, isPending = false) {
    if (isSpeaking) {
      this.agentSpeaking = true;
      this.waitingForGreeting = false;
      console.log(`[Session ${this.streamSid}] Agent speaking - muting user audio processing`);
      return;
    }

    if (isPending) {
      // Agent stopped sending audio but Twilio may still be playing queued frames
      this.startQueueDrainCheck();
      return;
    }

    // Explicit end
    this.agentSpeaking = false;
    console.log(`[Session ${this.streamSid}] Agent finished - ready for user input`);
    this.vad.resetForNewTurn();
  }

  startQueueDrainCheck() {
    const interval = setInterval(() => {
      if (!this.isActive) {
        clearInterval(interval);
        return;
      }
      // queue drained (<= 40ms)
      if (this.outQueue.length < TWILIO_FRAME_BYTES * 2) {
        clearInterval(interval);
        this.agentSpeaking = false;
        this.elevenLabs?.confirmTurnEnded();
        console.log(`[Session ${this.streamSid}] Agent finished (queue drained) - ready for user input`);
        this.vad.resetForNewTurn();
      }
    }, 100);

    // safety
    setTimeout(() => clearInterval(interval), 5000);
  }

  processIncomingAudio(base64Mulaw) {
    if (!this.isActive || !this.elevenLabs?.isConnected || !this.elevenLabs?.isSessionReady) return;

    try {
      const mulawBuffer = Buffer.from(base64Mulaw, "base64");
      const pcm8k = decodeMulaw(mulawBuffer);

      if (this.waitingForGreeting) return;

      const energy = this.vad.calculateEnergy(pcm8k);

      // While agent speaking: allow interruption only if loud/clear
      if (this.agentSpeaking) {
        if (energy > VAD_CONFIG.interruptionThreshold) {
          console.log(`[Session ${this.streamSid}] 🛑 User interruption (energy: ${energy.toFixed(3)})`);
          const pcm16k = upsample8to16(pcm8k);
          const base64Pcm = pcm16ToBase64(pcm16k);
          this.elevenLabs.sendAudio(base64Pcm);
        }
        return;
      }

      const vadResult = this.vad.processFrame(pcm8k, this.streamSid.substring(0, 8));

      if (vadResult.isSpeech && this.vad.turnCommitted) {
        console.log(`[Session ${this.streamSid}] New speech detected - resetting VAD`);
        this.vad.resetForNewTurn();
      }

      if (vadResult.shouldSendAudio) {
        const pcm16k = upsample8to16(pcm8k);
        const base64Pcm = pcm16ToBase64(pcm16k);

        if (this.elevenLabs.sendAudio(base64Pcm)) {
          this.audioSentCount++;
          this.vad.incrementAudioChunks();
          if (this.audioSentCount % 100 === 0) {
            console.log(`[Session ${this.streamSid}] Sent ${this.audioSentCount} audio chunks to ElevenLabs`);
          }
        }
      }

      if (vadResult.turnEnded) {
        if (this.vad.hasEnoughAudioForCommit()) {
          console.log(
            `[Session ${this.streamSid}] ⚡ User turn ended (${vadResult.silenceMs}ms silence, ${this.vad.audioChunksSent} chunks)`
          );
          this.elevenLabs.endTurn();
          this.agentSpeaking = true; // expect response
        } else {
          console.log(`[Session ${this.streamSid}] 🔇 Turn ended but not enough audio (${this.vad.audioChunksSent} chunks) - ignoring`);
          this.vad.resetForNewTurn();
        }
      }
    } catch (err) {
      console.error(`[Session ${this.streamSid}] Audio processing error:`, err);
    }
  }

  handleElevenLabsAudio(base64Pcm) {
    if (!this.isActive) return;

    try {
      const pcm16k = base64ToPcm16(base64Pcm);
      const pcm8k = downsample16to8(pcm16k);
      const mulawBuffer = encodeMulaw(pcm8k);

      this.enqueueToTwilio(mulawBuffer);
    } catch (err) {
      console.error(`[Session ${this.streamSid}] Audio transcode error:`, err);
    }
  }

  handleElevenLabsError(err) {
    console.error(`[Session ${this.streamSid}] ElevenLabs error:`, err);
  }

  close() {
    console.log(
      `[Session ${this.streamSid}] Closing - sent ${this.audioSentCount} user audio chunks, played ${this.framesSent} frames to Twilio`
    );
    this.isActive = false;

    if (this.greetingTimeout) clearTimeout(this.greetingTimeout);
    if (this.greetingFallbackTimeout) clearTimeout(this.greetingFallbackTimeout);
    if (this.playInterval) clearInterval(this.playInterval);

    this.elevenLabs?.close();
  }
}

// ============================================================================
// HTTP + WS SERVER (Twilio Media Streams)
// ============================================================================

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
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

  let session = null;

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.event) {
        case "connected":
          console.log("[Twilio] Connected event received");
          break;

        case "start": {
          const streamSid = message.start.streamSid;
          const callSid = message.start.callSid;
          console.log(`[Twilio] 📞 Call started - StreamSid: ${streamSid}, CallSid: ${callSid}`);

          session = new CallSession(streamSid, ws);
          sessions.set(streamSid, session);
          await session.start();
          break;
        }

        case "media":
          if (session) session.processIncomingAudio(message.media.payload);
          break;

        case "stop":
          console.log("[Twilio] 📞 Call stopped");
          if (session) {
            session.close();
            sessions.delete(session.streamSid);
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error("[Twilio] Message processing error:", err);
    }
  });

  ws.on("close", (code) => {
    console.log(`[Twilio] WebSocket closed: ${code}`);
    if (session) {
      session.close();
      sessions.delete(session.streamSid);
    }
  });

  ws.on("error", (err) => console.error("[Twilio] WebSocket error:", err));
});

// ============================================================================
// START
// ============================================================================

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Twilio ↔ ElevenLabs Real-Time Audio Bridge v3.1               ║
╠════════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                                    ║
║                                                                ║
║  Endpoints:                                                    ║
║    WebSocket: wss://your-domain/twilio-stream                  ║
║    TwiML:     https://your-domain/twiml                        ║
║    Health:    https://your-domain/health                       ║
╚════════════════════════════════════════════════════════════════╝
  `);

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.warn("⚠️  Warning: ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID not set!");
  }
});

process.on("SIGTERM", () => {
  console.log("[Server] Shutting down...");
  sessions.forEach((s) => s.close());
  wss.close();
  server.close();
});
