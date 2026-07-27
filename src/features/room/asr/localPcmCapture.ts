const LOCAL_ASR_SAMPLE_RATE_HZ = 16_000;
const LOCAL_ASR_BATCH_SAMPLES = 8_000;
const WORKLET_PROCESSOR_NAME = "rlive-local-asr-pcm";

type AudioContextConstructor = new () => AudioContext;

type WebkitAudioContextWindow = Window & {
  webkitAudioContext?: AudioContextConstructor;
};

export type LocalPcmCapture = {
  /** The media element this graph owns. A media source node cannot be recreated for it. */
  readonly video: HTMLVideoElement;
  /** Keep the listener's audible level independent from the ASR input branch. */
  setPresentationLevel: (volume: number, muted: boolean) => void;
  /** Resume the graph. Call this directly from a user gesture when possible. */
  resume: () => Promise<void>;
  /** Start or stop forwarding 16 kHz mono PCM without tearing down speaker output. */
  setCapturing: (capturing: boolean) => Promise<void>;
  /** Dispose only when the underlying <video> is permanently being replaced. */
  dispose: () => void;
};

type LocalPcmCaptureOptions = {
  video: HTMLVideoElement;
  onPcm: (samples: Int16Array) => void;
};

/**
 * AudioWorklet runs at the browser's render quantum, but crosses to the UI
 * thread only every 500ms. That keeps IPC churn far below the 128-frame audio
 * callback cadence while still leaving the native recognizer responsive.
 */
const WORKLET_SOURCE = String.raw`
class RliveLocalAsrPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const configuredRate = Number(options.processorOptions && options.processorOptions.targetSampleRate);
    const configuredBatch = Number(options.processorOptions && options.processorOptions.batchSamples);
    this.targetSampleRate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : 16000;
    this.batchSamples = Number.isFinite(configuredBatch) && configuredBatch > 0 ? Math.floor(configuredBatch) : 8000;
    this.sourceFramesPerOutput = sampleRate / this.targetSampleRate;
    this.nextSourceFrame = 0;
    this.samples = new Int16Array(this.batchSamples);
    this.offset = 0;
    this.enabled = false;
    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === "enabled") {
        this.enabled = Boolean(event.data.enabled);
        if (!this.enabled) this.reset();
      } else if (type === "reset") {
        this.reset();
      }
    };
  }

  reset() {
    this.nextSourceFrame = 0;
    this.offset = 0;
  }

  push(value) {
    const normalized = Math.max(-1, Math.min(1, value));
    this.samples[this.offset++] = normalized < 0
      ? Math.ceil(normalized * 32768)
      : Math.round(normalized * 32767);
    if (this.offset !== this.samples.length) return;
    const completed = this.samples;
    this.samples = new Int16Array(this.batchSamples);
    this.offset = 0;
    this.port.postMessage({ type: "pcm", samples: completed }, [completed.buffer]);
  }

  process(inputs, outputs) {
    // Keep the analysis branch silent. It is connected through a zero-gain
    // sink only so Chromium keeps this input-driven worklet alive.
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }

    if (!this.enabled) return true;
    const input = inputs[0];
    const frameCount = input && input[0] ? input[0].length : 0;
    if (frameCount === 0) return true;

    // Linear interpolation is inexpensive and handles common 44.1/48 kHz
    // output devices without assuming an integer decimation ratio. Mix every
    // available channel before resampling so the native side always receives
    // exactly 16 kHz mono signed PCM.
    while (this.nextSourceFrame < frameCount) {
      const left = Math.floor(this.nextSourceFrame);
      const right = Math.min(left + 1, frameCount - 1);
      const fraction = this.nextSourceFrame - left;
      let mixed = 0;
      let channels = 0;
      for (const channel of input) {
        if (!channel) continue;
        mixed += channel[left] + (channel[right] - channel[left]) * fraction;
        channels += 1;
      }
      if (channels > 0) this.push(mixed / channels);
      this.nextSourceFrame += this.sourceFramesPerOutput;
    }
    this.nextSourceFrame -= frameCount;
    return true;
  }
}

registerProcessor("${WORKLET_PROCESSOR_NAME}", RliveLocalAsrPcmProcessor);
`;

const workletModuleLoads = new WeakMap<AudioContext, Promise<void>>();

function localAsrError(message: string): Error {
  return new Error(message);
}

function createAudioContext(): AudioContext {
  const AudioContextClass =
    window.AudioContext ?? (window as WebkitAudioContextWindow).webkitAudioContext;
  if (!AudioContextClass) {
    throw localAsrError("当前播放器环境不支持本地字幕音频捕获");
  }
  return new AudioContextClass();
}

function loadWorkletModule(context: AudioContext): Promise<void> {
  const existing = workletModuleLoads.get(context);
  if (existing) return existing;
  if (!context.audioWorklet) {
    return Promise.reject(localAsrError("当前播放器环境不支持 AudioWorklet 本地字幕捕获"));
  }

  const moduleBlob = new Blob([WORKLET_SOURCE], { type: "text/javascript" });
  const moduleUrl = URL.createObjectURL(moduleBlob);
  const loading = context.audioWorklet.addModule(moduleUrl).finally(() => {
    URL.revokeObjectURL(moduleUrl);
  });
  workletModuleLoads.set(context, loading);
  return loading;
}

function normalizePresentationVolume(volume: number, muted: boolean): number {
  if (muted || !Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(1, volume / 100));
}

/**
 * Create the one reusable media graph for a video element.
 *
 * `createMediaElementSource()` is intentionally called once per `<video>`.
 * From that point browser audio is routed through `presentationGain`, which
 * stays connected even with captions disabled. The worklet is a separate,
 * full-volume branch and is disconnected when local subtitles are off.
 */
export function createLocalPcmCapture({ video, onPcm }: LocalPcmCaptureOptions): LocalPcmCapture {
  const context = createAudioContext();
  const source = context.createMediaElementSource(video);
  const presentationGain = context.createGain();
  const analysisSink = context.createGain();
  analysisSink.gain.value = 0;

  source.connect(presentationGain);
  presentationGain.connect(context.destination);

  let disposed = false;
  let captureRequested = false;
  let captureConnected = false;
  let worklet: AudioWorkletNode | null = null;

  const workletReady = loadWorkletModule(context).then(() => {
    if (disposed) return;
    worklet = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: "max",
      processorOptions: {
        targetSampleRate: LOCAL_ASR_SAMPLE_RATE_HZ,
        batchSamples: LOCAL_ASR_BATCH_SAMPLES,
      },
    });
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (disposed || !captureRequested) return;
      const payload = event.data as { type?: unknown; samples?: unknown } | null;
      if (payload?.type !== "pcm" || !(payload.samples instanceof Int16Array)) return;
      if (payload.samples.length > 0) onPcm(payload.samples);
    };
    worklet.connect(analysisSink);
    analysisSink.connect(context.destination);
  });
  // A model-status check can reject before captions ever ask this graph to
  // capture. Retain the rejection for a later user-facing start attempt, but
  // do not let that speculative module load surface as an unhandled promise.
  void workletReady.catch(() => {});

  const ensureAudibleMediaLevel = () => {
    // MediaElementAudioSourceNode should remain at unity gain. The listener's
    // requested mute/volume is applied exclusively by presentationGain, so
    // the ASR branch always receives the original decoded stream.
    if (video.volume !== 1) video.volume = 1;
    if (video.muted) video.muted = false;
  };

  return {
    video,
    setPresentationLevel: (volume, muted) => {
      if (disposed) return;
      presentationGain.gain.value = normalizePresentationVolume(volume, muted);
      ensureAudibleMediaLevel();
    },
    resume: async () => {
      if (disposed || context.state === "closed") {
        throw localAsrError("本地字幕音频会话已结束");
      }
      if (context.state !== "running") await context.resume();
    },
    setCapturing: async (capturing) => {
      captureRequested = capturing && !disposed;
      if (!captureRequested) {
        if (worklet) {
          worklet.port.postMessage({ type: "enabled", enabled: false });
          if (captureConnected) {
            try {
              source.disconnect(worklet);
            } catch {
              // A media source can already be disconnecting while a room
              // route changes. Its primary output branch remains intact.
            }
            captureConnected = false;
          }
        }
        return;
      }

      await workletReady;
      if (disposed || !captureRequested || !worklet) return;
      worklet.port.postMessage({ type: "reset" });
      worklet.port.postMessage({ type: "enabled", enabled: true });
      if (!captureConnected) {
        source.connect(worklet);
        captureConnected = true;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      captureRequested = false;
      if (worklet) {
        worklet.port.onmessage = null;
        try {
          worklet.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        presentationGain.disconnect();
        analysisSink.disconnect();
      } catch {
        /* already disconnected */
      }
      if (context.state !== "closed") {
        void context.close().catch(() => {
          // Video teardown may already be closing this graph with WebView2.
        });
      }
    },
  };
}
