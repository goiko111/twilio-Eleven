/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge v3.2 (NO-BARGE-IN, anti-echo gate)
 * Last line MUST be: // EOF
 */

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

// -------------------- VAD (telephony) --------------------
const VAD_CONFIG = {
  silenceThresholdMs: 800,
  energyThreshold: 0.02,
  frameSize: 160,
  minSpeechFrames: 4,
  maxSilenceBeforeGate: 500,
  minAudioChunksForCommit: 20,
};

const LOG_ENERGY_EVERY_N_FRAMES = 50;
const ELEVENLABS_SAMPLE_RATE = 16000;
const TWILIO_FRAME_SIZE = 160;

const AGENT_AUDIO_TIMEOUT_MS = 1500;

const OUTBOUND_GREETING_DELAY_MS = 600;
const GREETING_TIMEOUT_MS = 2500;

// -------------------- AUDIO UTILS --------------------
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

// -------------------- VAD --------------------
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

  resetForNewTurn() {
    this.reset();
  }

  incrementAudioChunks() {
    this.audioChunksSent++;
  }

  hasEnoughAudioForCommit() {
    return this.audioChunksSent >= this.config.minAudioChunksForCommit;
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
        `[VAD ${sessionId}] 📊 Energy: current=${energy.toFixed(4)}, avg=${avgEnergy.toFixed(4)}, max=${this.maxEnergy.toFixed(4)}, threshold=${this.config.energyThreshold}, speaking=${this.isSpeaking}`
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
    const silenceMs = (this.silentFrames * this.config.frameSize / 8000) * 1000;

    if (!this.isSpeaking) {
      return { isSpeech: false, turnEnded: false, shouldSendAudio: false, silenceMs: 0 };
    }

    if (silenceMs >= this.config.maxSilenceBeforeGate) this.audioGated = true;

    if (silenceMs >= this.config.silenceThresholdMs) {
      this.turnCommitted = true;
      return { isSpeech: false, turnEnded: true, shouldSendAudio: false, silenceMs };
    }

    return { isSpeech: false, turnEnded: false, shouldSendAudio: !this.audioGated, silenceMs };
  }
}

// -------------------- ElevenLabs Client --------------------
class ElevenLabsClient {
  constructor(apiKey, agentId, onAudio, onAgentStateChange) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.onAudio = onAudio;
    this.onAgentStateChange = onAgentStateChange;

    this.ws = null;
    this.isConnected = false;
    this.isSessionReady = false;

    this.isAgentSpeaking = false;
    this.hasReceivedAudio = false;

    this.turnCommitTime = null;
    this.greetingTriggered = false;

    this.agentAudioTimeout = null;
  }

  async connect() {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.agentId}`,
      { headers: { "xi-api-key": this.apiKey } }
    );
    if (!response.ok) throw new Error(await response.text());
    const { signed_url } = await response.json();

    console.log("[ElevenLabs] Got signed URL, connecting...");
    this.ws = new WebSocket(signed_url);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(), 6000);

      this.ws.on("open", () => {
        console.log("[ElevenLabs] WebSocket connected");
        this.isConnected = true;
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);

          if (msg.type === "conversation_initiation_metadata" && !this.isSessionReady) {
            this.isSessionReady = true;
            console.log("[ElevenLabs] ✅ Session ready");
            clearTimeout(t);
            resolve();
          }
        } catch (e) {
          console.error("[ElevenLabs] Failed to parse message:", e);
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[ElevenLabs] WebSocket closed: ${code} - ${reason}`);
        this.isConnected = false;
        this.isSessionReady = false;
        this.hasReceivedAudio = false;
        this.isAgentSpeaking = false;
      });
    });
  }

  handleMessage(message) {
    if (message.type !== "ping") {
      console.log("[ElevenLabs] 📨 Event type:", message.type, JSON.stringify(message).substring(0, 200));
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
          console.log("[ElevenLabs] 🎙️ Agent started speaking");
          this.onAgentStateChange?.(true);
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
        console.log("[ElevenLabs] Agent turn ended");
        this.isAgentSpeaking = false;
        this.hasReceivedAudio = false;
        this.onAgentStateChange?.(false);
        break;

      case "interruption":
        console.log("[ElevenLabs] ⚠️ Interruption event");
        this.isAgentSpeaking = false;
        this.hasReceivedAudio = false;
        this.onAgentStateChange?.(false);
        break;

      case "ping": {
        const pingEventId = message.ping_event?.event_id || message.event_id;
        if (pingEventId) this.send({ type: "pong", event_id: pingEventId }, true);
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

  triggerGreeting() {
    if (this.greetingTriggered || !this.isSessionReady) return;
    this.greetingTriggered = true;

    console.log("[ElevenLabs] 🚀 Triggering agent greeting...");

    const silence = generateSilence16k(120);
    const base64Silence = pcm16ToBase64(silence);

    this.send({ type: "user_audio_chunk", user_audio_chunk: base64Silence });
    this.turnCommitTime = Date.now();
    this.send({ type: "user_audio_commit" });

    console.log("[ElevenLabs] ✅ Greeting trigger sent");
  }

  sendAudio(base64Audio) {
    if (!this.isConnected || !this.isSessionReady) return false;
    this.send({ type: "user_audio_chunk", user_audio_chunk: base64Audio });
    return true;
  }

  endTurn() {
    if (!this.isConnected || !this.isSessionReady) return;
    this.turnCommitTime = Date.now();
    console.log("[ElevenLabs] ⚡ User turn commit");
    this.send({ type: "user_audio_commit" });
  }

  send(message, isPong = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(message);
    if (!isPong && message.type !== "user_audio_chunk") {
      console.log("[ElevenLabs] 📤 Sending:", payload.substring(0, 160));
    }
    this.ws.send(payload);
  }

  resetAgentAudioTimeout() {
    if (this.agentAudioTimeout) clearTimeout(this.agentAudioTimeout);
    this.agentAudioTimeout = setTimeout(() => {
      if (this.isAgentSpeaking) {
        console.log("[ElevenLabs] ⏱️ Agent audio timeout - pending turn end (wait queue drain)");
        this.onAgentStateChange?.(false, true);
      }
    }, AGENT_AUDIO_TIMEOUT_MS);
  }

  close() {
    if (this.agentAudioTimeout) clearTimeout(this.agentAudioTimeout);
    this.ws?.close();
  }
}

// -------------------- Call Session --------------------
class CallSession {
  constructor(streamSid, twilioWs) {
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;

    this.elevenLabs = null;
    this.vad = new SimpleVAD();

    this.isActive = true;
    this.agentSpeaking = false;

    this.waitingForGreeting = true;

    this.outQueue = Buffer.alloc(0);
    this.playInterval = null;
    this.framesSent = 0;

    this.userChunksSent = 0;

    this.greetingTimeout = null;
    this.greetingFallbackTimeout = null;

    console.log(`[Session ${streamSid}] Created`);
  }

  async start() {
    this.elevenLabs = new ElevenLabsClient(
      ELEVENLABS_API_KEY,
      ELEVENLABS_AGENT_ID,
      (audioBase64) => this.handleElevenLabsAudio(audioBase64),
      (isSpeaking, pending) => this.handleAgentStateChange(isSpeaking, pending)
    );

    await this.elevenLabs.connect();
    console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

    this.startTwilioPlayer();

    this.greetingTimeout = setTimeout(() => {
      if (this.isActive && this.elevenLabs?.isSessionReady) this.elevenLabs.triggerGreeting();
    }, OUTBOUND_GREETING_DELAY_MS);

    this.greetingFallbackTimeout = setTimeout(() => {
      if (this.waitingForGreeting) {
        console.log(`[Session ${this.streamSid}] ⚠️ Greeting timeout, enabling user audio anyway`);
        this.waitingForGreeting = false;
      }
    }, GREETING_TIMEOUT_MS);
  }

  startTwilioPlayer() {
    if (this.playInterval) return;

    this.playInterval = setInterval(() => {
      if (!this.isActive) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;
      if (this.outQueue.length < TWILIO_FRAME_SIZE) return;

      const frame = this.outQueue.subarray(0, TWILIO_FRAME_SIZE);
      this.outQueue = this.outQueue.subarray(TWILIO_FRAME_SIZE);

      const message = { event: "media", streamSid: this.streamSid, media: { payload: frame.toString("base64") } };
      this.twilioWs.send(JSON.stringify(message));
      this.framesSent++;

      if (this.framesSent % 50 === 0) {
        console.log(`[Twilio ${this.streamSid.substring(0, 8)}] ▶️ Playing... frames=${this.framesSent}, queue=${this.outQueue.length} bytes`);
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
      this.startQueueDrainCheck();
      return;
    }

    this.agentSpeaking = false;
    console.log(`[Session ${this.streamSid}] Agent finished - ready for user input`);
    this.vad.resetForNewTurn();
  }

  startQueueDrainCheck() {
    const checkInterval = setInterval(() => {
      if (!this.isActive) return clearInterval(checkInterval);

      if (this.outQueue.length < TWILIO_FRAME_SIZE * 2) {
        clearInterval(checkInterval);
        this.agentSpeaking = false;
        console.log(`[Session ${this.streamSid}] Agent finished (queue drained) - ready for user input`);
        this.vad.resetForNewTurn();
      }
    }, 100);

    setTimeout(() => {
      clearInterval(checkInterval);
      if (this.agentSpeaking) {
        this.agentSpeaking = false;
        console.log(`[Session ${this.streamSid}] Agent finished (timeout) - ready for user input`);
        this.vad.resetForNewTurn();
      }
    }, 5000);
  }

  processIncomingAudio(base64Mulaw) {
    if (!this.isActive) return;
    if (!this.elevenLabs?.isConnected || !this.elevenLabs?.isSessionReady) return;

    if (this.waitingForGreeting) return;

    // anti-echo gate
    if (this.agentSpeaking || this.outQueue.length >= TWILIO_FRAME_SIZE * 2) return;

    try {
      const mulawBuffer = Buffer.from(base64Mulaw, "base64");
      const pcm8k = decodeMulaw(mulawBuffer);

      const vadResult = this.vad.processFrame(pcm8k, this.streamSid.substring(0, 8));

      if (vadResult.shouldSendAudio) {
        const pcm16k = upsample8to16(pcm8k);
        const base64Pcm = pcm16ToBase64(pcm16k);

        if (this.elevenLabs.sendAudio(base64Pcm)) {
          this.userChunksSent++;
          this.vad.incrementAudioChunks();
          if (this.userChunksSent % 100 === 0) {
            console.log(`[Session ${this.streamSid}] Sent ${this.userChunksSent} audio chunks to ElevenLabs`);
          }
        }
      }

      if (vadResult.turnEnded) {
        if (this.vad.hasEnoughAudioForCommit()) {
          console.log(`[Session ${this.streamSid}] ⚡ User turn ended (${vadResult.silenceMs}ms silence, ${this.vad.audioChunksSent} chunks)`);
          this.elevenLabs.endTurn();
          this.agentSpeaking = true;
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

  close() {
    console.log(`[Session ${this.streamSid}] Closing - sent ${this.userChunksSent} user audio chunks, played ${this.framesSent} frames to Twilio`);
    this.isActive = false;

    if (this.greetingTimeout) clearTimeout(this.greetingTimeout);
    if (this.greetingFallbackTimeout) clearTimeout(this.greetingFallbackTimeout);
    if (this.playInterval) clearInterval(this.playInterval);

    this.elevenLabs?.close();
  }
}

// -------------------- HTTP + WS server --------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    return;
  }

  if (req.url === "/twiml") {
