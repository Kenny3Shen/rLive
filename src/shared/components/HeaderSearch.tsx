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
