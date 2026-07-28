import { NavLink } from "react-router-dom";
import {
  ChartNoAxesCombined,
  Heart,
  History,
  Home,
  LayoutGrid,
  Moon,
  Settings,
  Sun,
  Tv,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";

const navItems: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}[] = [
  { to: "/", label: "首页", icon: Home, end: true },
  { to: "/follow", label: "关注", icon: Heart },
  { to: "/category", label: "分类", icon: LayoutGrid },
  { to: "/history", label: "历史", icon: History },
  { to: "/statistics", label: "统计", icon: ChartNoAxesCombined },
  { to: "/iptv", label: "IPTV", icon: Tv },
];

function SidebarLink({
  to,
  label,
  icon: Icon,
  end,
  className,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  className?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          "group relative flex h-10 w-10 items-center justify-center rounded-xl transition-[background-color,color,box-shadow,transform] duration-150 focus-ring max-md:h-auto max-md:min-h-12 max-md:w-auto max-md:min-w-0 max-md:flex-1 max-md:flex-col max-md:gap-0.5 max-md:rounded-lg max-md:px-1 max-md:py-1",
          className,
          isActive
            ? "bg-primary/12 text-primary ring-1 ring-primary/15 shadow-sm shadow-primary/10"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn(
              "size-5 transition-transform duration-150 group-hover:scale-105",
              isActive && "text-primary",
            )}
          />
          <span className="sr-only max-md:not-sr-only max-md:text-[10px] max-md:leading-none">
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

function AppearanceToggle() {
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const isDark =
    theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  const nextTheme = isDark ? "light" : "dark";
  const label = isDark ? "切换为浅色模式" : "切换为深色模式";
  const Icon = isDark ? Sun : Moon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8"
            aria-label={label}
            title={label}
            onClick={() => setTheme(nextTheme)}
          />
        }
      >
        <Icon data-icon="inline-start" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar() {
  return (
    <aside className="flex h-full w-[68px] shrink-0 flex-col items-center border-r border-border-subtle bg-sidebar/95 py-3 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-20 max-md:h-[calc(4.25rem+env(safe-area-inset-bottom))] max-md:w-auto max-md:flex-row max-md:border-t max-md:border-r-0 max-md:px-2 max-md:py-2 max-md:pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      <nav
        className="flex flex-1 flex-col items-center gap-2 max-md:min-w-0 max-md:flex-row max-md:justify-start max-md:gap-0 max-md:overflow-hidden"
        aria-label="主导航"
      >
        {navItems.map((item) => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </nav>
      <div className="mb-1.5 flex flex-col items-center max-md:hidden">
        <AppearanceToggle />
      </div>
      <SidebarLink
        to="/settings"
        label="设置"
        icon={Settings}
        className="max-md:w-11 max-md:flex-none"
      />
    </aside>
  );
}
