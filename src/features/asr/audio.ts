export const ASR_SAMPLE_RATE = 16_000;
export const ASR_MIN_CHUNK_SECONDS = 0.2;
export const ASR_MAX_CHUNK_SECONDS = 1;
export const ASR_DEFAULT_CHUNK_SECONDS = 0.2;

const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const PCM_CAPTURE_WORKLET_URL = new URL("./pcmCapture.worklet.js?no-inline", import.meta.url);
const PCM_CAPTURE_PROCESSOR_NAME = "rlive-pcm-capture";

type PcmListener = (pcm: Float32Array) => void;

export type AudioCaptureBackend = "audio-worklet" | "script-processor";

export function selectAudioCaptureBackend(environment: {
  audioWorklet: boolean;
  audioWorkletNode: boolean;
}): AudioCaptureBackend {
  return environment.audioWorklet && environment.audioWorkletNode
    ? "audio-worklet"
    : "script-processor";
}

export function downsamplePcm(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = ASR_SAMPLE_RATE,
): Float32Array {
  if (!Number.isFinite(inputSampleRate) || !Number.isFinite(outputSampleRate)) {
    throw new RangeError("采样率无效");
  }
  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    throw new RangeError("采样率必须大于零");
  }
  if (input.length === 0) return new Float32Array();
  if (inputSampleRate === outputSampleRate) return input.slice();

  if (inputSampleRate < outputSampleRate) {
    const outputLength = Math.max(
      1,
      Math.floor((input.length * outputSampleRate) / inputSampleRate),
    );
    const output = new Float32Array(outputLength);
    const ratio = inputSampleRate / outputSampleRate;
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const mix = position - left;
      output[index] = input[left] * (1 - mix) + input[right] * mix;
    }
    return output;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex];
    }
    output[index] = sum / (end - start);
  }
  return output;
}

export function encodePcmBase64(samples: Float32Array): string {
  let bytes: Uint8Array;
  if (NATIVE_LITTLE_ENDIAN) {
    bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  } else {
    const buffer = new ArrayBuffer(samples.byteLength);
    const view = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, samples[index], true);
    }
    bytes = new Uint8Array(buffer);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function joinAsrCaptionText(segments: readonly { text: string }[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([，。！？；：,.!?;:])/g, "$1")
    .trim();
}

export function formatAsrCaptionSegment(segment: {
  text: string;
  speaker_id?: number | null;
}): string {
  const text = joinAsrCaptionText([{ text: segment.text }]);
  if (!text) return "";
  const speakerId = segment.speaker_id;
  if (!Number.isInteger(speakerId) || (speakerId ?? 0) <= 0) return text;
  return `说话人 ${speakerId}：${text}`;
}

export function appendAsrCaptionLine(previous: string | null, next: string, maxChars = 90): string {
  const normalized = joinAsrCaptionText([{ text: next }]);
  if (!normalized) return previous ?? "";

  const lines = (previous ? previous.split("\n") : []).filter(Boolean);
  lines.push(normalized);
  const joined = lines.slice(-2).join("\n");
  const characters = Array.from(joined);
  if (characters.length <= maxChars) return joined;

  const clipped = characters.slice(-maxChars);
  const firstBoundary = clipped.findIndex((character) => /[，。！？；：,.!?;:\s]/u.test(character));
  return clipped
    .slice(firstBoundary >= 0 ? firstBoundary + 1 : 0)
    .join("")
    .trimStart();
}

export type AudioCaptureSubscription = {
  release: () => void;
  setChunkSeconds: (seconds: number) => void;
};

function clampChunkSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return ASR_DEFAULT_CHUNK_SECONDS;
  return Math.min(ASR_MAX_CHUNK_SECONDS, Math.max(ASR_MIN_CHUNK_SECONDS, seconds));
}

type CaptureProcessor =
  | { kind: "audio-worklet"; node: AudioWorkletNode }
  | { kind: "script-processor"; node: ScriptProcessorNode };

type WorkletPcmMessage = {
  type: "pcm";
  samples: Float32Array;
};

class AudioCapturePipeline {
  private readonly listeners = new Set<PcmListener>();
  private buffer = new Float32Array();
  private totalSamples = 0;
  private chunkSeconds = ASR_DEFAULT_CHUNK_SECONDS;
  private monoScratch = new Float32Array();
  private disposed = false;

  constructor(
    readonly video: HTMLVideoElement,
    readonly context: AudioContext,
    private readonly source: MediaElementAudioSourceNode,
    private readonly processor: CaptureProcessor,
  ) {
    if (this.processor.kind === "audio-worklet") {
      this.processor.node.port.onmessage = (event) => this.handleWorkletMessage(event);
    } else {
      this.processor.node.onaudioprocess = (event) => this.handleAudioProcess(event);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") await this.context.resume();
  }

  addListener(listener: PcmListener): void {
    const firstListener = this.listeners.size === 0;
    this.listeners.add(listener);
    if (firstListener) this.setCaptureActive(true);
  }

  removeListener(listener: PcmListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.setCaptureActive(false);
  }

  setChunkSeconds(seconds: number): void {
    this.chunkSeconds = clampChunkSeconds(seconds);
    if (this.processor.kind === "audio-worklet") {
      this.processor.node.port.postMessage({
        type: "set_chunk_seconds",
        seconds: this.chunkSeconds,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.processor.kind === "audio-worklet") {
      this.processor.node.port.onmessage = null;
      this.processor.node.port.postMessage({ type: "set_active", active: false });
    } else {
      this.processor.node.onaudioprocess = null;
    }
    this.processor.node.disconnect();
    this.source.disconnect();
    this.resetBuffer();
    await this.context.close().catch(() => {});
  }

  private setCaptureActive(active: boolean): void {
    this.resetBuffer();
    if (this.processor.kind === "audio-worklet") {
      this.processor.node.port.postMessage({ type: "set_active", active });
    }
  }

  private resetBuffer(): void {
    this.totalSamples = 0;
  }

  private ensureBufferCapacity(requiredSamples: number): void {
    if (requiredSamples <= this.buffer.length) return;
    const capacity = Math.max(
      requiredSamples,
      Math.ceil(this.context.sampleRate * ASR_MAX_CHUNK_SECONDS) + 4096,
    );
    const next = new Float32Array(capacity);
    next.set(this.buffer.subarray(0, this.totalSamples));
    this.buffer = next;
  }

  private ensureMonoCapacity(requiredSamples: number): void {
    if (requiredSamples <= this.monoScratch.length) return;
    this.monoScratch = new Float32Array(requiredSamples);
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    const input = event.inputBuffer;
    const output = event.outputBuffer;
    const inputChannels = input.numberOfChannels;

    // MediaElementAudioSourceNode 会把播放重路由经过本图。复制所有声道，
    // 确保启用 ASR 永远不会改变或静音直播音频。
    for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
      const target = output.getChannelData(channel);
      if (inputChannels === 0) {
        target.fill(0);
      } else {
        target.set(input.getChannelData(Math.min(channel, inputChannels - 1)));
      }
    }

    if (this.listeners.size === 0 || inputChannels === 0) return;
    this.ensureMonoCapacity(input.length);
    const mono = this.monoScratch.subarray(0, input.length);
    mono.fill(0);
    for (let channel = 0; channel < inputChannels; channel += 1) {
      const source = input.getChannelData(channel);
      for (let index = 0; index < mono.length; index += 1) mono[index] += source[index];
    }
    if (inputChannels > 1) {
      for (let index = 0; index < mono.length; index += 1) mono[index] /= inputChannels;
    }
    this.append(mono);
  }

  private handleWorkletMessage(event: MessageEvent<unknown>): void {
    if (this.disposed || this.listeners.size === 0) return;
    const message = event.data as Partial<WorkletPcmMessage> | null;
    if (message?.type !== "pcm" || !(message.samples instanceof Float32Array)) return;
    this.emitPcm(message.samples);
  }

  private append(chunk: Float32Array): void {
    this.ensureBufferCapacity(this.totalSamples + chunk.length);
    this.buffer.set(chunk, this.totalSamples);
    this.totalSamples += chunk.length;
    const chunkSamples = Math.max(1, Math.round(this.context.sampleRate * this.chunkSeconds));

    while (this.totalSamples >= chunkSamples && this.listeners.size > 0) {
      const segment = this.buffer.slice(0, chunkSamples);
      const retainedLength = this.totalSamples - chunkSamples;
      if (retainedLength > 0) {
        this.buffer.copyWithin(0, chunkSamples, this.totalSamples);
      }
      this.totalSamples = retainedLength;
      this.emitPcm(segment);
    }
  }

  private emitPcm(segment: Float32Array): void {
    const downsampled = downsamplePcm(segment, this.context.sampleRate);
    for (const listener of this.listeners) listener(downsampled);
  }
}

type PipelineEntry = {
  promise: Promise<AudioCapturePipeline>;
  disposeTimer: number | null;
};

const capturePipelines = new WeakMap<HTMLVideoElement, PipelineEntry>();

async function createAudioCapturePipeline(video: HTMLVideoElement): Promise<AudioCapturePipeline> {
  const audioWindow = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("当前播放器不支持音频采集");

  const context = new AudioContextConstructor();
  if (context.state === "suspended") await context.resume();
  if (context.state === "closed") throw new Error("音频采集上下文不可用");

  const source = context.createMediaElementSource(video);
  let processor: CaptureProcessor | null = null;
  const backend = selectAudioCaptureBackend({
    audioWorklet: typeof context.audioWorklet?.addModule === "function",
    audioWorkletNode: typeof AudioWorkletNode === "function",
  });

  if (backend === "audio-worklet") {
    try {
      await context.audioWorklet.addModule(PCM_CAPTURE_WORKLET_URL.href);
      processor = {
        kind: "audio-worklet",
        node: new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { chunkSeconds: ASR_DEFAULT_CHUNK_SECONDS },
        }),
      };
    } catch {
      // 较旧或受策略限制的 WebView 可能暴露 AudioWorklet 却加载不了其模块。
      // 通过传统路径保留本地字幕。
    }
  }

  processor ??= {
    kind: "script-processor",
    node: context.createScriptProcessor(4096, 2, 2),
  };
  try {
    source.connect(processor.node);
    processor.node.connect(context.destination);
    return new AudioCapturePipeline(video, context, source, processor);
  } catch (error) {
    source.disconnect();
    processor.node.disconnect();
    await context.close().catch(() => {});
    throw error;
  }
}

function pipelineEntry(video: HTMLVideoElement): PipelineEntry {
  const current = capturePipelines.get(video);
  if (current) return current;

  const entry: PipelineEntry = {
    promise: Promise.resolve(null as never),
    disposeTimer: null,
  };
  entry.promise = createAudioCapturePipeline(video).catch((error) => {
    if (capturePipelines.get(video) === entry) capturePipelines.delete(video);
    throw error;
  });
  capturePipelines.set(video, entry);
  return entry;
}

function schedulePipelineDisposal(
  video: HTMLVideoElement,
  entry: PipelineEntry,
  pipeline: AudioCapturePipeline,
): void {
  entry.disposeTimer = window.setTimeout(() => {
    entry.disposeTimer = null;
    if (pipeline.listenerCount > 0) return;
    if (video.isConnected) {
      schedulePipelineDisposal(video, entry, pipeline);
      return;
    }
    if (capturePipelines.get(video) === entry) capturePipelines.delete(video);
    void pipeline.dispose();
  }, 1_000);
}

export async function subscribeToVideoPcm(
  video: HTMLVideoElement,
  listener: PcmListener,
): Promise<AudioCaptureSubscription> {
  const entry = pipelineEntry(video);
  if (entry.disposeTimer !== null) {
    window.clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
  const pipeline = await entry.promise;
  await pipeline.resume();
  pipeline.addListener(listener);

  let released = false;
  return {
    setChunkSeconds: (seconds) => pipeline.setChunkSeconds(seconds),
    release: () => {
      if (released) return;
      released = true;
      pipeline.removeListener(listener);
      if (pipeline.listenerCount > 0) return;

      schedulePipelineDisposal(video, entry, pipeline);
    },
  };
}
