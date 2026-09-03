import { useEffect, useRef, type RefObject } from "react";
import type { DanmuJsInstance } from "danmu.js";
import {
  clampDanmuArea,
  clampDanmuFontSize,
  clampDanmuFontStroke,
  clampDanmuOpacity,
  createDanmuBulletElement,
  danmuAreaConfig,
  danmuLaneHeight,
} from "@/features/room/danmaku/danmuJsAdapter";
import { loadDanmuJs } from "@/features/room/danmaku/danmuJsLoader";
import { createShieldMatcher } from "@/features/room/danmaku/filter";
import { prefersReducedMotion } from "@/shared/motion/preference";
import { parseDanmakuSpeed, useSettingsStore } from "@/shared/stores/settingsStore";
import {
  filterVideoDanmakuEntries,
  firstVideoDanmakuAtOrAfter,
  nextVideoDanmakuBatch,
  videoDanmakuComment,
  type VideoDanmakuEntry,
} from "./videoDanmaku";

/**
 * VOD 弹幕叠加层。
 *
 * 渲染层与直播完全同源（danmu.js + `danmuJsAdapter` 的字号/透明度/区域/速度换算 +
 * 同一份屏蔽词设置），换掉的只有调度源：直播是「到达即投放」，这里是「按
 * `video.currentTime` 投放」。
 *
 * 实例以 `live: true` 创建且**不传 `player`**：danmu.js 自带的音视频同步会按
 * `comment.start` 再排一次时间轴，与我们按 currentTime 的投放叠加后，seek 之后两套
 * 时间轴必然打架。把时间基准完全收在这一层，seek 的正确性才只依赖一处逻辑。
 */

type VideoDanmakuLayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  entries: readonly VideoDanmakuEntry[];
  active: boolean;
};

/** 判定为 seek 的时间跳变阈值。正常播放每次 timeupdate 推进约 250ms。 */
const SEEK_JUMP_SECONDS = 1.2;

export function VideoDanmakuLayer({ videoRef, entries, active }: VideoDanmakuLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fontSize = clampDanmuFontSize(useSettingsStore((state) => state.danmakuFontSize));
  const fontStroke = clampDanmuFontStroke(useSettingsStore((state) => state.danmakuFontStroke));
  const opacity = clampDanmuOpacity(useSettingsStore((state) => state.danmakuOpacity));
  const speed = parseDanmakuSpeed(useSettingsStore((state) => state.danmakuSpeed));
  const area = clampDanmuArea(useSettingsStore((state) => state.danmakuArea));
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video || !active) return;
    // 闭包里再引用 `videoRef.current` 会重新变成可空；绑定一个局部常量，
    // 让下面所有回调共享上面这道判空。
    const media = video;

    let disposed = false;
    let danmu: DanmuJsInstance | null = null;
    // 已投放到哪个下标。seek 后必须重置，否则跳转后的弹幕会接着旧游标继续投，
    // 表现为「弹幕停在跳转前的位置」或成片错位。
    let cursor = 0;
    let lastPositionMs = 0;
    const isShielded = createShieldMatcher(shieldWords);
    const visible = filterVideoDanmakuEntries(entries, {
      // 复用直播的屏蔽词匹配器需要一个 DanmakuEvent 形状；VOD 弹幕只有文本，
      // 因此合成一条最小事件而不是在这里另写一套匹配。
      isShielded: (content) =>
        isShielded({ kind: "chat", user: "", content, color: null, ts: 0 }),
      // 平台等级过滤交给上游 `weight`（0 表示不启用），不在前端再造一套阈值设置。
      minWeight: 0,
      showSubtitlePool: false,
    });

    /** 把游标对齐到某个播放位置，并清空屏幕上按旧时间轴投放的 bullet。 */
    function realign(positionMs: number) {
      cursor = firstVideoDanmakuAtOrAfter(visible, positionMs);
      lastPositionMs = positionMs;
      danmu?.clear();
    }

    function currentPositionMs(): number {
      return Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime * 1_000) : 0;
    }

    function tick() {
      if (disposed || !danmu) return;
      const positionMs = currentPositionMs();
      // 反向跳转与大幅前跳都要重新对齐。正向小步进是正常播放，直接续投。
      if (Math.abs(positionMs - lastPositionMs) > SEEK_JUMP_SECONDS * 1_000) {
        realign(positionMs);
        return;
      }
      lastPositionMs = positionMs;
      const next = nextVideoDanmakuBatch(visible, cursor, positionMs);
      cursor = next.cursor;
      for (const entry of next.batch) {
        danmu.sendComment(
          videoDanmakuComment(entry, { fontSize, fontStroke, opacity, moveV: speed }),
        );
      }
    }

    function onSeeking() {
      realign(currentPositionMs());
    }
    function onPlay() {
      danmu?.play();
    }
    function onPause() {
      danmu?.pause();
    }

    void loadDanmuJs()
      .then((DanmuJs) => {
        if (disposed) return;
        danmu = new DanmuJs({
          container,
          live: true,
          area: danmuAreaConfig(area),
          channelSize: danmuLaneHeight(fontSize),
          mouseControl: false,
          needResizeObserver: true,
          // 弹幕元素必须由 bulletCreateEl 钩子创建：comment 带 `elLazyInit` 时
          // danmu.js 在 attach 阶段完全依赖该钩子产出元素，缺了它 `this.el`
          // 是 undefined，appendChild 直接抛 TypeError（直播层注册的就是同一个）。
          hooks: {
            bulletCreateEl: (comment) => createDanmuBulletElement(comment),
          },
          // 叠加层不接指针事件：点击与双击要落到播放器表面上去切播放/全屏。
          containerStyle: { pointerEvents: "none" },
        });
        // 减少动态效果下不做入场滚动：把滚动弹幕也按固定时长呈现，
        // 与录制回放叠加层的处理一致。
        if (prefersReducedMotion()) danmu.setPlayRate("scroll", 0.01);
        realign(currentPositionMs());
        if (media.paused) danmu.pause();
      })
      .catch(() => {
        // 弹幕是加分项，渲染器加载失败不该把播放页拖下水。
      });

    media.addEventListener("timeupdate", tick);
    media.addEventListener("seeking", onSeeking);
    media.addEventListener("seeked", onSeeking);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);

    return () => {
      disposed = true;
      media.removeEventListener("timeupdate", tick);
      media.removeEventListener("seeking", onSeeking);
      media.removeEventListener("seeked", onSeeking);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      try {
        danmu?.destroy();
      } catch {
        // 实例可能已经随容器卸载释放。
      }
      danmu = null;
    };
  }, [active, area, entries, fontSize, fontStroke, opacity, shieldWords, speed, videoRef]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      data-video-danmaku-layer
      className="pointer-events-none absolute inset-0 size-full overflow-hidden"
    />
  );
}
