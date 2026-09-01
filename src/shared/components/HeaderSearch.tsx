import { Search } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadRouteModule } from "@/app/routeModules";

/** 打开专门的搜索页，而不是扩展内联头部表单。 */
export function HeaderSearch() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  if (pathname !== "/") return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="搜索主播、房间号、标题"
            // 粗指针下的光学右对齐。icon 按钮被 `min-w-11` 撑到 44px 宽，16px 的
            // 图标居中后两侧各藏 14px 不可见空白；ghost 无底色，用户看到的
            // 「按钮」只是那枚图标 —— 它距离内容右缘还差这 14px。负右外边距把
            // 按钮盒拉进头部的右侧内边距，图标右缘于是落在内容边缘上，与房间
            // 卡片的右缘齐平；命中区顺势外扩到距屏幕边缘 2px 处，不越出视口。
            // 分类条右端的「全部分类」与本按钮上下相邻，共用同一档偏移，两枚
            // 图标因此在移动端依旧共线。细指针下按钮只有 32px 宽，此偏移
            // 不成立，桌面端维持原位。
            className="[@media(pointer:coarse)]:-mr-3.5"
            onPointerEnter={() => preloadRouteModule("/search")}
            onPointerDown={() => preloadRouteModule("/search")}
            onFocus={() => preloadRouteModule("/search")}
            onClick={() => navigate("/search")}
          />
        }
      >
        <Search />
      </TooltipTrigger>
      <TooltipContent>搜索主播、房间号、标题</TooltipContent>
    </Tooltip>
  );
}
