// Audio is streamed in memory only; never recorded or persisted.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        const pcm = new Int16Array(this.samples.length);
        let energy = 0;
        for (let i = 0; i < pcm.length; i++) {
          const v = Math.max(-1, Math.min(1, this.samples[i]));
          pcm[i] = v < 0 ? v * 32768 : v * 32767;
          energy += v * v;
        }
        this.port.postMessage(
          { pcm: pcm.buffer, rms: Math.sqrt(energy / pcm.length) },
          [pcm.buffer],
        );
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
