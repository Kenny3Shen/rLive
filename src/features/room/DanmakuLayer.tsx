import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "../../shared/types/live";
import { useSettingsStore } from "../../shared/stores/settingsStore";

const MAX_LINES = 80;

type DanmakuLayerProps = {
  active: boolean;
};

export function DanmakuLayer({ active }: DanmakuLayerProps) {
  const [lines, setLines] = useState<DanmakuEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const opacity = useSettingsStore((s) => s.danmakuOpacity);

  const shieldLower = useMemo(
    () => shieldWords.map((w) => w.toLowerCase()).filter(Boolean),
    [shieldWords],
  );

  useEffect(() => {
    if (!active) {
      setLines([]);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled) return;
      const msg = event.payload;
      if (!msg || typeof msg.content !== "string") return;
      const text = msg.content.toLowerCase();
      if (shieldLower.some((w) => text.includes(w))) return;
      setLines((prev) => {
        const next = [...prev, msg];
        if (next.length > MAX_LINES) return next.slice(next.length - MAX_LINES);
        return next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, shieldLower]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  if (!active) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 top-1/3 flex flex-col justify-end overflow-hidden"
      style={{ opacity }}
    >
      <div className="max-h-full space-y-0.5 overflow-y-auto px-3 pb-3 pt-8 [mask-image:linear-gradient(to_bottom,transparent,black_20%)]">
        {lines.map((line, i) => (
          <div
            key={`${line.ts}-${i}-${line.user}`}
            className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
            style={{
              fontSize: fontSize || 16,
              color: line.color || "#fff",
            }}
          >
            <span className="mr-1.5 opacity-70">{line.user}</span>
            <span>{line.content}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
