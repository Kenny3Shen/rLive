import { useState } from "react";
import { Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { InputGroupButton } from "@/components/ui/input-group";
import { SearchHistoryField } from "@/shared/components/SearchHistoryField";
import { cn } from "@/lib/utils";
import { ACFUN_SEARCH_QUERY_PARAM, acfunSearchPath, type AcfunView } from "./acfunRoute";

const SEARCH_HISTORY_KEY: Record<AcfunView, string> = {
  video: "acfun_video_search_history",
  article: "acfun_article_search_history",
};

export function AcfunSearchBar({ className, view }: { className?: string; view: AcfunView }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const keyword = (params.get(ACFUN_SEARCH_QUERY_PARAM) ?? "").trim();
  const [draft, setDraft] = useState(keyword);
  const [previousKeyword, setPreviousKeyword] = useState(keyword);
  if (keyword !== previousKeyword) {
    setPreviousKeyword(keyword);
    setDraft(keyword);
  }

  return (
    <SearchHistoryField
      historyKey={SEARCH_HISTORY_KEY[view]}
      value={draft}
      onValueChange={setDraft}
      committedKeyword={keyword}
      placeholder={view === "video" ? "搜索 AcFun 视频…" : "搜索 AcFun 文章…"}
      ariaLabel="搜索 AcFun"
      autoFocusWhenEmpty
      className={cn("h-full min-w-0 flex-1", className)}
      inputGroupClassName="h-9"
      endAdornment={
        <InputGroupButton type="submit" size="icon-xs" aria-label="搜索" title="搜索">
          <Search aria-hidden />
        </InputGroupButton>
      }
      onSubmit={(next) => {
        if (next !== keyword) navigate(acfunSearchPath(view, next), { replace: !keyword });
      }}
    />
  );
}
