import { useEffect, useRef, useState, type UIEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { invokeCmd } from "@/shared/api/tauri";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { isShielded } from "./danmaku/filter";
import { cn } from "@/lib/utils";

const MAX = 400;

type DanmakuPanelProps = {
  active: boolean;
  /** Also push OSD onto embedded mpv video. */
  osd?: boolean;
  className?: string;
  statusText?: string | null;
};

export function DanmakuPanel({
  active,
  osd = true,
  className,
  statusText,
}: DanmakuPanelProps) {
  const [items, setItems] = useState<DanmakuEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastOsdAt = useRef(0);
  const autoScroll = useRef(true);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);

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
      if (isShielded(msg, shieldWords)) return;

      setItems((prev) => {
        const next = [...prev, msg];
        return next.length > MAX ? next.slice(next.length - MAX) : next;
      });

      if (osd && msg.kind !== "system") {
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
  }, [active, shieldWords, osd]);

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
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <ScrollArea className="min-h-0 flex-1">
        <div
          className="flex flex-col gap-0.5 px-2.5 py-2"
          onScroll={onScroll}
          style={{ fontSize: Math.max(12, (fontSize || 16) - 2) }}
        >
          {statusText && (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              {statusText}
            </p>
          )}
          {!active && !statusText && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              进入直播间后显示弹幕
            </p>
          )}
          {active && items.length === 0 && !statusText && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              等待弹幕…
            </p>
          )}
          {items.map((line, i) => {
            if (line.kind === "system") {
              return (
                <div
                  key={`${line.ts}-${i}-sys`}
                  className="px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {line.content}
                </div>
              );
            }
            if (line.kind === "enter") {
              return (
                <div
                  key={`${line.ts}-${i}-enter`}
                  className="px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {line.content}
                </div>
              );
            }
            return (
              <div
                key={`${line.ts}-${i}-${line.user}`}
                className="rounded-md px-1.5 py-1 leading-relaxed hover:bg-muted/50"
              >
                <span
                  className="mr-1.5 font-medium text-primary"
                  style={line.color ? { color: line.color } : undefined}
                >
                  {line.user}
                </span>
                {line.kind === "super_chat" && (
                  <Badge variant="secondary" className="mr-1 align-middle">
                    SC
                  </Badge>
                )}
                {line.kind === "gift" && (
                  <Badge variant="outline" className="mr-1 align-middle">
                    礼物
                  </Badge>
                )}
                <span className="text-foreground/90">{line.content}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
