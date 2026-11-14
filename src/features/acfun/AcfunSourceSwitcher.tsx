import { useNavigate } from "react-router-dom";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function AcfunSourceSwitcher({
  source,
  className,
}: {
  source: "bilibili" | "acfun";
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <Tabs
      value={source}
      onValueChange={(value) => {
        if (value === source) return;
        navigate(value === "acfun" ? "/video?source=acfun" : "/video");
      }}
      aria-label="视频内容平台"
      className={cn("h-full w-fit shrink-0 gap-0", className)}
    >
      <TabsList variant="line" className="h-full!">
        {(["bilibili", "acfun"] as const).map((id) => {
          const label = id === "bilibili" ? "哔哩哔哩" : "AcFun";
          return (
            <TabsTrigger
              value={id}
              className="h-full px-3 max-md:min-w-0 max-md:flex-none max-md:px-2"
              aria-label={label}
              title={label}
              key={id}
            >
              <SiteLogo siteId={id} className="size-4" />
              <span>{label}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
