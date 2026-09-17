import { useState } from "react";
import { Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SearchHistoryField } from "@/shared/components/SearchHistoryField";
import { cn } from "@/lib/utils";
import { VIDEO_SEARCH_QUERY_PARAM, videoSearchPath } from "./videoRoute";

/**
 * Shell 头部的视频查询条。
 *
 * 关键词住在 URL（`?q=`，与直播搜索页同一取向）：条在 Shell、结果在路由页，
 * 两者不共享状态也能对齐——提交即导航，返回/前进时草稿跟着 URL 回放。
 *
 * 历史记忆与浮层交给 `SearchHistoryField`（直播搜索页共用同一份实现）。
 */

/** 视频搜索历史独立成键，与直播搜索历史互不污染。 */
const SEARCH_HISTORY_KEY = "video_search_history";

export function VideoSearchBar({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const keyword = (params.get(VIDEO_SEARCH_QUERY_PARAM) ?? "").trim();
  const [draft, setDraft] = useState(keyword);

  // 返回/前进到别的关键词时，草稿跟随 URL 回放：渲染期调整模式。
  const [prevKeyword, setPrevKeyword] = useState(keyword);
  if (keyword !== prevKeyword) {
    setPrevKeyword(keyword);
    setDraft(keyword);
  }

  return (
    <SearchHistoryField
      historyKey={SEARCH_HISTORY_KEY}
      value={draft}
      onValueChange={setDraft}
      committedKeyword={keyword}
      placeholder="搜索 B 站视频…"
      ariaLabel="搜索视频"
      autoFocusWhenEmpty
      className={cn("h-full min-w-0 flex-1", className)}
      inputGroupClassName="h-9"
      onSubmit={(next) => {
        // 空态页被结果页替换而不是压栈：头部的返回键会把结果页替换回空搜索页
        // （见 Shell 的 goBackToVideo），若空态压栈会在它下面再垫一层空白；
        // 浏览器/硬件返回也因此从结果直达来源页。已有结果时换词仍正常压栈。
        if (next !== keyword) navigate(videoSearchPath(next), { replace: !keyword });
      }}
    >
      <Button type="submit" className="h-9 shrink-0" disabled={!draft.trim()}>
        <Search className="size-4" aria-hidden />
        搜索
      </Button>
    </SearchHistoryField>
  );
}
