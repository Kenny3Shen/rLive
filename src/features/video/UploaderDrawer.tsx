import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { CalendarClock, TrendingUp, VideoOff, X } from "lucide-react";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { videoUploaderVideos, type VideoUploaderOrder } from "./videoApi";
import { VideoCard } from "./VideoCard";
import { playlistItemFromVideoItem, dedupeVideoItems } from "./playlistStore";

// 行式卡片（缩略图在左）比网格卡宽，列宽下限随之放大到 22rem。
// 卡片带底色后纵向间隙从 1 提到 2：4px 下相邻两块表面几乎连成一片。
const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-x-3 gap-y-2";

/** 排序标签：按钮显示当前排序，aria 宣告点击后的目标排序。 */
const ORDER_LABELS: Record<VideoUploaderOrder, string> = {
  pubdate: "最新发布",
  click: "最多播放",
};

/**
 * 排序切换按钮的视觉高度。
 *
 * `size="sm"` 是 28px，粗指针下 button 基料的 `[@media(pointer:coarse)]:min-h-11`
 * 把它顶到 44px —— 同一行里的标题文字（24px）与关闭图标（16px）于是被它撑高，
 * 三者视觉中线虽齐，读起来却是「一个高按钮夹着两行小字」。这里用与分区 chip 同款
 * 的做法：视觉高度归控件（`min-h-0` 撤掉 44px 下限，按钮回到 28px），44px 的触摸
 * 目标挪进透明 `::after` 的外扩里，手指能碰到的范围不变。
 *
 * `::after` 纵向各外扩 8px 正好补满 28 + 8 × 2 = 44px，横向不外扩：这一行右边
 * 还有关闭按钮，横向铺开会让两者的命中区重叠（后渲染的关闭键会抢走右半边的点按）。
 */
const ORDER_BUTTON_CLASS = cn(
  "relative min-h-0 [@media(pointer:coarse)]:min-h-0",
  "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:content-['']",
);

/**
 * 打开抽屉时定位当前播放的稿件：最多自动翻到第几页。
 *
 * 投稿列表按发布时间倒序，刚看过的稿件通常就在前几页；但连播几集后当前稿件可能
 * 排得很深。翻页有成本（每页一次 WBI 签名请求）且深翻会触发上游风控，因此设上限：
 * 第 `AUTO_LOCATE_MAX_PAGE` 页仍没有就放弃，用户自己往下滚 —— 宁可没定位到，
 * 也不把一开抽屉就打出十几条请求。
 */
const AUTO_LOCATE_MAX_PAGE = 5;

type UploaderDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mid: string;
  uploaderName: string;
  /**
   * 当前播放稿件的 bvid：抽屉打开后按它定位并高亮列表里的那一条。
   * 稿件详情未到（`archive` 还在途）时传空串，定位等它到位后再做。
   */
  currentBvid?: string;
  /** 自定义挂载容器，沿 DrawerContent 的 container 类型（如播放页侧栏作用域）。 */
  container?: ComponentProps<typeof DrawerContent>["container"];
};

/**
 * UP 主投稿视频抽屉，从右侧滑出，展示指定 UP 主的视频列表。
 */
export function UploaderDrawer({
  open,
  onOpenChange,
  mid,
  uploaderName,
  currentBvid = "",
  container,
}: UploaderDrawerProps) {
  const [order, setOrder] = useState<VideoUploaderOrder>("pubdate");
  const nextOrder: VideoUploaderOrder = order === "pubdate" ? "click" : "pubdate";
  const listQuery = useInfiniteQuery({
    queryKey: ["video", "uploader", mid, order],
    queryFn: ({ pageParam }) => videoUploaderVideos(mid, pageParam, order),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
    enabled: open && mid.length > 0,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  } = listQuery;

  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  // 投稿抽屉**不**应用 UP 主屏蔽名单：这个抽屉一次只装一位 UP 主（当前稿件的
  // 作者），过滤只会得到两种结果 —— 要么原样，要么一个谎称「暂无投稿视频」的空列表。
  // 屏蔽是「别再推给我」，而点开某人的抽屉是明确要看他的投稿。
  const allItems = dedupeVideoItems(data?.pages.flatMap((page) => page.items) ?? []);
  // 点击时刻的列表快照即播放列表（投稿列表连播）。
  const playlistItems = allItems.map(playlistItemFromVideoItem);
  const playlistUploader = { mid, name: uploaderName };
  const isEmpty = !isFetching && allItems.length === 0;

  /**
   * 打开抽屉时定位当前播放的稿件。
   *
   * 连播几集后再点开 UP 主头像，当前稿件往往不在第一页；而「我在这一串里的哪个
   * 位置」正是打开这个抽屉最想确认的事。因此打开后主动找：命中就居中滚动，没命中
   * 且还有下一页就接着翻（上限 `AUTO_LOCATE_MAX_PAGE`，理由见该常量）。
   *
   * 定位只做一次：翻页落地会重跑这个 effect，靠 `locateDoneRef` 收口；用户一动手
   * （滚轮/按下）就放弃，不能把人从他正在看的地方拽走。换排序、换 UP 主时重开一轮
   * （列表整体换了）。
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  const locateDoneRef = useRef(false);
  const locateCancelledRef = useRef(false);
  /** 上一次见过的排序；用来把「刚打开」与「用户换了排序」分开。 */
  const previousOrderRef = useRef(order);

  useEffect(() => {
    if (!open) return;
    // 新一次打开：列表回到顶部并重新开始找，上一次的滚动位置不属于这一份列表。
    locateDoneRef.current = false;
    locateCancelledRef.current = false;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [open, mid]);

  useEffect(() => {
    if (!open) return;
    // 打开时的首次运行不算「换了排序」（`order` 是 state，重开时不会变）。
    if (previousOrderRef.current === order) return;
    previousOrderRef.current = order;
    // 换排序＝换一份列表：回到顶部，且不再为它自动翻页找当前稿件。
    // 最多 5 页的上限留给「刚打开抽屉」那一次，换排序连点会成倍放大请求。
    locateDoneRef.current = true;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [order, open]);

  useEffect(() => {
    if (!open || locateDoneRef.current || locateCancelledRef.current) return;
    // 稿件详情未到（`archive` 在途）时没有可比对的 bvid，等它到位再找。
    if (!currentBvid) return;
    const list = listRef.current;
    if (!list) return;
    const target = list.querySelector<HTMLElement>(
      `[data-uploader-video="${CSS.escape(currentBvid)}"]`,
    );
    if (target) {
      // 只改本层 `scrollTop`，不用 `scrollIntoView`：后者会沿祖先链向上滚动每一层
      // 可滚动祖先（包括抽屉背后的页面），与选集列表同一条理由。
      const listBox = list.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      list.scrollTop += targetBox.top - listBox.top - (list.clientHeight - targetBox.height) / 2;
      locateDoneRef.current = true;
      return;
    }
    // 在途时不判「找不到」：下一页落地后 effect 会重跑。
    if (isFetching || isFetchingNextPage) return;
    // 翻页失败不再自己重试：与 `useInfiniteScroll` 同一取向，失败的请求只由
    // 用户显式操作重试，否则这个 effect 会跟着每次失败重渲染一直发请求。
    if (isFetchNextPageError) {
      locateDoneRef.current = true;
      return;
    }
    const loadedPages = data?.pages.length ?? 0;
    if (!hasNextPage || loadedPages >= AUTO_LOCATE_MAX_PAGE) {
      // 翻到头（或到了自设上限）仍没有：停手，用户自己往下滚。
      locateDoneRef.current = true;
      return;
    }
    void fetchNextPage();
  }, [
    currentBvid,
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchNextPageError,
    isFetchingNextPage,
    open,
  ]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        side="right"
        container={container}
        className="w-[min(48rem,90vw)] overflow-hidden"
      >
        <div className="flex h-full flex-col">
          {/* 标题栏 */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pb-3">
            <DrawerTitle className="min-w-0 break-words">{uploaderName} 的投稿</DrawerTitle>
            <div className="flex shrink-0 items-center gap-1">
              {/* 排序切换：与亮暗模式切换同款点按翻转，不走弹出菜单。 */}
              <Button
                variant="outline"
                size="sm"
                className={ORDER_BUTTON_CLASS}
                aria-label={`切换为${ORDER_LABELS[nextOrder]}排序`}
                aria-pressed={order === "click"}
                onClick={() => setOrder(nextOrder)}
              >
                {order === "pubdate" ? (
                  <CalendarClock data-icon="inline-start" aria-hidden />
                ) : (
                  <TrendingUp data-icon="inline-start" aria-hidden />
                )}
                {ORDER_LABELS[order]}
              </Button>
              <DrawerClose
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="关闭">
                    <X />
                  </Button>
                }
              />
            </div>
          </div>

          {/* 视频列表。滚动容器自己带 ref：定位当前稿件时只改它的 `scrollTop`。 */}
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto pt-4"
            // 用户一动手就放弃定位：正在滚列表的人不需要被程序拽回当前稿件。
            onWheel={() => {
              locateCancelledRef.current = true;
            }}
            onPointerDown={() => {
              locateCancelledRef.current = true;
            }}
          >
            {error ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : isEmpty ? (
              <Empty className="min-h-56 py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <VideoOff aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>暂无投稿视频</EmptyTitle>
                  <EmptyDescription>这位 UP 主还没有公开投稿。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : allItems.length > 0 ? (
              <>
                <div className={GRID_CLASS}>
                  {allItems.map((item) => {
                    // 当前播放的稿件加一圈主色描边：定位滚动只是把人送到这里，
                    // 送到之后还得一眼认出是哪一条。
                    const isCurrent = currentBvid !== "" && item.bvid === currentBvid;
                    return (
                      <div
                        key={`${item.bvid}:${item.cid ?? ""}`}
                        data-uploader-video={item.bvid}
                        data-uploader-current={isCurrent ? "" : undefined}
                        className={cn(
                          // `self-start`：描边画在外层包装上，包装不能被行高拉高，
                          // 否则同一行里较矮的卡片会在下方多出一圈描边。
                          "min-w-0 self-start rounded-xl",
                          // 描边画在内侧（`-outline-offset-2`）：卡片自己填满这一格，
                          // 向外扩的描边会被滚动容器的横向裁剪切掉两端。
                          isCurrent && "outline-2 -outline-offset-2 outline-primary/70",
                        )}
                      >
                        <VideoCard
                          item={item}
                          playlist={playlistItems}
                          playlistUploader={playlistUploader}
                          onNavigate={() => onOpenChange(false)}
                          orientation="row"
                          showAuthor={false}
                        />
                      </div>
                    );
                  })}
                </div>
                {hasNextPage && (
                  <div ref={loadMoreRef} className="flex justify-center py-6">
                    {isFetchingNextPage && <Spinner className="size-6" />}
                  </div>
                )}
                {!supportsIntersectionObserver && hasNextPage && (
                  <div className="flex justify-center py-4">
                    <Button onClick={() => loadMore()} disabled={isFetchingNextPage}>
                      {isFetchingNextPage ? "加载中..." : "加载更多"}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex justify-center py-12">
                <Spinner className="size-8" />
              </div>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
