import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { CalendarDays, ChartNoAxesCombined, History, RefreshCw, Tv2 } from "lucide-react";
import { invokeCmd } from "@/shared/api/tauri";
import { ErrorState } from "@/shared/components/ErrorState";
import { PageHeader } from "@/shared/components/PageHeader";
import { isSiteEnabled } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { HistoryItem } from "@/shared/types/live";
import { cn, SITE_LABELS } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { aggregateViewingRecordStatistics } from "./statistics";

const dailyChartConfig = {
  recordCount: {
    label: "观看记录",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const platformChartConfig = {
  recordCount: {
    label: "观看记录",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

function formatShortDate(value: string): string {
  const [, month, day] = value.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : value;
}

function formatFullDate(value: string): string {
  const [, month, day] = value.split("-");
  return month && day ? `${Number(month)} 月 ${Number(day)} 日` : value;
}

function platformLabel(siteId: string): string {
  return SITE_LABELS[siteId] ?? siteId;
}

function StatisticsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="正在加载观看统计">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} size="sm">
            <CardHeader>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(17rem,0.85fr)]">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function StatisticsPage() {
  const navigate = useNavigate();
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const query = useQuery({
    queryKey: ["history"],
    queryFn: () => invokeCmd<HistoryItem[]>("history_list"),
  });

  const items = useMemo(
    () => (query.data ?? []).filter((item) => isSiteEnabled(item.site_id, disabledSiteIds)),
    [disabledSiteIds, query.data],
  );
  const statistics = useMemo(() => aggregateViewingRecordStatistics(items), [items]);
  const recentRecordCount = useMemo(
    () => statistics.last7Days.reduce((sum, day) => sum + day.recordCount, 0),
    [statistics.last7Days],
  );

  const summaryCards = [
    {
      label: "已存观看记录",
      value: statistics.totalRecords,
      hint: `覆盖 ${statistics.distinctRooms} 个直播间`,
      Icon: History,
      iconClassName: "text-primary",
    },
    {
      label: "今日观看记录",
      value: statistics.todayRecords,
      hint: "按当前日期归档",
      Icon: CalendarDays,
      iconClassName: "text-chart-2",
    },
    {
      label: "最近 7 天",
      value: recentRecordCount,
      hint: "最近打开的直播间记录",
      Icon: ChartNoAxesCombined,
      iconClassName: "text-chart-3",
    },
    {
      label: "涉及平台",
      value: statistics.distinctPlatforms,
      hint: "已展示启用的平台记录",
      Icon: Tv2,
      iconClassName: "text-chart-5",
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <PageHeader
        title="观看统计"
        description="根据本机保存的观看记录汇总，不包含观看时长。"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {query.isFetching ? "刷新中…" : "刷新"}
          </Button>
        }
      />

      {query.isLoading && <StatisticsSkeleton />}

      {query.isError && (
        <ErrorState
          error={query.error}
          title="观看统计加载失败"
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && items.length === 0 && (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartNoAxesCombined aria-hidden />
            </EmptyMedia>
            <EmptyTitle>暂无观看记录</EmptyTitle>
            <EmptyDescription>打开直播间后会产生观看记录，并在这里形成趋势图。</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => navigate("/")}>去首页看看</Button>
        </Empty>
      )}

      {!query.isLoading && !query.isError && items.length > 0 && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="观看记录概览">
            {summaryCards.map(({ label, value, hint, Icon, iconClassName }) => (
              <Card key={label} size="sm">
                <CardHeader>
                  <CardDescription className="flex items-center gap-2">
                    <Icon className={cn("size-4", iconClassName)} aria-hidden />
                    {label}
                  </CardDescription>
                  <CardTitle className="font-mono text-2xl font-semibold tabular-nums">
                    {value.toLocaleString("zh-CN")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </CardContent>
              </Card>
            ))}
          </section>

          <section
            className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(17rem,0.85fr)]"
            aria-label="观看记录图表"
          >
            <Card>
              <CardHeader>
                <CardTitle>最近 7 天观看记录</CardTitle>
                <CardDescription>
                  按记录日期汇总；同一直播间仅保留最近一次进入记录。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={dailyChartConfig} className="h-64 w-full aspect-auto">
                  <AreaChart
                    accessibilityLayer
                    data={statistics.last7Days}
                    margin={{ left: 4, right: 8, top: 12 }}
                  >
                    <defs>
                      <linearGradient id="statistics-viewing-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-recordCount)" stopOpacity={0.34} />
                        <stop
                          offset="95%"
                          stopColor="var(--color-recordCount)"
                          stopOpacity={0.02}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={10}
                      minTickGap={16}
                      tickFormatter={formatShortDate}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(label) =>
                            typeof label === "string" ? formatFullDate(label) : String(label ?? "")
                          }
                        />
                      }
                    />
                    <Area
                      dataKey="recordCount"
                      type="monotone"
                      fill="url(#statistics-viewing-fill)"
                      fillOpacity={1}
                      stroke="var(--color-recordCount)"
                      strokeWidth={2}
                      activeDot={{ r: 4 }}
                    />
                  </AreaChart>
                </ChartContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>平台分布</CardTitle>
                <CardDescription>按已保存的观看记录统计。</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={platformChartConfig} className="h-64 w-full aspect-auto">
                  <BarChart
                    accessibilityLayer
                    data={statistics.platformDistribution}
                    layout="vertical"
                    margin={{ left: 0, right: 12, top: 6, bottom: 6 }}
                  >
                    <CartesianGrid horizontal={false} />
                    <YAxis
                      dataKey="siteId"
                      type="category"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={10}
                      width={88}
                      tickFormatter={platformLabel}
                    />
                    <XAxis dataKey="recordCount" type="number" hide />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          labelFormatter={(label) =>
                            typeof label === "string" ? platformLabel(label) : String(label ?? "")
                          }
                        />
                      }
                    />
                    <Bar dataKey="recordCount" fill="var(--color-recordCount)" radius={5} />
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
