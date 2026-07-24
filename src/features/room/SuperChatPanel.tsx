import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isShielded } from "./danmaku/filter";
import { cn } from "@/lib/utils";

const MAX = 80;

type SuperChatPanelProps = {
  active: boolean;
  className?: string;
};

export function SuperChatPanel({ active, className }: SuperChatPanelProps) {
  const [items, setItems] = useState<DanmakuEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);

  const shield = useMemo(
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
      if (!msg || msg.kind !== "super_chat") return;
      if (isShielded(msg, shield)) return;
      setItems((prev) => {
        const next = [...prev, msg];
        return next.length > MAX ? next.slice(next.length - MAX) : next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, shield]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <ScrollArea className="min-h-0 flex-1">
        <div
          className="flex flex-col gap-2 px-2.5 py-2"
          style={{ fontSize: Math.max(12, (fontSize || 16) - 2) }}
        >
          {active && items.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              等待醒目留言…
            </p>
          )}
          {!active && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              进入直播间后显示 SC
            </p>
          )}
          {items.map((line, i) => (
            <div
              key={`${line.ts}-${i}-${line.user}`}
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2"
            >
              <p className="text-xs font-semibold text-amber-300">{line.user}</p>
              <p className="mt-0.5 text-sm text-foreground/95">{line.content}</p>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
