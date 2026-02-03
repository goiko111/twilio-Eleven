fromTwilio(b64) {
  if (!this.isActive || !this.eleven) return;

  try {
    const pcm8 = decodeMulaw(Buffer.from(b64, "base64"));
    const e = rmsEnergy(pcm8);
    const now = Date.now();

    // Anti-echo: ignore while agent is/was playing recently
    const inAntiEcho = this.agentPlaying || (now - this.lastAgentAudioAt < this.ANTI_ECHO_HOLD_MS);
    if (inAntiEcho) return;

    // Track voice activity for auto-commit (VAD local)
    if (e > this.ENERGY_THRESHOLD) {
      this.lastVoiceAt = now;
      if (!this.userTalking) {
        this.userTalking = true;
        this.userSpeechStartAt = now;
        console.log(`[Session ${this.streamSid.slice(0, 8)}] 🎤 User started speaking`);
      }
    }

    // ✅ SIEMPRE enviar audio a ElevenLabs
    const pcm16 = upsample8to16(pcm8);
    this.eleven.sendAudio(pcm16ToBase64(pcm16));

  } catch (err) {
    console.log(`[Session ${this.streamSid}] fromTwilio error: ${err?.message || err}`);
    this.close("from_twilio_error");
  }
}
```

---

## Pasos:

1. **Descarga** el `server.js` que te generé arriba (haz clic en el archivo)
2. **Sube** ese archivo a tu repositorio de Railway
3. **Despliega** y espera a que Railway reinicie
4. **Llama** y comparte los logs

Los logs deberían mostrar ahora:
```
🎤 User started speaking
👤 User: [tu transcripción]
💬 Agent: [respuesta del agente]
