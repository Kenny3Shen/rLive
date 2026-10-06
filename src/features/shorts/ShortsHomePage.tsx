import { ChevronRight } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { BILIBILI_SHORTS_PATH, DOUYIN_SHORTS_PATH, SHORTS_SEED_PARAM } from "./shortsFeed";

const platforms = [
  {
    siteId: "bilibili",
    title: "B 站短视频",
    to: BILIBILI_SHORTS_PATH,
  },
  {
    siteId: "douyin",
    title: "抖音短视频",
    to: DOUYIN_SHORTS_PATH,
  },
] as const;

/** 只选平台，不挂载推荐查询或播放器；旧 seed 深链仍直达 B 站。 */
export function ShortsHomePage() {
  const [searchParams] = useSearchParams();
  if (searchParams.get(SHORTS_SEED_PARAM)?.trim()) {
    return <Navigate to={`${BILIBILI_SHORTS_PATH}?${searchParams.toString()}`} replace />;
  }

  return (
    <section
      data-slot="shorts-home"
      aria-labelledby="shorts-home-title"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6"
    >
      <header className="flex flex-col gap-2">
        <h1 id="shorts-home-title" className="font-heading text-2xl font-semibold tracking-tight">
          短视频
        </h1>
      </header>
      <nav aria-label="短视频平台" className="grid gap-4 sm:grid-cols-2">
        {platforms.map(({ siteId, title, to }) => (
          <Link
            key={siteId}
            to={to}
            data-player-origin={`shorts:${siteId}`}
            aria-label={title}
            className="rounded-xl outline-none hover:ring-2 hover:ring-primary/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Card className="h-full">
              <CardHeader>
                <SiteLogo siteId={siteId} className="mb-3 size-10" />
                <CardTitle>
                  <h2>{title}</h2>
                </CardTitle>
              </CardHeader>
              <CardFooter className="justify-between gap-3">
                <span>进入推荐流</span>
                <ChevronRight aria-hidden="true" className="size-4" />
              </CardFooter>
            </Card>
          </Link>
        ))}
      </nav>
    </section>
  );
}
