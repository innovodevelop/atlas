/**
 * PCM capture worklet: mic audio → 16 kHz mono Int16 frames (~20 ms / 320
 * samples) posted to the main thread, which relays them to the voice gateway.
 * Replaces MediaRecorder for the live duplex loop (raw PCM, no containers).
 *
 * Also computes a cheap RMS level per frame so the UI (sphere/equalizer)
 * animates without a separate AnalyserNode graph.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSamples = 320; // 20 ms at 16 kHz
    this.acc = [];
    this.ratio = sampleRate / this.targetRate; // sampleRate is the context rate
    this.readPos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    // Linear-interpolation downsample to 16 kHz.
    while (this.readPos < ch.length) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      this.acc.push(a + (b - a) * frac);
      this.readPos += this.ratio;
    }
    this.readPos -= ch.length;

    while (this.acc.length >= this.frameSamples) {
      const frame = this.acc.splice(0, this.frameSamples);
      const pcm = new Int16Array(this.frameSamples);
      let sum = 0;
      for (let i = 0; i < this.frameSamples; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / this.frameSamples);
      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
