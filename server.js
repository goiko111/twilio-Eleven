/**
 * Twilio ↔ ElevenLabs Real-Time Audio Bridge
 * 
 * This server acts as a bridge between Twilio Media Streams and ElevenLabs Conversational AI.
 * It handles audio transcoding, VAD-based turn detection, and bidirectional streaming.
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

// VAD Configuration - AGGRESSIVE turn detection for fast response
const VAD_CONFIG = {
  silenceThresholdMs: 420,      // End turn after 420ms silence - no waiting!
  energyThreshold: 0.015,       // Higher threshold for telephony noise floor
  frameSize: 160,               // Samples per frame (20ms at 8kHz)
  minSpeechFrames: 3,           // Minimum frames to confirm speech (60ms)
  maxSilenceBeforeGate: 300,    // Stop sending audio after 300ms silence (pre-commit)
  interruptionThreshold: 0.05,  // Much higher threshold for interruption detection
};

// Audio Configuration
const TWILIO_SAMPLE_RATE = 8000;
const ELEVENLABS_SAMPLE_RATE = 16000;

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
  processFrame(samples) {
    if (this.turnCommitted) {
      return {
        isSpeech: false,
        turnEnded: false,
        shouldSendAudio: false,
        silenceMs: 999
      };
    }

    const energy = this.calculateEnergy(samples);
    const isSpeech = energy > this.config.energyThreshold;
    
    if (isSpeech) {
      this.speechFrames++;
      this.silentFrames = 0;
      this.audioGated = false;
      
      if (this.speechFrames >= this.config.minSpeechFrames) {
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
    this.isSessionReady = false;  // NEW: Track if session is fully established
    this.reconnectAttempts = 0;
    this.maxReconnects = 3;
    this.isAgentSpeaking = false;
    this.hasReceivedAudio = false;  // NEW: Track if agent has started sending audio
    this.turnCommitTime = null;
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
          // Don't resolve yet - wait for conversation_initiation_metadata
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
            
            // Resolve promise when session is ready
            if (message.type === 'conversation_initiation_metadata' && !this.isSessionReady) {
              this.isSessionReady = true;
              console.log('[ElevenLabs] Session fully established - ready to receive audio');
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
          
          if (this.reconnectAttempts < this.maxReconnects) {
            this.reconnectAttempts++;
            console.log(`[ElevenLabs] Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnects}`);
            setTimeout(() => this.connect(), 500);
          }
        });

        this.ws.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error.message);
          this.onError?.(error);
          reject(error);
        });

        // Timeout for initial connection
        setTimeout(() => {
          if (!this.isSessionReady) {
            console.log('[ElevenLabs] Connection timeout - resolving anyway');
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
    switch (message.type) {
      case 'audio':
        if (message.audio?.chunk) {
          // Mark that we've received audio - now interruption is valid
          if (!this.hasReceivedAudio) {
            this.hasReceivedAudio = true;
            const latency = this.turnCommitTime ? Date.now() - this.turnCommitTime : 0;
            console.log(`[ElevenLabs] ⚡ First audio received (latency: ${latency}ms)`);
          }
          
          if (!this.isAgentSpeaking) {
            this.isAgentSpeaking = true;
            this.onAgentStateChange?.(true);
          }
          this.onAudio(message.audio.chunk);
        }
        break;

      case 'agent_response':
        console.log('[ElevenLabs] Agent response:', message.agent_response_event?.agent_response?.substring(0, 50));
        // Don't set speaking flag here - wait for actual audio
        break;

      case 'agent_response_correction':
        console.log('[ElevenLabs] Agent corrected (interrupted)');
        break;

      case 'user_transcript':
        console.log('[ElevenLabs] User transcript:', message.user_transcription_event?.user_transcript);
        break;

      case 'interruption':
        console.log('[ElevenLabs] Interrupted - stopping agent audio');
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
        this.send({ type: 'pong', event_id: message.event_id });
        break;

      case 'conversation_initiation_metadata':
        console.log('[ElevenLabs] Session initialized');
        break;

      default:
        if (message.type) {
          console.log(`[ElevenLabs] Event: ${message.type}`);
        }
        break;
    }
  }

  /**
   * Send audio chunk to ElevenLabs
   * ONLY call this when session is ready
   */
  sendAudio(base64Audio) {
    if (!this.isConnected || !this.isSessionReady) {
      return false;
    }
    
    this.send({
      type: 'user_audio_chunk',
      user_audio_chunk: base64Audio
    });
    return true;
  }

  /**
   * Check if agent is actually playing audio (not just preparing)
   */
  isPlayingAudio() {
    return this.isAgentSpeaking && this.hasReceivedAudio;
  }

  endTurn() {
    if (!this.isConnected || !this.isSessionReady) return;
    
    this.turnCommitTime = Date.now();
    console.log('[ElevenLabs] ⚡ Sending user_audio_commit');
    
    this.send({
      type: 'user_audio_commit'
    });
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close() {
    this.maxReconnects = 0;
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
    this.audioSentCount = 0;  // Track how many audio chunks sent
    
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
      console.log(`[Session ${this.streamSid}] ElevenLabs connected - ready for conversation`);

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Failed to start:`, error);
      this.close();
    }
  }

  handleAgentStateChange(isSpeaking) {
    this.agentSpeaking = isSpeaking;
    if (!isSpeaking) {
      console.log(`[Session ${this.streamSid}] Agent finished - ready for user`);
      this.vad.resetForNewTurn();
    }
  }

  /**
   * Process incoming Twilio audio
   */
  processIncomingAudio(base64Mulaw) {
    if (!this.isActive || !this.elevenLabs?.isConnected) return;
    if (!this.elevenLabs?.isSessionReady) return;  // Don't send until session ready

    try {
      const mulawBuffer = Buffer.from(base64Mulaw, 'base64');
      const pcm8k = decodeMulaw(mulawBuffer);
      
      // While agent is ACTUALLY playing audio, check for loud interruption only
      if (this.elevenLabs.isPlayingAudio()) {
        const energy = this.vad.calculateEnergy(pcm8k);
        
        // Much higher threshold for interruption - only clear speech
        if (energy > VAD_CONFIG.interruptionThreshold) {
          console.log(`[Session ${this.streamSid}] User interruption (energy: ${energy.toFixed(3)})`);
          const pcm16k = upsample8to16(pcm8k);
          const base64Pcm = pcm16ToBase64(pcm16k);
          this.elevenLabs.sendAudio(base64Pcm);
        }
        return;
      }
      
      // Normal VAD processing when agent is not speaking
      const vadResult = this.vad.processFrame(pcm8k);
      
      if (vadResult.isSpeech && this.vad.turnCommitted) {
        console.log(`[Session ${this.streamSid}] New speech detected - resetting`);
        this.vad.resetForNewTurn();
      }
      
      if (vadResult.shouldSendAudio) {
        const pcm16k = upsample8to16(pcm8k);
        const base64Pcm = pcm16ToBase64(pcm16k);
        
        if (this.elevenLabs.sendAudio(base64Pcm)) {
          this.audioSentCount++;
          if (this.audioSentCount % 50 === 0) {
            console.log(`[Session ${this.streamSid}] Sent ${this.audioSentCount} audio chunks`);
          }
        }
      }

      if (vadResult.turnEnded) {
        console.log(`[Session ${this.streamSid}] ⚡ TURN ENDED at ${vadResult.silenceMs}ms`);
        this.elevenLabs.endTurn();
        this.agentSpeaking = true;
      }

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Audio processing error:`, error);
    }
  }

  /**
   * Handle audio coming from ElevenLabs
   */
  handleElevenLabsAudio(base64Pcm) {
    if (!this.isActive) return;

    try {
      const pcm16k = base64ToPcm16(base64Pcm);
      const pcm8k = downsample16to8(pcm16k);
      const mulawBuffer = encodeMulaw(pcm8k);
      
      this.sendToTwilio(mulawBuffer.toString('base64'));

    } catch (error) {
      console.error(`[Session ${this.streamSid}] ElevenLabs audio error:`, error);
    }
  }

  handleElevenLabsError(error) {
    console.error(`[Session ${this.streamSid}] ElevenLabs error:`, error);
  }

  sendToTwilio(base64Mulaw) {
    if (this.twilioWs.readyState !== WebSocket.OPEN) return;

    const message = {
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: base64Mulaw
      }
    };

    this.twilioWs.send(JSON.stringify(message));
  }

  close() {
    console.log(`[Session ${this.streamSid}] Closing - sent ${this.audioSentCount} audio chunks`);
    this.isActive = false;
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
          console.log(`[Twilio] Call started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
          
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
          console.log('[Twilio] Call stopped');
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
║  Twilio ↔ ElevenLabs Audio Bridge                              ║
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
