# Twilio ↔ ElevenLabs Audio Bridge

Real-time audio bridge that connects Twilio Media Streams with ElevenLabs Conversational AI, featuring custom VAD for <1 second end-of-turn latency.

## Architecture

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Twilio    │────▶│   This Bridge       │────▶│   ElevenLabs    │
│  (μ-law 8k) │◀────│  (VAD + Transcode)  │◀────│   (PCM16 16k)   │
└─────────────┘     └─────────────────────┘     └─────────────────┘
```

## Features

- **Low Latency**: Custom VAD with 400-500ms silence threshold
- **Audio Transcoding**: μ-law 8kHz ↔ PCM16 16kHz
- **Streaming**: No batching, frames sent immediately
- **Auto-reconnect**: ElevenLabs WebSocket reconnection
- **Spanish Optimized**: Tuned for telephony audio quality

## Deployment

### Railway (Recommended)

1. Create a new Railway project
2. Connect your GitHub repo
3. Add environment variables:
   ```
   ELEVENLABS_API_KEY=your_api_key
   ELEVENLABS_AGENT_ID=agent_xxxxx
   PORT=8080
   ```
4. Deploy!

### Render

1. Create a new Web Service
2. Connect repo, select Node runtime
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables

### Manual/VPS

```bash
git clone <repo>
cd twilio-elevenlabs-bridge
npm install

export ELEVENLABS_API_KEY=your_key
export ELEVENLABS_AGENT_ID=agent_xxxxx
export PORT=8080

npm start
```

## Twilio Configuration

### Option 1: Use Built-in TwiML Endpoint

Configure your Twilio number's Voice webhook to:
```
https://your-bridge-domain.com/twiml
```

### Option 2: Custom TwiML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://your-bridge-domain.com/twilio-stream">
      <Parameter name="language" value="es-ES"/>
    </Stream>
  </Connect>
</Response>
```

### Option 3: TwiML Bin

Create a TwiML Bin in Twilio console with the above XML.

## Initiating Outbound Calls

Update your `lead-phone-call` edge function to use TwiML instead of direct ElevenLabs:

```typescript
// In Supabase edge function
const twilioResponse = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: formattedPhone,
      From: TWILIO_PHONE_NUMBER,
      Url: 'https://your-bridge-domain.com/twiml',
    }),
  }
);
```

## VAD Tuning (CRITICAL for Latency)

The server uses **AGGRESSIVE** turn detection that does NOT rely on ElevenLabs' internal VAD.

Edit `VAD_CONFIG` in `server.js`:

```javascript
const VAD_CONFIG = {
  silenceThresholdMs: 420,    // End turn after 420ms silence - triggers commit
  energyThreshold: 0.008,     // Lower = more sensitive to speech
  frameSize: 160,             // 20ms frames at 8kHz (don't change)
  minSpeechFrames: 2,         // 40ms of speech to confirm speaking
  maxSilenceBeforeGate: 300,  // Stop sending audio after 300ms silence (pre-commit)
};
```

### How It Works

1. **Audio Gating**: After 300ms silence, we STOP sending audio to ElevenLabs
2. **Turn Commit**: After 420ms silence, we send `user_audio_commit` IMMEDIATELY
3. **No Waiting**: We don't wait for ElevenLabs' VAD - we control the turn explicitly
4. **Fast Response**: Agent starts speaking within ~200-400ms of commit

### For Spanish Telephony

- `silenceThresholdMs`: 400-450ms works well for Spanish speech rhythm
- `energyThreshold`: 0.006-0.010 for typical telephony noise floor
- `minSpeechFrames`: Keep at 2-3 to avoid false positives from noise

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `wss://domain/twilio-stream` | WebSocket for Twilio Media Streams |
| `GET /twiml` | Returns TwiML for connecting to bridge |
| `GET /health` | Health check endpoint |

## Monitoring

The server logs important events:

```
[Session xxx] Created
[ElevenLabs] WebSocket connected
[Session xxx] Turn ended after 450ms silence
[ElevenLabs] Agent response: "Hola, ¿en qué puedo..."
```

## Troubleshooting

### High Latency
- Check network between bridge and ElevenLabs
- Ensure PORT is not being proxied with buffering
- Verify WebSocket connections are direct (not through HTTP proxy)

### Audio Quality Issues
- Verify Twilio is sending μ-law 8kHz (default)
- Check ElevenLabs agent audio settings

### Turn Detection Too Slow
- Lower `silenceThresholdMs` (try 350ms)
- Verify audio is reaching the server (check logs)

### Turn Detection Too Fast (Cutting Off)
- Increase `silenceThresholdMs` (try 550ms)
- Increase `minSpeechFrames` to 4-5

## License

MIT
