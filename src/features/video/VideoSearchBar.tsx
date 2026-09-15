import { useEffect, useId, useRef, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent } from "@/components/ui/popover";
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

/** 读历史；键不存在或数据损坏时按空历史处理。 */
function readSearchHistory(): string[] {
  try {
    const stored = localStorage.getItem(SEARCH_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/** 写历史；存储不可用时静默（历史是纯增益，不该打断搜索）。 */
function writeSearchHistory(history: string[]): void {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 存储失败时静默
  }
}

export function VideoSearchBar({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const keyword = (params.get(VIDEO_SEARCH_QUERY_PARAM) ?? "").trim();
  const [draft, setDraft] = useState(keyword);
  const [history, setHistory] = useState<string[]>(readSearchHistory);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const historyPanelId = useId();

  // 返回/前进到别的关键词时，草稿跟随 URL 回放：渲染期调整模式。
  const [prevKeyword, setPrevKeyword] = useState(keyword);
  if (keyword !== prevKeyword) {
    setPrevKeyword(keyword);
    setDraft(keyword);
  }

  // 空态进入（如从视频页头部点搜索图标）自动聚焦，直接开打关键词。
  useEffect(() => {
    if (!keyword) inputRef.current?.focus();
  }, [keyword]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    // 最新在前、去重、截断；写完直接用这份列表（读回同一份数据）。
    const updated = [trimmed, ...history.filter((item) => item !== trimmed)].slice(
      0,
      MAX_HISTORY_ITEMS,
    );
    writeSearchHistory(updated);
    setHistory(updated);
    setShowHistory(false);
    // 空态页被结果页替换而不是压栈：头部的返回键会把结果页替换回空搜索页
    // （见 Shell 的 goBackToVideo），若空态压栈会在它下面再垫一层空白；
    // 浏览器/硬件返回也因此从结果直达来源页。已有结果时换词仍正常压栈。
    if (trimmed !== keyword) navigate(videoSearchPath(trimmed), { replace: !keyword });
  };

  const handleHistoryClick = (item: string) => {
    setDraft(item);
    setShowHistory(false);
    if (item !== keyword) navigate(videoSearchPath(item), { replace: !keyword });
  };

  const handleClearHistory = () => {
    writeSearchHistory([]);
    setHistory([]);
  };

  // 删除单条后下拉保持展开，便于连续清理；删空后由 history.length 条件自动收起。
  const handleRemoveHistoryItem = (item: string) => {
    const updated = history.filter((entry) => entry !== item);
    writeSearchHistory(updated);
    setHistory(updated);
  };

  // 只在空态（尚未出结果）弹出，绝不会盖住结果卡片。
  const historyOpen = showHistory && history.length > 0 && !keyword;

  return (
    <div className={cn("flex min-w-0 items-center", className)}>
      <form onSubmit={handleSubmit} className="flex h-full min-w-0 flex-1 items-center gap-2">
        <Popover
          open={historyOpen}
          // 输入框自己就是 trigger：不套 PopoverTrigger —— 它的 useButton 会给
          // 容器盖上 role="button"，而 button 里裹 textbox 是坏语义。用 triggerId
          // 登记，否则受控 popup 停在 data-starting-style 上永远不过渡进场。
          triggerId={inputId}
          onOpenChange={(next, details) => {
            if (next) return;
            // 焦点始终留在输入框（浮层之外），Base UI 因此把两件事误判成关闭：
            // 点输入框挪光标算 outside press，聚焦输入框算 focus out。
            // 只要事件仍落在这块字段里就不是真的离开，否则光标一点历史就没了。
            const stillInField =
              details.reason === "outside-press" || details.reason === "focus-out"
                ? details.event.target instanceof Node &&
                  (fieldRef.current?.contains(details.event.target) ||
                    fieldRef.current?.contains(document.activeElement))
                : false;
            if (stillInField) return;
            setShowHistory(false);
          }}
        >
          <InputGroup ref={fieldRef} className="h-9 min-w-0 flex-1">
            <InputGroupInput
              id={inputId}
              ref={inputRef}
              type="text"
              placeholder="搜索 B 站视频…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setShowHistory(true)}
              aria-label="搜索视频"
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
              aria-controls={historyOpen ? historyPanelId : undefined}
              autoComplete="off"
            />
            {draft && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="清除输入"
                  onClick={() => {
                    setDraft("");
                    inputRef.current?.focus();
                  }}
                >
                  <X aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          {/* 焦点留在输入框：下拉是提示而非取值控件，开合都不该打断打字。 */}
          <PopoverContent
            id={historyPanelId}
            anchor={fieldRef}
            align="start"
            aria-label="搜索历史"
            initialFocus={false}
            finalFocus={false}
            className="w-(--anchor-width) gap-0 overflow-hidden p-0"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs text-muted-foreground">搜索历史</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={handleClearHistory}
                className="h-auto p-0 text-xs"
              >
                清空
              </Button>
            </div>
            <div className="max-h-60 overflow-y-auto">
              {history.map((item) => (
                <div key={item} className="flex items-center gap-1 px-3 py-2 hover:bg-muted">
                  <button
                    type="button"
                    onClick={() => handleHistoryClick(item)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                  >
                    <Search className="size-3.5 text-muted-foreground" aria-hidden />
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
          </PopoverContent>
        </Popover>
        <Button type="submit" className="h-9 shrink-0" disabled={!draft.trim()}>
          <Search className="size-4" aria-hidden />
          搜索
        </Button>
      </form>
    </div>
  );
}
