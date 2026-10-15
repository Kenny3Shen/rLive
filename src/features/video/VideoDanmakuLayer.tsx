import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { DanmakuRenderer } from "@/features/room/danmaku/danmakuRenderer";
import type { DanmakuComment } from "@/features/room/danmaku/danmakuTypes";
import {
  clampDanmuArea,
  clampDanmuFontSize,
  clampDanmuFontStroke,
  clampDanmuOpacity,
  danmuLaneHeight,
} from "@/features/room/danmaku/danmakuAdapter";
import { loadDanmakuRenderer } from "@/features/room/danmaku/danmakuLoader";
import {
  DanmakuActionMenu,
  type DanmakuHoverTarget,
} from "@/features/room/danmaku/DanmakuActionMenu";
import { useDanmakuPinInteraction } from "@/features/room/danmaku/useDanmakuPinInteraction";
import { createShieldMatcher } from "@/features/room/danmaku/filter";
import { prefersReducedMotion } from "@/shared/motion/preference";
import { parseDanmakuSpeed, useSettingsStore } from "@/shared/stores/settingsStore";
import {
  filterVideoDanmakuEntries,
  videoDanmakuComment,
  type VideoDanmakuEntry,
} from "./videoDanmaku";

/**
 * VOD 与直播共用 `danmu` DOM 引擎、富文本样式和点选交互。
 * 媒体直接绑定渲染器，投放、暂停、缓冲等待、倍速和 seek 共用原生媒体时间轴，
 * 不再在 timeupdate 上维护第二份游标、位置推算或固定弹幕到期计时。
 * 关闭只隐藏并禁用命中，分段增量更新也不清屏，已经上屏的弹幕保留到正常结束。
 */
type VideoDanmakuLayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  entries: readonly VideoDanmakuEntry[];
  /** 关闭时仅隐藏并停止点选，实例与调度保持运行。 */
  active: boolean;
  interactive?: boolean;
  cid?: number;
  aid?: string;
  title?: string;
  large?: boolean;
  tapMaxDistance?: number;
  /** 竖屏舞台的额外字号缩放，同步作用于字体、行高和轨道占用。 */
  fontSizeScale?: number;
};

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
  const instanceRef = useRef<DanmakuRenderer | null>(null);
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

  const schedule = useMemo(() => {
    const isShielded = createShieldMatcher(shieldWords);
    const visible = filterVideoDanmakuEntries(entries, (content) =>
      isShielded({ kind: "chat", user: "", content, color: null, ts: 0 }),
    );
    return { visible, byId: new Map(visible.map((entry) => [entry.id, entry])) };
  }, [entries, shieldWords]);
  /**
   * 按 id 缓存转换结果。分段加载会让 `entries` 每次换新引用，但合并保留了条目本身，
   * 重算全部条目的样式对象是纯浪费。外观参数变化时 key 失配自然重建；
   * 同时淘汰已不在列表里的 id，长视频下不会随段落累积无界增长。
   */
  const [commentCache] = useState(() => new Map<string, { key: string; comment: DanmakuComment }>());
  const scheduleComments = useMemo(() => {
    // 减少动态效果时用正常媒体时长的顶部弹幕代替近乎静止、长期占道的滚动弹幕。
    const reducedMotion = prefersReducedMotion();
    const key = `${fontSize}|${fontStroke}|${opacity}|${reducedMotion}`;
    const list: DanmakuComment[] = [];
    const byId = new Map<string, DanmakuComment>();
    for (const entry of schedule.visible) {
      const cached = commentCache.get(entry.id);
      let comment: DanmakuComment;
      if (cached && cached.key === key) {
        comment = cached.comment;
      } else {
        comment = videoDanmakuComment(entry, { fontSize, fontStroke, opacity, reducedMotion });
        commentCache.set(entry.id, { key, comment });
      }
      list.push(comment);
      byId.set(entry.id, comment);
    }
    for (const id of Array.from(commentCache.keys())) if (!byId.has(id)) commentCache.delete(id);
    return { list, byId };
  }, [schedule, fontSize, fontStroke, opacity, commentCache]);
  const latestRef = useRef({ schedule, scheduleComments, speed, area, fontSize });
  useLayoutEffect(() => {
    latestRef.current = { schedule, scheduleComments, speed, area, fontSize };
  }, [schedule, scheduleComments, speed, area, fontSize]);

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
    // seek/remove/destroy 自己清理被丢弃的记录；普通解除不改变媒体的暂停状态。
    if (!dropped) instanceRef.current?.unpin(id);
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
      if (!instanceRef.current?.pin(id)) return;
      selectedIdRef.current = id;
      element.dataset.rliveDanmakuSelected = "true";
      setTarget(measureTarget(id));
    },
    releaseSelection,
  });

  const selectedId = target?.hoverKey ?? null;
  useEffect(() => {
    if (!selectedId) return;
    let frame = 0;
    const update = () => {
      const next = measureTarget(selectedId);
      if (!next) {
        releaseSelection();
        return;
      }
      setTarget((current) =>
        current &&
        current.hoverKey === selectedId &&
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
    if (!active) releaseSelection();
  }, [active, releaseSelection]);

  /**
   * 已推送到渲染器时间轴的 id → 当时的弹幕对象。分段加载只增不减时走增量 `appendComments`，
   * 避免每次取回新段都重建整条时间轴；条目减少（屏蔽词命中）或外观参数变化（字号、描边、
   * 透明度、减少动态效果）会产出新对象，此时必须整体替换，否则已上屏节点拿不到新样式。
   */
  const pushedRef = useRef(new Map<string, DanmakuComment>());
  const syncComments = useCallback((renderer: DanmakuRenderer) => {
    const { list, byId } = latestRef.current.scheduleComments;
    const pushed = pushedRef.current;
    let appendOnly = pushed.size <= byId.size;
    if (appendOnly) {
      for (const [id, comment] of pushed) {
        if (byId.get(id) !== comment) {
          appendOnly = false;
          break;
        }
      }
    }
    if (appendOnly) renderer.appendComments(list);
    else renderer.setComments(list);
    pushed.clear();
    for (const comment of list) pushed.set(comment.id, comment);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const media = videoRef.current;
    if (!container || !media) return;
    let disposed = false;
    let renderer: DanmakuRenderer | null = null;
    const records = recordsRef.current;
    // 新建实例的时间轴是空的，上一轮（或上一条视频）的推送记录不能复用。
    pushedRef.current = new Map();
    void loadDanmakuRenderer()
      .then((Renderer) => {
        if (disposed) return;
        const latest = latestRef.current;
        renderer = new Renderer({
          container,
          media,
          speed: latest.speed,
          area: latest.area,
          laneHeight: danmuLaneHeight(latest.fontSize),
          onAttach: (comment, element) => {
            const entry = latestRef.current.schedule.byId.get(comment.id);
            if (entry) records.set(comment.id, { entry, element });
          },
          onDetach: (id) => {
            if (selectedIdRef.current === id) releaseSelection(true);
            records.delete(id);
          },
        });
        instanceRef.current = renderer;
        syncComments(renderer);
      })
      .catch((error: unknown) => {
        renderer?.destroy();
        if (instanceRef.current === renderer) instanceRef.current = null;
        records.clear();
        // 弹幕初始化失败不影响视频播放，但保留诊断信息。
        if (!disposed) console.error("Unable to initialize VOD Danmaku", error);
      });
    return () => {
      disposed = true;
      releaseSelection(true);
      instanceRef.current = null;
      renderer?.destroy();
      records.clear();
    };
  }, [cid, videoRef, releaseSelection, syncComments]);

  // 仅更新原生时间轴；到来的新分段、屏蔽词和设置变化均不重建实例或清除在途弹幕。
  useEffect(() => {
    const renderer = instanceRef.current;
    if (renderer) syncComments(renderer);
  }, [scheduleComments, syncComments]);
  useEffect(() => {
    instanceRef.current?.setSpeed(speed);
  }, [speed]);
  useEffect(() => {
    instanceRef.current?.setArea(area);
  }, [area]);
  useEffect(() => {
    instanceRef.current?.setLaneHeight(danmuLaneHeight(fontSize));
  }, [fontSize]);
  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      {/* 不用 renderer.hide()：其原生语义会清屏；这里只隐藏且禁用全部后代命中。 */}
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
            video={{ cid, aid, getProgressMs: () => (videoRef.current?.currentTime ?? 0) * 1_000 }}
            large={large}
          />
        </div>
      )}
    </div>
  );
}
