// AudioWorklet 处理器运行在音频渲染线程,其全局作用域
// (AudioWorkletGlobalScope) 不在 TypeScript 的 DOM lib 内,这里按本文件
// 实际用到的 API 做模块级声明,避免污染应用全局类型。
export {};

declare const sampleRate: number;

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type WorkletCommand =
  | { type: "set_active"; active: boolean }
  | { type: "set_chunk_seconds"; seconds: number };

type PcmMessage = { type: "pcm"; samples: Float32Array };

type PcmCaptureOptions = { chunkSeconds?: number };

const MIN_CHUNK_SECONDS = 0.2;
const MAX_CHUNK_SECONDS = 1;
const DEFAULT_CHUNK_SECONDS = 0.2;

function clampChunkSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CHUNK_SECONDS;
  return Math.min(MAX_CHUNK_SECONDS, Math.max(MIN_CHUNK_SECONDS, value));
}

class RLivePcmCaptureProcessor extends AudioWorkletProcessor {
  private active = false;
  private chunkSeconds = DEFAULT_CHUNK_SECONDS;
  private buffer: Float32Array;
  private totalSamples = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { chunkSeconds } = (options.processorOptions ?? {}) as PcmCaptureOptions;
    this.chunkSeconds = clampChunkSeconds(chunkSeconds);
    this.buffer = new Float32Array(Math.ceil(sampleRate * MAX_CHUNK_SECONDS) + 128);
    this.totalSamples = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const command = message as WorkletCommand;
    if (command.type === "set_active") {
      this.active = command.active === true;
      this.totalSamples = 0;
      return;
    }
    if (command.type === "set_chunk_seconds") {
      this.chunkSeconds = clampChunkSeconds(command.seconds);
      this.emitReadyChunks();
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];

    // MediaElementAudioSourceNode 把播放重路由经过本节点。保持透明直通，
    // 使 ASR 绝不静音或改变直播音频。
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

  private appendChannels(channels: Float32Array[], frameCount: number): void {
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

  private emitReadyChunks(): void {
    if (!this.active) return;
    const chunkSamples = Math.max(1, Math.round(sampleRate * this.chunkSeconds));
    while (this.totalSamples >= chunkSamples) {
      const samples = this.buffer.slice(0, chunkSamples);
      const retainedLength = this.totalSamples - chunkSamples;
      if (retainedLength > 0) {
        this.buffer.copyWithin(0, chunkSamples, this.totalSamples);
      }
      this.totalSamples = retainedLength;
      this.port.postMessage({ type: "pcm", samples } satisfies PcmMessage, [samples.buffer]);
    }
  }
}

registerProcessor("rlive-pcm-capture", RLivePcmCaptureProcessor);
