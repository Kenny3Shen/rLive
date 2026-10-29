import { Button } from "@/components/ui/button";
import { commentTimestampSegments } from "./commentTimestamp";

/**
 * 把正文里的 `01:23` / `1:02:03` 渲染成可点击的时间按钮，评论与简介共用。
 *
 * 返回的函数交给 `LinkText.renderText`，因此只作用在 URL 以外的正文上；
 * `stopPropagation` 让点击只做空降，不连带触发打开评论详情或收起简介。
 * 调用方没有 `onSeek` 时不要调用它，保持纯文本。
 */
export function renderTimestampText(onSeek: (seconds: number) => void) {
  return (text: string) =>
    commentTimestampSegments(text).map((segment, index) =>
      segment.kind === "text" ? (
        segment.text
      ) : (
        <Button
          key={index}
          variant="link"
          className="h-auto p-0 align-baseline [@media(pointer:coarse)]:min-h-0"
          aria-label={`跳转到 ${segment.text}`}
          title={`空降到 ${segment.text}`}
          onClick={(event) => {
            event.stopPropagation();
            onSeek(segment.seconds);
          }}
        >
          {segment.text}
        </Button>
      ),
    );
}
