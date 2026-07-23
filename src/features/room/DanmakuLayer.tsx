import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "../../shared/types/live";
import { useSettingsStore } from "../../shared/stores/settingsStore";
import { invokeCmd } from "../../shared/api/tauri";

const MAX_LIST = 100;

type DanmakuLayerProps = {
  active: boolean;
  /**
   * `osd` — draw on mpv video via show-text (works with embed).
   * `list` — chat log under/over host (HTML).
   * `both` — default: OSD on video + short HTML trail.
   */
  mode?: "osd" | "list" | "both";
};

export function DanmakuLayer({ active, mode = "both" }: DanmakuLayerProps) {
  const [list, setList] = useState<DanmakuEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastOsdAt = useRef(0);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const opacity = useSettingsStore((s) => s.danmakuOpacity);

  const shieldLower = useMemo(
    () => shieldWords.map((w) => w.toLowerCase()).filter(Boolean),
    [shieldWords],
  );

  useEffect(() => {
    if (!active) {
      setList([]);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled) return;
      const msg = event.payload;
      if (!msg || typeof msg.content !== "string" || !msg.content.trim()) return;
      if (msg.kind === "system") return;

      const text = msg.content.toLowerCase();
      if (shieldLower.some((w) => text.includes(w))) return;

      const line =
        msg.kind === "super_chat"
          ? `【SC】${msg.user}: ${msg.content}`
          : `${msg.user}: ${msg.content}`;

      // HTML list (always keep for chat history strip)
      if (mode === "list" || mode === "both") {
        setList((prev) => {
          const next = [...prev, msg];
          if (next.length > MAX_LIST) return next.slice(next.length - MAX_LIST);
          return next;
        });
      }

      // OSD on embedded mpv (throttle to avoid spam)
      if (mode === "osd" || mode === "both") {
        const now = Date.now();
        if (now - lastOsdAt.current >= 280) {
          lastOsdAt.current = now;
          void invokeCmd("player_show_danmaku", {
            text: line.slice(0, 60),
            durationMs: 3200,
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
  }, [active, shieldLower, mode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [list.length]);

  if (!active) return null;

  // Compact chat strip along the bottom of the host (doesn't fight mpv z-order
  // for the main area; OSD handles on-video text).
  if (mode === "osd") return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 flex flex-col justify-end overflow-hidden"
      style={{ opacity }}
    >
      <div className="max-h-full space-y-0.5 overflow-hidden px-2 pb-2 pt-6 [mask-image:linear-gradient(to_bottom,transparent,black_35%)]">
        {list.slice(-12).map((line, i) => (
          <div
            key={`${line.ts}-${i}-${line.user}`}
            className="truncate text-left drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
            style={{
              fontSize: Math.max(12, (fontSize || 16) - 2),
              color: line.color || "#fff",
            }}
          >
            <span className="mr-1 opacity-70">{line.user}</span>
            <span>{line.content}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
