/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const MIN_CHUNK_SECONDS = 0.2;
const MAX_CHUNK_SECONDS = 1;
const DEFAULT_CHUNK_SECONDS = 0.2;

function clampChunkSeconds(value) {
  if (!Number.isFinite(value)) return DEFAULT_CHUNK_SECONDS;
  return Math.min(MAX_CHUNK_SECONDS, Math.max(MIN_CHUNK_SECONDS, value));
}

class RLivePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.active = false;
    this.chunkSeconds = clampChunkSeconds(options.processorOptions?.chunkSeconds);
    this.buffer = new Float32Array(Math.ceil(sampleRate * MAX_CHUNK_SECONDS) + 128);
    this.totalSamples = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "set_active") {
      this.active = message.active === true;
      this.totalSamples = 0;
      return;
    }
    if (message.type === "set_chunk_seconds") {
      this.chunkSeconds = clampChunkSeconds(message.seconds);
      this.emitReadyChunks();
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];

    // MediaElementAudioSourceNode reroutes playback through this node. Keep a
    // transparent pass-through so ASR never mutes or alters live audio.
    for (let channel = 0; channel < output.length; channel += 1) {
      const target = output[channel];
      const source = input.length > 0 ? input[Math.min(channel, input.length - 1)] : null;
      if (source) target.set(source);
      else target.fill(0);
    }

    const frameCount = input[0]?.length ?? 0;
    if (this.active && input.length > 0 && frameCount > 0) {
      this.appendChannels(input, frameCount);
    }
    return true;
  }

  appendChannels(channels, frameCount) {
    const requiredSamples = this.totalSamples + frameCount;
    if (requiredSamples > this.buffer.length) {
      const next = new Float32Array(Math.max(requiredSamples, this.buffer.length * 2));
      next.set(this.buffer.subarray(0, this.totalSamples));
      this.buffer = next;
    }

    for (let index = 0; index < frameCount; index += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sum += channels[channel][index];
      }
      this.buffer[this.totalSamples + index] = sum / channels.length;
    }
    this.totalSamples += frameCount;
    this.emitReadyChunks();
  }

  emitReadyChunks() {
    if (!this.active) return;
    const chunkSamples = Math.max(1, Math.round(sampleRate * this.chunkSeconds));
    while (this.totalSamples >= chunkSamples) {
      const samples = this.buffer.slice(0, chunkSamples);
      const retainedLength = this.totalSamples - chunkSamples;
      if (retainedLength > 0) {
        this.buffer.copyWithin(0, chunkSamples, this.totalSamples);
      }
      this.totalSamples = retainedLength;
      this.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
    }
  }
}

registerProcessor("rlive-pcm-capture", RLivePcmCaptureProcessor);
