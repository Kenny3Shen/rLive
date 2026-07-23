export type PlayerUiMode = "windowed" | "fullscreen";
export type EmbedMode = "child" | "geometry" | "window";

export type PlayerStatus = {
  running: boolean;
  mpv_path: string;
  paused: boolean;
  volume: number;
  embed_mode: EmbedMode;
  mode: PlayerUiMode;
};
