import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "../../shared/types/live";
import { useSettingsStore } from "../../shared/stores/settingsStore";
import { invokeCmd } from "../../shared/api/tauri";

const MAX = 300;

type DanmakuPanelProps = {
  active: boolean;
  /** Also push OSD onto embedded mpv video. */
  osd?: boolean;
};

export function DanmakuPanel({ active, osd = true }: DanmakuPanelProps) {
  const [items, setItems] = useState<DanmakuEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastOsdAt = useRef(0);
  const autoScroll = useRef(true);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);

  const shieldLower = useMemo(
    () => shieldWords.map((w) => w.toLowerCase()).filter(Boolean),
    [shieldWords],
  );

  useEffect(() => {
    if (!active) {
      setItems([]);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled) return;
      const msg = event.payload;
      if (!msg?.content?.trim()) return;
      if (msg.kind === "system") return;
      const lower = msg.content.toLowerCase();
      if (shieldLower.some((w) => lower.includes(w))) return;

      setItems((prev) => {
        const next = [...prev, msg];
        return next.length > MAX ? next.slice(next.length - MAX) : next;
      });

      if (osd) {
        const now = Date.now();
        if (now - lastOsdAt.current >= 250) {
          lastOsdAt.current = now;
          const line =
            msg.kind === "super_chat"
              ? `【SC】${msg.user}: ${msg.content}`
              : `${msg.user}: ${msg.content}`;
          void invokeCmd("player_show_danmaku", {
            text: line.slice(0, 72),
            durationMs: 3000,
          }).catch(() => {});
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, shieldLower, osd]);

  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [items.length]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScroll.current = dist < 48;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <h3 className="text-sm font-semibold">弹幕</h3>
        <span className="text-xs text-zinc-500">{items.length}</span>
      </div>
      <div
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2"
        onScroll={onScroll}
      >
        {!active && (
          <p className="px-1 text-xs text-zinc-500">进入直播间后显示弹幕</p>
        )}
        {active && items.length === 0 && (
          <p className="px-1 text-xs text-zinc-500">等待弹幕…</p>
        )}
        {items.map((line, i) => (
          <div
            key={`${line.ts}-${i}-${line.user}`}
            className="rounded px-1.5 py-0.5 leading-snug hover:bg-zinc-100 dark:hover:bg-zinc-800/80"
            style={{ fontSize: Math.max(12, (fontSize || 16) - 2) }}
          >
            <span
              className="mr-1 font-medium"
              style={{ color: line.color || undefined }}
            >
              {line.user}
            </span>
            {line.kind === "super_chat" && (
              <span className="mr-1 rounded bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-300">
                SC
              </span>
            )}
            <span className="text-zinc-800 dark:text-zinc-100">{line.content}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
