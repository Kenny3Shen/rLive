/**
 * 播放器音量记忆：会话级播放表面（视频、直播、IPTV、录制回放）共享同一份音量，
 * 重进播放页或重启应用后沿用上次的音量与静音态，而不是每次回到硬编码的 80。
 *
 * 存 localStorage 而不是走 `settings_set`：拖一次音量滑块会经过多个档位，
 * 每档都读改写 SQLite 里的单键 JSON 太重。直播线路偏好（`linePreference.ts`）
 * 已经是同一条约定。
 *
 * 两处不参与这份共享记忆：多画面按槽位各存一份音量（`multiRoomStore`，副画面默认
 * 静音是角色语义）；Android 的真实音量是系统媒体音量（由 OS 自己记住），
 * 网页层固定 100，落盘只会污染桌面端的记忆。
 */

const STORAGE_KEY = "rlive-player-volume";

/** 没有记忆时的音量，与各播放器原先硬编码的默认值一致。 */
export const DEFAULT_PLAYER_VOLUME = 80;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type PlayerVolumeMemory = {
  /** 0-100 的整数音量。 */
  volume: number;
  muted: boolean;
};

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 越界或非数值一律回落默认值：坏记录不该把播放器锁在静音或爆音上。 */
function clampVolume(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PLAYER_VOLUME;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

export function readPlayerVolume(
  storage: StorageLike | null = browserStorage(),
): PlayerVolumeMemory {
  const fallback: PlayerVolumeMemory = { volume: DEFAULT_PLAYER_VOLUME, muted: false };
  if (!storage) return fallback;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const record = parsed as Partial<PlayerVolumeMemory>;
    return {
      volume: clampVolume(record.volume),
      muted: record.muted === true,
    };
  } catch {
    return fallback;
  }
}

/**
 * 记住当前音量。
 *
 * 调用方在音量状态变化时调用即可：同一个值不会触发重渲染，因此一次拖动最多写
 * 它经过的档位数（≤ 101 次），不需要额外节流。
 */
export function rememberPlayerVolume(
  volume: number,
  muted: boolean,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  const memory: PlayerVolumeMemory = { volume: clampVolume(volume), muted };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // 隐私模式或配额耗尽：记忆是锦上添花，静默失败即可。
  }
}
