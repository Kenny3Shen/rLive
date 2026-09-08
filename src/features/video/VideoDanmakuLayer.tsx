import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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
import {
  DanmakuActionMenu,
  type DanmakuHoverTarget,
} from "@/features/room/danmaku/DanmakuActionMenu";
import {
  releaseDanmuJsPin,
  removeDanmuJsPin,
  resumeDanmuJsPin,
} from "@/features/room/danmaku/danmuJsPin";
import { useDanmakuPinInteraction } from "@/features/room/danmaku/useDanmakuPinInteraction";
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
  interactive?: boolean;
  cid?: number;
  aid?: string;
  title?: string;
  large?: boolean;
  tapMaxDistance?: number;
};

/** 判定为 seek 的时间跳变阈值。正常播放每次 timeupdate 推进约 250ms。 */
const SEEK_JUMP_SECONDS = 1.2;

export function VideoDanmakuLayer({
  videoRef,
  entries,
  active,
  interactive = true,
  cid = 0,
  aid = "",
  title,
  large = false,
  tapMaxDistance,
}: VideoDanmakuLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<DanmuJsInstance | null>(null);
  const recordsRef = useRef(new Map<string, { entry: VideoDanmakuEntry; element: HTMLElement }>());
  const selectedIdRef = useRef<string | null>(null);
  const [target, setTarget] = useState<DanmakuHoverTarget | null>(null);
  const fontSize = clampDanmuFontSize(useSettingsStore((state) => state.danmakuFontSize));
  const fontStroke = clampDanmuFontStroke(useSettingsStore((state) => state.danmakuFontStroke));
  const opacity = clampDanmuOpacity(useSettingsStore((state) => state.danmakuOpacity));
  const speed = parseDanmakuSpeed(useSettingsStore((state) => state.danmakuSpeed));
  const area = clampDanmuArea(useSettingsStore((state) => state.danmakuArea));
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);

  const releaseSelection = useCallback((dropped = false) => {
    const id = selectedIdRef.current;
    if (!id) return;
    selectedIdRef.current = null;
    setTarget(null);
    const element = recordsRef.current.get(id)?.element;
    if (element) {
      delete element.dataset.rliveDanmakuSelected;
      element.style.removeProperty("z-index");
    }
    const instance = instanceRef.current;
    if (!instance) return;
    if (dropped) releaseDanmuJsPin(instance, id);
    else if (!resumeDanmuJsPin(instance, id)) removeDanmuJsPin(instance, id);
    // VOD 只恢复单条弹幕，不调用 play()，保持媒体原有的暂停状态。
  }, []);

  const measureTarget = useCallback((id: string): DanmakuHoverTarget | null => {
    const host = hostRef.current;
    const record = recordsRef.current.get(id);
    if (!host || !record?.element.isConnected) return null;
    const content = record.element.querySelector("[data-rlive-danmaku-content]") ?? record.element;
    const rect = content.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      hoverKey: id,
      content: record.entry.content,
      user: "",
      eventKind: "chat",
      left: rect.left - hostRect.left,
      top: rect.top - hostRect.top,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  useDanmakuPinInteraction({
    hostRef,
    enabled: active && interactive,
    tapMaxDistance,
    selectedId: target?.hoverKey ?? null,
    hasBullet: (id) => recordsRef.current.has(id),
    selectBullet: (id, element) => {
      releaseSelection();
      instanceRef.current?.freezeComment(id);
      selectedIdRef.current = id;
      element.dataset.rliveDanmakuSelected = "true";
      setTarget(measureTarget(id));
    },
    releaseSelection,
  });

  const selectedId = target?.hoverKey ?? null;
  useEffect(() => {
    if (!selectedId) return;
    const id = selectedId;
    let frame = 0;
    const update = () => {
      const next = measureTarget(id);
      if (!next) {
        releaseSelection();
        return;
      }
      setTarget((current) =>
        current &&
        current.hoverKey === id &&
        (current.left !== next.left ||
          current.top !== next.top ||
          current.width !== next.width ||
          current.height !== next.height)
          ? next
          : current,
      );
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [selectedId, measureTarget, releaseSelection]);

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
    const visible = filterVideoDanmakuEntries(entries, (content) =>
      // 复用直播的屏蔽词匹配器需要一个 DanmakuEvent 形状；VOD 弹幕只有文本，
      // 因此合成一条最小事件而不是在这里另写一套匹配。
      isShielded({ kind: "chat", user: "", content, color: null, ts: 0 }),
    );

    const visibleById = new Map(visible.map((entry) => [entry.id, entry]));
    const records = recordsRef.current;

    /** 把游标对齐到某个播放位置，并清空屏幕上按旧时间轴投放的 bullet。 */
    function realign(positionMs: number) {
      releaseSelection(true);
      records.clear();
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
          mouseControlPause: false,
          needResizeObserver: true,
          // 弹幕元素必须由 bulletCreateEl 钩子创建：comment 带 `elLazyInit` 时
          // danmu.js 在 attach 阶段完全依赖该钩子产出元素，缺了它 `this.el`
          // 是 undefined，appendChild 直接抛 TypeError（直播层注册的就是同一个）。
          hooks: {
            bulletCreateEl: (comment) => createDanmuBulletElement(comment),
            bulletAttached: (comment, element) => {
              const entry = visibleById.get(comment.id);
              if (entry) records.set(comment.id, { entry, element });
            },
            bulletDetached: (comment, element) => {
              if (records.get(comment.id)?.element !== element) return;
              if (selectedIdRef.current === comment.id) releaseSelection(true);
              records.delete(comment.id);
            },
          },
          // 仅文字接收指针，空白区域仍穿透到播放器。
          containerStyle: { pointerEvents: "none" },
        });
        instanceRef.current = danmu;
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
      releaseSelection(true);
      records.clear();
      instanceRef.current = null;
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
  }, [
    active,
    area,
    cid,
    entries,
    fontSize,
    fontStroke,
    opacity,
    shieldWords,
    speed,
    videoRef,
    releaseSelection,
  ]);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      <div
        ref={containerRef}
        aria-hidden
        data-video-danmaku-layer
        className="pointer-events-none absolute inset-0 size-full overflow-hidden"
      />
      {target && active && interactive && (
        <div className="pointer-events-none absolute inset-0 z-40">
          <div
            aria-hidden
            data-rlive-danmaku-selection
            className="pointer-events-none absolute box-border border border-white/90"
            style={{
              left: target.left,
              top: target.top,
              width: target.width,
              height: target.height,
            }}
          />
          <DanmakuActionMenu
            key={target.hoverKey}
            target={target}
            siteId="bilibili"
            roomTitle={title}
            video={{
              cid,
              aid,
              getProgressMs: () => (videoRef.current?.currentTime ?? 0) * 1_000,
            }}
            large={large}
          />
        </div>
      )}
    </div>
  );
}
