/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge v3.0
 * 
 * This server acts as a bridge between Twilio Media Streams and ElevenLabs Conversational AI.
 * It handles audio transcoding, VAD-based turn detection, and bidirectional streaming.
 * 
 * Key features:
 * - Frame-based audio playback to Twilio (20ms frames)
 * - VAD with adaptive thresholds for telephony
 * - Proper handling of agent/user turn-taking
 * 
 * Deploy on: Railway, Render, DigitalOcean, Heroku, or any Node.js host
 * 
 * Environment variables required:
 * - ELEVENLABS_API_KEY: Your ElevenLabs API key
 * - ELEVENLABS_AGENT_ID: The agent ID for ConvAI
 * - PORT: Server port (default 8080)
 */

const WebSocket = require('ws');
const http = require('http');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 8080;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

// VAD Configuration - tuned for telephony based on real measurements
// Noise floor: ~0.0002-0.0003, Speech: ~0.08-0.17
const VAD_CONFIG = {
  silenceThresholdMs: 800,      // End turn after 800ms silence
  energyThreshold: 0.02,        // Low threshold to catch soft speech (noise floor is ~0.0003)
  frameSize: 160,               // Samples per frame (20ms at 8kHz)
  minSpeechFrames: 4,           // Minimum frames to confirm speech (80ms)
  maxSilenceBeforeGate: 500,    // Stop sending audio after 500ms silence (pre-commit)
  interruptionThreshold: 0.08,  // Threshold for interrupting agent
  minAudioChunksForCommit: 20,  // Require at least 20 audio chunks (~400ms of activity)
};

// Energy logging configuration
const LOG_ENERGY_EVERY_N_FRAMES = 50; // Log energy every 50 frames (1s)

// Agent speaking timeout - how long after last audio chunk to consider agent done
const AGENT_AUDIO_TIMEOUT_MS = 600; // 600ms without audio = agent done speaking

// Audio Configuration
const TWILIO_SAMPLE_RATE = 8000;
const ELEVENLABS_SAMPLE_RATE = 16000;
const TWILIO_FRAME_SIZE = 160; // 160 bytes = 20ms at 8kHz mu-law

// Outbound call configuration
const OUTBOUND_GREETING_DELAY_MS = 800; // Delay before triggering agent greeting
const GREETING_TIMEOUT_MS = 2500; // Fallback timeout if greeting never arrives

// ============================================================================
// AUDIO UTILITIES
// ============================================================================

/**
 * Mu-law to Linear PCM16 decode table (ITU-T G.711)
 */
const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mulaw = ~i;
    let sign = (mulaw & 0x80) ? -1 : 1;
    let exponent = (mulaw >> 4) & 0x07;
    let mantissa = mulaw & 0x0F;
    let sample = (mantissa << 3) + 0x84;
    sample <<= exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

/**
 * Linear PCM16 to Mu-law encode
 */
function linearToMulaw(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulawByte = ~(sign | (exponent << 4) | mantissa);
  
  return mulawByte & 0xFF;
}

/**
 * Decode mu-law buffer to PCM16 Int16Array
 */
function decodeMulaw(mulawBuffer) {
  const pcm = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawBuffer[i]];
  }
  return pcm;
}

/**
 * Encode PCM16 Int16Array to mu-law buffer
 */
function encodeMulaw(pcmSamples) {
  const mulaw = Buffer.alloc(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    mulaw[i] = linearToMulaw(pcmSamples[i]);
  }
  return mulaw;
}

/**
 * Upsample from 8kHz to 16kHz using linear interpolation
 */
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

/**
 * Downsample from 16kHz to 8kHz by taking every other sample
 */
function downsample16to8(samples16k) {
  const samples8k = new Int16Array(Math.floor(samples16k.length / 2));
  for (let i = 0; i < samples8k.length; i++) {
    samples8k[i] = samples16k[i * 2];
  }
  return samples8k;
}

/**
 * Convert Int16Array to base64 encoded PCM bytes (little-endian)
 */
function pcm16ToBase64(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], i * 2);
  }
  return buffer.toString('base64');
}

/**
 * Convert base64 PCM bytes to Int16Array
 */
function base64ToPcm16(base64) {
  const buffer = Buffer.from(base64, 'base64');
  const samples = new Int16Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buffer.readInt16LE(i * 2);
  }
  return samples;
}

/**
 * Generate silence buffer (16kHz PCM16)
 */
function generateSilence16k(durationMs) {
  const numSamples = Math.floor((durationMs / 1000) * ELEVENLABS_SAMPLE_RATE);
  return new Int16Array(numSamples); // All zeros = silence
}

// ============================================================================
// VOICE ACTIVITY DETECTION (VAD)
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

  /**
   * Calculate RMS energy of audio samples
   */
  calculateEnergy(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768;
      sum += normalized * normalized;
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Process audio frame and return turn detection result
   */
  processFrame(samples, sessionId = '') {
    this.frameCount++;
    
    if (this.turnCommitted) {
      return {
        isSpeech: false,
        turnEnded: false,
        shouldSendAudio: false,
        silenceMs: 999
      };
    }

    const energy = this.calculateEnergy(samples);
    
    // Track energy for debugging
    this.recentEnergies.push(energy);
    if (this.recentEnergies.length > 10) this.recentEnergies.shift();
    if (energy > this.maxEnergy) this.maxEnergy = energy;
    
    // Log energy periodically for debugging
    if (this.frameCount % LOG_ENERGY_EVERY_N_FRAMES === 0) {
      const avgEnergy = this.recentEnergies.reduce((a, b) => a + b, 0) / this.recentEnergies.length;
      console.log(`[VAD ${sessionId}] 📊 Energy: current=${energy.toFixed(4)}, avg=${avgEnergy.toFixed(4)}, max=${this.maxEnergy.toFixed(4)}, threshold=${this.config.energyThreshold}, speaking=${this.isSpeaking}`);
    }
    
    const isSpeech = energy > this.config.energyThreshold;
    
    if (isSpeech) {
      this.speechFrames++;
      this.silentFrames = 0;
      this.audioGated = false;
      
      if (this.speechFrames >= this.config.minSpeechFrames) {
        if (!this.isSpeaking) {
          console.log(`[VAD ${sessionId}] 🎤 Speech started (energy: ${energy.toFixed(4)})`);
        }
        this.isSpeaking = true;
      }
      
      return {
        isSpeech: true,
        turnEnded: false,
        shouldSendAudio: true,
        silenceMs: 0
      };
    }
    
    this.silentFrames++;
    const silenceMs = (this.silentFrames * this.config.frameSize / 8000) * 1000;

    if (!this.isSpeaking) {
      return {
        isSpeech: false,
        turnEnded: false,
        shouldSendAudio: false,
        silenceMs: 0
      };
    }

    if (silenceMs >= this.config.maxSilenceBeforeGate) {
      this.audioGated = true;
    }

    if (silenceMs >= this.config.silenceThresholdMs) {
      this.turnCommitted = true;
      
      return {
        isSpeech: false,
        turnEnded: true,
        shouldSendAudio: false,
        silenceMs
      };
    }

    return {
      isSpeech: false,
      turnEnded: false,
      shouldSendAudio: !this.audioGated,
      silenceMs
    };
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
    this.reconnectAttempts = 0;
    this.maxReconnects = 0;
    this.isAgentSpeaking = false;
    this.hasReceivedAudio = false;
    this.turnCommitTime = null;
    this.greetingTriggered = false;
    this.agentAudioTimeout = null;
  }

  async connect() {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${this.agentId}`,
          {
            headers: { 'xi-api-key': this.apiKey }
          }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to get signed URL: ${error}`);
        }

        const { signed_url } = await response.json();
        console.log('[ElevenLabs] Got signed URL, connecting...');

        this.ws = new WebSocket(signed_url);

        this.ws.on('open', () => {
          console.log('[ElevenLabs] WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
            
            if (message.type === 'conversation_initiation_metadata' && !this.isSessionReady) {
              this.isSessionReady = true;
              console.log('[ElevenLabs] ✅ Session ready');
              resolve();
            }
          } catch (e) {
            console.error('[ElevenLabs] Failed to parse message:', e);
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[ElevenLabs] WebSocket closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.isSessionReady = false;
          this.hasReceivedAudio = false;
        });

        this.ws.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error.message);
          this.onError?.(error);
          reject(error);
        });

        setTimeout(() => {
          if (!this.isSessionReady) {
            console.log('[ElevenLabs] Connection timeout');
            resolve();
          }
        }, 5000);

      } catch (error) {
        console.error('[ElevenLabs] Connection error:', error);
        reject(error);
      }
    });
  }

  handleMessage(message) {
    // Log ALL messages for debugging (except pings)
    if (message.type !== 'ping') {
      console.log(`[ElevenLabs] 📨 Event type: ${message.type}`, JSON.stringify(message).substring(0, 200));
    }
    
    switch (message.type) {
      case 'audio':
        const audioChunk = message.audio?.chunk || 
                          message.audio_event?.audio_base_64 ||
                          message.audio_event?.chunk ||
                          message.audio?.audio_base_64;
        
        if (audioChunk) {
          if (!this.hasReceivedAudio) {
            this.hasReceivedAudio = true;
            const latency = this.turnCommitTime ? Date.now() - this.turnCommitTime : 0;
            console.log(`[ElevenLabs] 🔊 First audio chunk received (latency: ${latency}ms, size: ${audioChunk.length})`);
          }
          
          if (!this.isAgentSpeaking) {
            this.isAgentSpeaking = true;
            console.log('[ElevenLabs] 🎙️ Agent started speaking');
            this.onAgentStateChange?.(true);
          }
          
          this.resetAgentAudioTimeout();
          this.onAudio(audioChunk);
        } else {
          console.log('[ElevenLabs] ⚠️ Audio event but no chunk found:', JSON.stringify(message).substring(0, 300));
        }
        break;

      case 'agent_response':
        console.log('[ElevenLabs] 💬 Agent text:', message.agent_response_event?.agent_response?.substring(0, 60));
        break;

      case 'agent_response_correction':
        console.log('[ElevenLabs] Agent corrected (interrupted)');
        break;

      case 'user_transcript':
        console.log('[ElevenLabs] 👤 User said:', message.user_transcription_event?.user_transcript);
        break;

      case 'interruption':
        console.log('[ElevenLabs] ⚠️ Interruption event');
        this.isAgentSpeaking = false;
        this.hasReceivedAudio = false;
        this.onAgentStateChange?.(false);
        break;

      case 'turn_end':
        console.log('[ElevenLabs] Agent turn ended');
        this.isAgentSpeaking = false;
        this.hasReceivedAudio = false;
        this.onAgentStateChange?.(false);
        break;

      case 'ping':
        const pingEventId = message.ping_event?.event_id || message.event_id;
        if (pingEventId) {
          this.send({ type: 'pong', event_id: pingEventId });
        }
        break;

      case 'conversation_initiation_metadata':
        console.log('[ElevenLabs] Session initialized, config:', JSON.stringify(message.conversation_initiation_metadata_event || {}).substring(0, 200));
        break;

      default:
        console.log(`[ElevenLabs] Unknown event: ${message.type}`);
        break;
    }
  }

  triggerGreeting() {
    if (this.greetingTriggered || !this.isSessionReady) {
      return;
    }
    
    this.greetingTriggered = true;
    console.log('[ElevenLabs] 🚀 Triggering agent greeting...');
    
    const silence = generateSilence16k(100);
    const base64Silence = pcm16ToBase64(silence);
    
    this.send({
      type: 'user_audio_chunk',
      user_audio_chunk: base64Silence
    });
    
    this.turnCommitTime = Date.now();
    this.send({
      type: 'user_audio_commit'
    });
    
    console.log('[ElevenLabs] ✅ Greeting trigger sent');
  }

  sendAudio(base64Audio) {
    if (!this.isConnected) {
      return false;
    }
    if (!this.isSessionReady) {
      return false;
    }
    
    this.send({
      type: 'user_audio_chunk',
      user_audio_chunk: base64Audio
    });
    return true;
  }

  isPlayingAudio() {
    return this.isAgentSpeaking && this.hasReceivedAudio;
  }

  endTurn() {
    if (!this.isConnected || !this.isSessionReady) {
      console.log('[ElevenLabs] ⚠️ Cannot end turn - not connected/ready');
      return;
    }
    
    this.turnCommitTime = Date.now();
    console.log('[ElevenLabs] ⚡ User turn commit');
    
    this.send({
      type: 'user_audio_commit'
    });
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(message);
      if (message.type !== 'user_audio_chunk' && message.type !== 'pong') {
        console.log(`[ElevenLabs] 📤 Sending: ${payload.substring(0, 150)}`);
      }
      this.ws.send(payload);
    } else {
      console.log(`[ElevenLabs] ⚠️ Cannot send - WebSocket not open (state: ${this.ws?.readyState})`);
    }
  }

  resetAgentAudioTimeout() {
    if (this.agentAudioTimeout) {
      clearTimeout(this.agentAudioTimeout);
    }
    
    this.agentAudioTimeout = setTimeout(() => {
      if (this.isAgentSpeaking) {
        console.log('[ElevenLabs] ⏱️ Agent audio timeout - considering turn ended');
        this.isAgentSpeaking = false;
        this.hasReceivedAudio = false;
        this.onAgentStateChange?.(false);
      }
    }, AGENT_AUDIO_TIMEOUT_MS);
  }

  close() {
    this.maxReconnects = 0;
    if (this.agentAudioTimeout) {
      clearTimeout(this.agentAudioTimeout);
    }
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
    this.audioSentCount = 0;
    this.waitingForGreeting = true;
    this.greetingTimeout = null;
    this.greetingFallbackTimeout = null;
    
    // Output queue for Twilio audio playback (20ms frames)
    this.outQueue = Buffer.alloc(0);
    this.playInterval = null;
    this.framesSent = 0;
    
    console.log(`[Session ${streamSid}] Created`);
  }

  async start() {
    try {
      this.elevenLabs = new ElevenLabsClient(
        ELEVENLABS_API_KEY,
        ELEVENLABS_AGENT_ID,
        (audioBase64) => this.handleElevenLabsAudio(audioBase64),
        (error) => this.handleElevenLabsError(error),
        (isSpeaking) => this.handleAgentStateChange(isSpeaking)
      );

      await this.elevenLabs.connect();
      console.log(`[Session ${this.streamSid}] ElevenLabs connected`);

      // Start the Twilio audio player
      this.startTwilioPlayer();

      // For outbound calls: trigger the greeting after a short delay
      this.greetingTimeout = setTimeout(() => {
        if (this.isActive && this.elevenLabs?.isSessionReady) {
          this.elevenLabs.triggerGreeting();
        }
      }, OUTBOUND_GREETING_DELAY_MS);

      // Fallback: if greeting never arrives, enable user audio anyway
      this.greetingFallbackTimeout = setTimeout(() => {
        if (this.waitingForGreeting) {
          console.log(`[Session ${this.streamSid}] ⚠️ Greeting timeout, enabling user audio anyway`);
          this.waitingForGreeting = false;
        }
      }, GREETING_TIMEOUT_MS);

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Failed to start:`, error);
      this.close();
    }
  }

  /**
   * Start the Twilio audio player interval
   * Sends 160 bytes (20ms) of mu-law audio every 20ms
   */
  startTwilioPlayer() {
    if (this.playInterval) return;

    this.playInterval = setInterval(() => {
      if (!this.isActive) return;
      if (this.twilioWs.readyState !== WebSocket.OPEN) return;
      if (this.outQueue.length < TWILIO_FRAME_SIZE) return;

      const frame = this.outQueue.subarray(0, TWILIO_FRAME_SIZE);
      this.outQueue = this.outQueue.subarray(TWILIO_FRAME_SIZE);

      const message = {
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: frame.toString('base64') }
      };

      this.twilioWs.send(JSON.stringify(message));
      this.framesSent++;

      // Log periodically (every ~1 second = 50 frames)
      if (this.framesSent % 50 === 0) {
        console.log(`[Twilio ${this.streamSid.substring(0, 8)}] ▶️ Playing... frames=${this.framesSent}, queue=${this.outQueue.length} bytes`);
      }
    }, 20);

    console.log(`[Session ${this.streamSid}] Twilio player started`);
  }

  /**
   * Enqueue audio data for playback to Twilio
   */
  enqueueToTwilio(mulawBuffer) {
    this.outQueue = Buffer.concat([this.outQueue, mulawBuffer]);
  }

  handleAgentStateChange(isSpeaking) {
    this.agentSpeaking = isSpeaking;
    
    if (isSpeaking) {
      this.waitingForGreeting = false;
      console.log(`[Session ${this.streamSid}] Agent speaking - muting user audio processing`);
    } else {
      console.log(`[Session ${this.streamSid}] Agent finished - ready for user input`);
      this.vad.resetForNewTurn();
    }
  }

  processIncomingAudio(base64Mulaw) {
    if (!this.isActive || !this.elevenLabs?.isConnected) return;
    if (!this.elevenLabs?.isSessionReady) return;

    try {
      const mulawBuffer = Buffer.from(base64Mulaw, 'base64');
      const pcm8k = decodeMulaw(mulawBuffer);
      
      // If we're still waiting for the greeting, don't process audio
      if (this.waitingForGreeting) {
        return;
      }
      
      // Calculate energy for logging
      const energy = this.vad.calculateEnergy(pcm8k);
      
      // While agent is speaking, only allow clear interruptions
      if (this.agentSpeaking) {
        if (energy > VAD_CONFIG.interruptionThreshold) {
          console.log(`[Session ${this.streamSid}] 🛑 User interruption (energy: ${energy.toFixed(3)})`);
          const pcm16k = upsample8to16(pcm8k);
          const base64Pcm = pcm16ToBase64(pcm16k);
          this.elevenLabs.sendAudio(base64Pcm);
        }
        return;
      }
      
      // Normal VAD processing when agent is not speaking
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
          console.log(`[Session ${this.streamSid}] ⚡ User turn ended (${vadResult.silenceMs}ms silence, ${this.vad.audioChunksSent} chunks)`);
          this.elevenLabs.endTurn();
          this.agentSpeaking = true;
        } else {
          console.log(`[Session ${this.streamSid}] 🔇 Turn ended but not enough audio (${this.vad.audioChunksSent} chunks) - ignoring`);
          this.vad.resetForNewTurn();
        }
      }

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Audio processing error:`, error);
    }
  }

  handleElevenLabsAudio(base64Pcm) {
    if (!this.isActive) return;

    try {
      const pcm16k = base64ToPcm16(base64Pcm);
      const pcm8k = downsample16to8(pcm16k);
      const mulawBuffer = encodeMulaw(pcm8k);
      
      // Enqueue for frame-based playback instead of sending directly
      this.enqueueToTwilio(mulawBuffer);

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Audio transcode error:`, error);
    }
  }

  handleElevenLabsError(error) {
    console.error(`[Session ${this.streamSid}] ElevenLabs error:`, error);
  }

  close() {
    console.log(`[Session ${this.streamSid}] Closing - sent ${this.audioSentCount} user audio chunks, played ${this.framesSent} frames to Twilio`);
    this.isActive = false;
    
    if (this.greetingTimeout) {
      clearTimeout(this.greetingTimeout);
    }
    if (this.greetingFallbackTimeout) {
      clearTimeout(this.greetingFallbackTimeout);
    }
    if (this.playInterval) {
      clearInterval(this.playInterval);
    }
    
    this.elevenLabs?.close();
  }
}

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.url === '/twiml') {
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

    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(twiml);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocket.Server({ server });

const sessions = new Map();

wss.on('connection', (ws, req) => {
  console.log(`[Server] New WebSocket connection from ${req.url}`);

  let session = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.event) {
        case 'connected':
          console.log('[Twilio] Connected event received');
          break;

        case 'start':
          const streamSid = message.start.streamSid;
          const callSid = message.start.callSid;
          console.log(`[Twilio] 📞 Call started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
          
          session = new CallSession(streamSid, ws);
          sessions.set(streamSid, session);
          await session.start();
          break;

        case 'media':
          if (session) {
            session.processIncomingAudio(message.media.payload);
          }
          break;

        case 'stop':
          console.log('[Twilio] 📞 Call stopped');
          if (session) {
            session.close();
            sessions.delete(session.streamSid);
          }
          break;

        case 'mark':
          break;

        default:
          console.log(`[Twilio] Unknown event: ${message.event}`);
      }

    } catch (error) {
      console.error('[Twilio] Message processing error:', error);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[Twilio] WebSocket closed: ${code}`);
    if (session) {
      session.close();
      sessions.delete(session.streamSid);
    }
  });

  ws.on('error', (error) => {
    console.error('[Twilio] WebSocket error:', error);
  });
});

// ============================================================================
// START SERVER
// ============================================================================

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Twilio ↔ ElevenLabs Audio Bridge v3.0                         ║
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
    console.warn('⚠️  Warning: ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID not set!');
  }
});

process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  sessions.forEach(session => session.close());
  wss.close();
  server.close();
});
