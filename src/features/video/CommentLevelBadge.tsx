import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const levelColors: Record<number, string> = {
  1: "text-comment-level-1",
  2: "text-comment-level-2",
  3: "text-comment-level-3",
  4: "text-comment-level-4",
  5: "text-comment-level-5",
  6: "text-comment-level-6",
};

/** 等级保留文字语义；未知正整数沿用 Lv1 的中性色，不冒充最高等级。 */
export function CommentLevelBadge({ level }: { level: number }) {
  if (!Number.isInteger(level) || level <= 0) return null;

  return (
    <Badge
      variant="outline"
      role="img"
      aria-label={`用户等级 Lv${level}`}
      data-comment-level={level}
      // 16px 行高 + 细边框不撑高昵称行，底色与描边随主题的等级前景色派生。
      className={cn(
        "h-auto rounded-sm border-current/25 bg-current/10 px-1 py-0 text-[11px] leading-4 font-semibold",
        levelColors[level] ?? levelColors[1],
      )}
    >
      Lv{level}
    </Badge>
  );
}
