import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
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
import { removeDanmuJsComment } from "@/features/room/danmaku/danmuJsCompat";
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
  VIDEO_DANMAKU_FIXED_DURATION_MS,
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
 *
 * 弹幕只在两种情况下离开画面：滚动弹幕飘完全程，固定弹幕到达媒体时间时长。暂停、
 * 关闭弹幕、新分段到达都不清屏——关闭只是把这一层调成透明，调度照常进行，重新打开
 * 时屏上就是「一直开着」会看到的那些弹幕。
 */

type VideoDanmakuLayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  entries: readonly VideoDanmakuEntry[];
  /** 弹幕开关。关闭时仅隐藏并停止点选，实例与调度保持运行。 */
  active: boolean;
  interactive?: boolean;
  cid?: number;
  aid?: string;
  title?: string;
  large?: boolean;
  tapMaxDistance?: number;
  /**
   * 额外字号缩放（1 = 完全按设置）。竖屏舞台用它把弹幕整体缩小一档：字号设置是
   * 全应用一份，而同样的 px 在占满整块视口的短视频舞台上明显偏大。缩放同时作用于
   * 行高（`danmuLaneHeight`），轨道高度因此跟着缩，不会出现「字小了但轨道还是原来
   * 那么高」的空隙。
   */
  fontSizeScale?: number;
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
  fontSizeScale = 1,
}: VideoDanmakuLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<DanmuJsInstance | null>(null);
  const recordsRef = useRef(new Map<string, { entry: VideoDanmakuEntry; element: HTMLElement }>());
  const selectedIdRef = useRef<string | null>(null);
  const [target, setTarget] = useState<DanmakuHoverTarget | null>(null);
  const fontSize = clampDanmuFontSize(
    useSettingsStore((state) => state.danmakuFontSize) * fontSizeScale,
  );
  const fontStroke = clampDanmuFontStroke(useSettingsStore((state) => state.danmakuFontStroke));
  const opacity = clampDanmuOpacity(useSettingsStore((state) => state.danmakuOpacity));
  const speed = parseDanmakuSpeed(useSettingsStore((state) => state.danmakuSpeed));
  const area = clampDanmuArea(useSettingsStore((state) => state.danmakuArea));
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);

  // 可投放条目走 ref 而不进实例 effect 的依赖：新分段到达、屏蔽词变化都会换一份
  // 数组，若因此重建实例，屏上正在飘的弹幕会被整屏清掉。
  const schedule = useMemo(() => {
    const isShielded = createShieldMatcher(shieldWords);
    const visible = filterVideoDanmakuEntries(entries, (content) =>
      // 复用直播的屏蔽词匹配器需要一个 DanmakuEvent 形状；VOD 弹幕只有文本，
      // 因此合成一条最小事件而不是在这里另写一套匹配。
      isShielded({ kind: "chat", user: "", content, color: null, ts: 0 }),
    );
    return { visible, byId: new Map(visible.map((entry) => [entry.id, entry])) };
  }, [entries, shieldWords]);
  const scheduleRef = useRef(schedule);
  useLayoutEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

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

  // 关闭弹幕时解除点选：被定住的那条应当和其他弹幕一样在不可见状态下继续飘。
  useEffect(() => {
    if (!active) releaseSelection();
  }, [active, releaseSelection]);

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;
    // 闭包里再引用 `videoRef.current` 会重新变成可空；绑定一个局部常量，
    // 让下面所有回调共享上面这道判空。
    const media = video;

    let disposed = false;
    let danmu: DanmuJsInstance | null = null;
    // 已投放到哪个下标。seek 后必须重置，否则跳转后的弹幕会接着旧游标继续投，
    // 表现为「弹幕停在跳转前的位置」或成片错位。
    let cursor = 0;
    // 游标对应的条目列表。条目列表换了（新分段合并、屏蔽词变化）就按
    // `nextFromMs` 重新定位游标，而不是清屏：已投放的条目都早于它，不会重投。
    let cursorList = scheduleRef.current.visible;
    // 下一条待投放条目的最早时间：早于它的条目已经投过（或因跳转而不再投）。
    let nextFromMs = 0;
    let lastPositionMs = 0;
    const records = recordsRef.current;
    // 在屏固定弹幕的到期时间（媒体时间，毫秒）。danmu.js 的固定弹幕计时不受
    // `pause()` 控制（见 `VIDEO_DANMAKU_FIXED_DURATION_MS`），这里按媒体时间接管。
    const fixedExpiry = new Map<string, number>();

    /** 把游标对齐到某个播放位置，并清空屏幕上按旧时间轴投放的 bullet。 */
    function realign(positionMs: number) {
      releaseSelection(true);
      records.clear();
      fixedExpiry.clear();
      cursorList = scheduleRef.current.visible;
      cursor = firstVideoDanmakuAtOrAfter(cursorList, positionMs);
      nextFromMs = positionMs;
      lastPositionMs = positionMs;
      danmu?.clear();
    }

    function currentPositionMs(): number {
      return Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime * 1_000) : 0;
    }

    /** 移除已到期的固定弹幕。被点选定住的保留到解除后的下一次检查。 */
    function expireFixed(positionMs: number) {
      if (!danmu) return;
      for (const [id, expiresAtMs] of fixedExpiry) {
        if (positionMs < expiresAtMs || selectedIdRef.current === id) continue;
        fixedExpiry.delete(id);
        removeDanmuJsComment(danmu, id);
      }
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
      expireFixed(positionMs);
      const latest = scheduleRef.current.visible;
      if (latest !== cursorList) {
        cursorList = latest;
        cursor = firstVideoDanmakuAtOrAfter(cursorList, nextFromMs);
      }
      const next = nextVideoDanmakuBatch(cursorList, cursor, positionMs);
      cursor = next.cursor;
      // 条目时间是整数毫秒，本次已投到 `<= positionMs` 的全部条目。
      nextFromMs = Math.floor(positionMs) + 1;
      for (const entry of next.batch) {
        danmu.sendComment(
          videoDanmakuComment(entry, { fontSize, fontStroke, opacity, moveV: speed }),
        );
        // 车道已满时 danmu.js 会丢弃这条，只给真正上屏的固定弹幕登记到期。
        if (entry.mode !== "scroll" && records.has(entry.id)) {
          fixedExpiry.set(entry.id, entry.progressMs + VIDEO_DANMAKU_FIXED_DURATION_MS);
        }
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
              const entry = scheduleRef.current.byId.get(comment.id);
              if (entry) records.set(comment.id, { entry, element });
            },
            bulletDetached: (comment, element) => {
              if (records.get(comment.id)?.element !== element) return;
              if (selectedIdRef.current === comment.id) releaseSelection(true);
              records.delete(comment.id);
              fixedExpiry.delete(comment.id);
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
      fixedExpiry.clear();
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
  }, [area, cid, fontSize, fontStroke, opacity, speed, videoRef, releaseSelection]);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      {/*
        关闭弹幕只调透明度，不用 `display: none`：danmu.js 按容器尺寸算车道与位移，
        尺寸归零会把车道重排成 0 条。也不用 `visibility: hidden`：固定弹幕自己写着
        `visibility` transition，子节点的取值会盖过父级。不可见时把所有后代的命中
        一并关掉，透明的弹幕文字不能抢走播放器的点按。
      */}
      <div
        ref={containerRef}
        aria-hidden
        data-video-danmaku-layer
        data-visible={active}
        className="pointer-events-none absolute inset-0 overflow-hidden data-[visible=false]:opacity-0 data-[visible=false]:[&_*]:pointer-events-none!"
        style={{ top: "var(--video-danmaku-top, 0px)" }}
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
