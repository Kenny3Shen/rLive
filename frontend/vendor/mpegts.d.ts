/** Types for the vendored `mpegts.js` prebuild in `./mpegts.js`. */
export interface MediaDataSource {
  type: string;
  isLive?: boolean;
  url: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  cors?: boolean;
  withCredentials?: boolean;
}

export interface Config {
  enableWorker?: boolean;
  enableStashBuffer?: boolean;
  stashInitialSize?: number;
  liveBufferLatencyChasing?: boolean;
  liveBufferLatencyMaxLatency?: number;
  liveBufferLatencyMinRemain?: number;
  autoCleanupSourceBuffer?: boolean;
}

export interface Player {
  attachMediaElement(el: HTMLMediaElement): void;
  detachMediaElement(): void;
  load(): void;
  unload(): void;
  play(): Promise<void>;
  pause(): void;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export interface MpegtsStatic {
  createPlayer(mediaDataSource: MediaDataSource, config?: Config): Player;
  getFeatureList(): {
    mseLivePlayback: boolean;
    mseH265Playback: boolean;
    networkStreamIO: boolean;
  };
  isSupported(): boolean;
  Events: {
    ERROR: string;
    LOADING_COMPLETE: string;
    RECOVERED_EARLY_EOF: string;
    MEDIA_INFO: string;
    STATISTICS_INFO: string;
  };
}

declare const mpegts: MpegtsStatic;
export default mpegts;
