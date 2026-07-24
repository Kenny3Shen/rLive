import { NavLink } from "react-router-dom";
import { Home, Heart, LayoutGrid, History, Settings } from "lucide-react";
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
];

function SidebarLink({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          "group relative flex h-11 w-11 items-center justify-center rounded-2xl transition-all focus-ring",
          isActive
            ? "bg-sidebar-active text-foreground shadow-inner"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn(
              "h-[22px] w-[22px] transition-transform group-hover:scale-105",
              isActive && "text-primary",
            )}
          />
          <span className="sr-only">{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <aside className="flex h-full w-[68px] shrink-0 flex-col items-center border-r border-border-subtle bg-sidebar py-3">
      <div
        className="mb-4 flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/90 to-accent/80 text-sm font-bold text-white shadow-lg shadow-primary/20"
        title="rLive"
      >
        r
      </div>

      <nav className="flex flex-1 flex-col items-center gap-1.5" aria-label="主导航">
        {navItems.map((item) => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </nav>
      <SidebarLink to="/settings" label="设置" icon={Settings} />
    </aside>
  );
}
