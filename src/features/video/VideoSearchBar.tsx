import { useState } from "react";
import { Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { InputGroupButton } from "@/components/ui/input-group";
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
 *
 * 提交按钮与直播搜索页同款：一枚内嵌在输入组右端的图标按钮，不写「搜索」二字。
 * 头部这条 bar 在移动端要同时容下返回键、输入框与提交键，带文字的大按钮会把
 * 输入框挤到只剩一半宽；图标在两端读法一致（放大镜就是提交），也免了「按钮比
 * 输入框还显眼」的失衡。
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
      endAdornment={
        // 与直播搜索页同款：内嵌图标提交键，不写「搜索」二字，也不做空态禁用
        // （空提交在 `SearchHistoryField` 里已被 `trim` 拦下，两页读法因此一致）。
        <InputGroupButton type="submit" size="icon-xs" aria-label="搜索" title="搜索">
          <Search aria-hidden />
        </InputGroupButton>
      }
      onSubmit={(next) => {
        // 空态页被结果页替换而不是压栈：头部的返回键会把结果页替换回空搜索页
        // （见 Shell 的 goBackToVideo），若空态压栈会在它下面再垫一层空白；
        // 浏览器/硬件返回也因此从结果直达来源页。已有结果时换词仍正常压栈。
        if (next !== keyword) navigate(videoSearchPath(next), { replace: !keyword });
      }}
    />
  );
}
