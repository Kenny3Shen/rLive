import { useMemo, useState } from "react";
import { Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IptvSearchInput } from "./IptvHeaderControls";
import { filterIptvChannels } from "./filterChannels";
import type { IptvChannel } from "./types";

const SIDEBAR_CHANNEL_PAGE_SIZE = 120;

type IptvChannelSidebarProps = {
  channels: readonly IptvChannel[];
  currentUrl: string | null;
  sourceLabel: string;
  onSelect: (channel: IptvChannel) => void;
};

/** 播放页频道列表：搜索复用发现页的防抖输入，列表增量渲染防止数千频道一次性挂载。 */
export function IptvChannelSidebar({
  channels,
  currentUrl,
  sourceLabel,
  onSelect,
}: IptvChannelSidebarProps) {
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(SIDEBAR_CHANNEL_PAGE_SIZE);
  const filtered = useMemo(
    () => filterIptvChannels(channels, { group: "all", query: keyword }),
    [channels, keyword],
  );
  const displayed = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

  // 搜索词变化时回到第一页：渲染期调整模式。
  const [prevSidebarKeyword, setPrevSidebarKeyword] = useState(keyword);
  if (keyword !== prevSidebarKeyword) {
    setPrevSidebarKeyword(keyword);
    setLimit(SIDEBAR_CHANNEL_PAGE_SIZE);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
      <div className="flex shrink-0 items-baseline justify-between gap-2 px-1">
        <span className="text-xs font-medium text-muted-foreground" title={sourceLabel}>
          频道列表 · {sourceLabel}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {filtered.length}
        </span>
      </div>
      <IptvSearchInput keyword={keyword} onChange={setKeyword} className="shrink-0" />
      {filtered.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有符合条件的频道</p>
      ) : (
        <ul
          aria-label="IPTV 频道列表"
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-contain pb-1"
        >
          {displayed.map((channel) => {
            const active = channel.url === currentUrl;
            return (
              <li key={`${channel.id}:${channel.url}`}>
                <Button
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  aria-current={active ? "true" : undefined}
                  className="w-full justify-start gap-2 px-2.5"
                  onClick={() => onSelect(channel)}
                  title={channel.name}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/60">
                    {channel.logo ? (
                      <img
                        src={channel.logo}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="size-full object-contain p-0.5"
                      />
                    ) : (
                      <Tv className="size-3.5 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{channel.name}</span>
                </Button>
              </li>
            );
          })}
          {displayed.length < filtered.length && (
            <li className="pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setLimit((current) => current + SIDEBAR_CHANNEL_PAGE_SIZE)}
              >
                显示更多（{displayed.length} / {filtered.length}）
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
