export const ASR_SAMPLE_RATE = 16_000;
export const ASR_MIN_SEGMENT_SECONDS = 1;
export const ASR_MAX_SEGMENT_SECONDS = 6;
export const ASR_DEFAULT_SEGMENT_SECONDS = 1;
/** Default fixed live-caption window. Settings may change it within 1–6 seconds. */
export const ASR_SEGMENT_SECONDS = ASR_DEFAULT_SEGMENT_SECONDS;
export const ASR_OVERLAP_SECONDS = 0.25;

const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type PcmListener = (pcm: Float32Array) => void;

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

export type AudioCaptureSubscription = {
  release: () => void;
  setSegmentSeconds: (seconds: number) => void;
};

function clampSegmentSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return ASR_SEGMENT_SECONDS;
  return Math.min(ASR_MAX_SEGMENT_SECONDS, Math.max(ASR_MIN_SEGMENT_SECONDS, seconds));
}

class AudioCapturePipeline {
  private readonly listeners = new Set<PcmListener>();
  private buffer = new Float32Array();
  private totalSamples = 0;
  private segmentSeconds = ASR_SEGMENT_SECONDS;
  private monoScratch = new Float32Array();
  private disposed = false;

  constructor(
    readonly video: HTMLVideoElement,
    readonly context: AudioContext,
    private readonly source: MediaElementAudioSourceNode,
    private readonly processor: ScriptProcessorNode,
  ) {
    this.processor.onaudioprocess = (event) => this.handleAudioProcess(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async resume(): Promise<void> {
    if (this.context.state === "suspended") await this.context.resume();
  }

  addListener(listener: PcmListener): void {
    if (this.listeners.size === 0) this.resetBuffer();
    this.listeners.add(listener);
  }

  removeListener(listener: PcmListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.resetBuffer();
  }

  setSegmentSeconds(seconds: number): void {
    this.segmentSeconds = clampSegmentSeconds(seconds);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.processor.onaudioprocess = null;
    this.processor.disconnect();
    this.source.disconnect();
    this.resetBuffer();
    await this.context.close().catch(() => {});
  }

  private resetBuffer(): void {
    this.totalSamples = 0;
  }

  private ensureBufferCapacity(requiredSamples: number): void {
    if (requiredSamples <= this.buffer.length) return;
    const capacity = Math.max(
      requiredSamples,
      Math.ceil(this.context.sampleRate * ASR_MAX_SEGMENT_SECONDS) + 4096,
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

    // A MediaElementAudioSourceNode reroutes playback through this graph. Copy
    // every channel so enabling ASR never changes or silences the live audio.
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

  private append(chunk: Float32Array): void {
    this.ensureBufferCapacity(this.totalSamples + chunk.length);
    this.buffer.set(chunk, this.totalSamples);
    this.totalSamples += chunk.length;
    const segmentSamples = Math.max(1, Math.round(this.context.sampleRate * this.segmentSeconds));
    const overlapSamples = Math.min(
      segmentSamples - 1,
      Math.max(0, Math.round(this.context.sampleRate * ASR_OVERLAP_SECONDS)),
    );

    while (this.totalSamples >= segmentSamples && this.listeners.size > 0) {
      const segment = this.buffer.slice(0, segmentSamples);
      const retainedStart = segmentSamples - overlapSamples;
      const retainedLength = this.totalSamples - retainedStart;
      if (retainedLength > 0) {
        this.buffer.copyWithin(0, retainedStart, this.totalSamples);
      }
      this.totalSamples = Math.max(0, retainedLength);
      const downsampled = downsamplePcm(segment, this.context.sampleRate);
      for (const listener of this.listeners) listener(downsampled);
    }
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
  const processor = context.createScriptProcessor(4096, 2, 2);
  source.connect(processor);
  processor.connect(context.destination);
  return new AudioCapturePipeline(video, context, source, processor);
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
    setSegmentSeconds: (seconds) => pipeline.setSegmentSeconds(seconds),
    release: () => {
      if (released) return;
      released = true;
      pipeline.removeListener(listener);
      if (pipeline.listenerCount > 0) return;

      schedulePipelineDisposal(video, entry, pipeline);
    },
  };
}
