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

// VAD Configuration - tuned for telephony
const VAD_CONFIG = {
  silenceThresholdMs: 500,      // End turn after 500ms silence
  energyThreshold: 0.02,        // Higher threshold for telephony noise floor
  frameSize: 160,               // Samples per frame (20ms at 8kHz)
  minSpeechFrames: 4,           // Minimum frames to confirm speech (80ms)
  maxSilenceBeforeGate: 350,    // Stop sending audio after 350ms silence (pre-commit)
  interruptionThreshold: 0.08,  // Very high threshold for interruption detection
};

// Audio Configuration
const TWILIO_SAMPLE_RATE = 8000;
const ELEVENLABS_SAMPLE_RATE = 16000;

// Outbound call configuration
const OUTBOUND_GREETING_DELAY_MS = 800; // Delay before triggering agent greeting

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
    this.isSessionReady = false;
    this.reconnectAttempts = 0;
    this.maxReconnects = 0; // Disable reconnects - they cause issues
    this.isAgentSpeaking = false;
    this.hasReceivedAudio = false;
    this.turnCommitTime = null;
    this.greetingTriggered = false;
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
    switch (message.type) {
      case 'audio':
        if (message.audio?.chunk) {
          if (!this.hasReceivedAudio) {
            this.hasReceivedAudio = true;
            const latency = this.turnCommitTime ? Date.now() - this.turnCommitTime : 0;
            console.log(`[ElevenLabs] 🔊 First audio chunk received (latency: ${latency}ms)`);
          }
          
          if (!this.isAgentSpeaking) {
            this.isAgentSpeaking = true;
            console.log('[ElevenLabs] 🎙️ Agent started speaking');
            this.onAgentStateChange?.(true);
          }
          this.onAudio(message.audio.chunk);
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
   * Trigger the agent's first message by sending silence + commit
   * This is needed for OUTBOUND calls where the agent should speak first
   */
  triggerGreeting() {
    if (this.greetingTriggered || !this.isSessionReady) {
      return;
    }
    
    this.greetingTriggered = true;
    console.log('[ElevenLabs] 🚀 Triggering agent greeting...');
    
    // Send a small amount of silence
    const silence = generateSilence16k(100); // 100ms of silence
    const base64Silence = pcm16ToBase64(silence);
    
    this.send({
      type: 'user_audio_chunk',
      user_audio_chunk: base64Silence
    });
    
    // Immediately commit to trigger the agent's first message
    this.turnCommitTime = Date.now();
    this.send({
      type: 'user_audio_commit'
    });
    
    console.log('[ElevenLabs] ✅ Greeting trigger sent');
  }

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

  isPlayingAudio() {
    return this.isAgentSpeaking && this.hasReceivedAudio;
  }

  endTurn() {
    if (!this.isConnected || !this.isSessionReady) return;
    
    this.turnCommitTime = Date.now();
    console.log('[ElevenLabs] ⚡ User turn commit');
    
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
    this.audioSentCount = 0;
    this.waitingForGreeting = true; // Don't process user audio until agent speaks first
    this.greetingTimeout = null;
    
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

      // For outbound calls: trigger the greeting after a short delay
      this.greetingTimeout = setTimeout(() => {
        if (this.isActive && this.elevenLabs?.isSessionReady) {
          this.elevenLabs.triggerGreeting();
        }
      }, OUTBOUND_GREETING_DELAY_MS);

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Failed to start:`, error);
      this.close();
    }
  }

  handleAgentStateChange(isSpeaking) {
    this.agentSpeaking = isSpeaking;
    
    if (isSpeaking) {
      // Agent started speaking - don't process user audio
      this.waitingForGreeting = false; // First message received
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
      
      // While agent is speaking, only check for very loud interruptions
      if (this.agentSpeaking) {
        const energy = this.vad.calculateEnergy(pcm8k);
        
        // Only allow interruption with very clear speech
        if (energy > VAD_CONFIG.interruptionThreshold) {
          console.log(`[Session ${this.streamSid}] 🛑 User interruption (energy: ${energy.toFixed(3)})`);
          const pcm16k = upsample8to16(pcm8k);
          const base64Pcm = pcm16ToBase64(pcm16k);
          this.elevenLabs.sendAudio(base64Pcm);
          // Send commit to trigger interruption
          this.elevenLabs.endTurn();
        }
        return;
      }
      
      // Normal VAD processing when agent is not speaking
      const vadResult = this.vad.processFrame(pcm8k);
      
      if (vadResult.isSpeech && this.vad.turnCommitted) {
        console.log(`[Session ${this.streamSid}] New speech detected - resetting VAD`);
        this.vad.resetForNewTurn();
      }
      
      if (vadResult.shouldSendAudio) {
        const pcm16k = upsample8to16(pcm8k);
        const base64Pcm = pcm16ToBase64(pcm16k);
        
        if (this.elevenLabs.sendAudio(base64Pcm)) {
          this.audioSentCount++;
          if (this.audioSentCount % 100 === 0) {
            console.log(`[Session ${this.streamSid}] Sent ${this.audioSentCount} audio chunks`);
          }
        }
      }

      if (vadResult.turnEnded) {
        console.log(`[Session ${this.streamSid}] ⚡ User turn ended (${vadResult.silenceMs}ms silence)`);
        this.elevenLabs.endTurn();
        this.agentSpeaking = true; // Expect agent to respond
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
      
      this.sendToTwilio(mulawBuffer.toString('base64'));

    } catch (error) {
      console.error(`[Session ${this.streamSid}] Audio transcode error:`, error);
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
    console.log(`[Session ${this.streamSid}] Closing - sent ${this.audioSentCount} user audio chunks`);
    this.isActive = false;
    if (this.greetingTimeout) {
      clearTimeout(this.greetingTimeout);
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
║  Twilio ↔ ElevenLabs Audio Bridge v2.0                         ║
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
