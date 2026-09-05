import { useEffect, useRef, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { VIDEO_SEARCH_QUERY_PARAM, videoSearchPath } from "./videoRoute";

/**
 * Shell 头部的视频查询条。
 *
 * 关键词住在 URL（`?q=`，与直播搜索页同一取向）：条在 Shell、结果在路由页，
 * 两者不共享状态也能对齐——提交即导航，返回/前进时草稿跟着 URL 回放。
 */

const SEARCH_HISTORY_KEY = "video_search_history";
const MAX_HISTORY_ITEMS = 10;

function getSearchHistory(): string[] {
  try {
    const stored = localStorage.getItem(SEARCH_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(keyword: string) {
  try {
    const history = getSearchHistory();
    const filtered = history.filter((item) => item !== keyword);
    const updated = [keyword, ...filtered].slice(0, MAX_HISTORY_ITEMS);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
  } catch {
    // 存储失败时静默
  }
}

function clearSearchHistory() {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    // 清除失败时静默
  }
}

function removeSearchHistory(keyword: string) {
  try {
    const updated = getSearchHistory().filter((item) => item !== keyword);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
  } catch {
    // 删除失败时静默
  }
}

export function VideoSearchBar({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const keyword = (params.get(VIDEO_SEARCH_QUERY_PARAM) ?? "").trim();
  const [draft, setDraft] = useState(keyword);
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 返回/前进到别的关键词时，草稿跟随 URL 回放。
  useEffect(() => {
    setDraft(keyword);
  }, [keyword]);

  // 空态进入（如从视频页头部点搜索图标）自动聚焦，直接开打关键词。
  useEffect(() => {
    if (!keyword) inputRef.current?.focus();
  }, [keyword]);

  useEffect(() => {
    setHistory(getSearchHistory());
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    saveSearchHistory(trimmed);
    setHistory(getSearchHistory());
    setShowHistory(false);
    // 空态页被结果页替换而不是压栈：从视频页点搜索图标进来时，返回键直接回到
    // 来源页，而不是落回一个空白的搜索页。已有结果时换词仍正常压栈。
    if (trimmed !== keyword) navigate(videoSearchPath(trimmed), { replace: !keyword });
  };

  const handleHistoryClick = (item: string) => {
    setDraft(item);
    setShowHistory(false);
    if (item !== keyword) navigate(videoSearchPath(item), { replace: !keyword });
  };

  const handleClearHistory = () => {
    clearSearchHistory();
    setHistory([]);
  };

  // 删除单条后下拉保持展开，便于连续清理；删空后由 history.length 条件自动收起。
  const handleRemoveHistoryItem = (item: string) => {
    removeSearchHistory(item);
    setHistory(getSearchHistory());
  };

  return (
    <div className={cn("relative flex min-w-0 items-center", className)}>
      <form onSubmit={handleSubmit} className="flex h-full min-w-0 flex-1 items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Input
            ref={inputRef}
            type="text"
            placeholder="搜索 B 站视频…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setShowHistory(true)}
            className="h-9 w-full min-w-0"
            aria-label="搜索视频"
            autoComplete="off"
          />
          {draft && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="清除输入"
            >
              <X className="size-4" />
            </button>
          )}
          {/* 搜索历史下拉：只在空态（尚未出结果）弹出，绝不会盖住结果卡片。 */}
          {showHistory && history.length > 0 && !keyword && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-xs text-muted-foreground">搜索历史</span>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  className="text-xs text-primary hover:underline"
                >
                  清空
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto">
                {history.map((item) => (
                  <div key={item} className="flex items-center gap-1 px-3 py-2 hover:bg-muted">
                    <button
                      type="button"
                      onClick={() => handleHistoryClick(item)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                    >
                      <Search className="size-3.5 text-muted-foreground" />
                      <span className="flex-1 truncate">{item}</span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`删除搜索历史“${item}”`}
                      onClick={() => handleRemoveHistoryItem(item)}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <Button type="submit" className="h-9 shrink-0" disabled={!draft.trim()}>
          <Search className="size-4" aria-hidden />
          搜索
        </Button>
      </form>
    </div>
  );
}
