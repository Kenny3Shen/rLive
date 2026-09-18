/**
 * 弹幕历史「滚动范围不断变长」的测量夹具。
 *
 * 实机反馈：弹幕历史页可以一直往下滚，像无限滚动。窗口化列表的总高度是
 * 「已测行实测高 + 未测行估高」之和，因此只要实测系统性大于估高，往下滚就会持续把
 * 总高度往上抬 —— 用户看到的就是滚动条不断变长、怎么也滚不到底。
 *
 * 夹具做的事：
 * - 用真实 Card 结构与真实排版渲染 N 条弹幕（内容长短不一，含长文本）。
 * - 反复置底滚动，记录 scrollHeight / scrollTop 序列：若持续攀升即复现。
 * - 汇总实测行高与估高的差距。
 *
 * `?clamp=1` 给正文加行数上限，用来对照「限高后是否收敛」。
 */
const { assert, frames } = await import("/tests/browser/harness.js");
const { default: React } = await import("react");
const { createRoot } = await import("react-dom/client");
// 必须引应用样式表：Card 的内边距、break-words、行高等 utilities 都在里面，
// 不引它量出来的高度没有意义。
await import("/src/styles.css");

const h = React.createElement;

const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");
const scroller = document.getElementById("scroller");
if (!scroller) throw new Error("缺少滚动容器 #scroller");

const { HistoryTimeline } = await import("/src/features/history/HistoryTimeline.tsx");
const { clearHistoryScrollSnapshots } = await import("/src/features/history/historyVirtual.ts");
// 卡片组件未导出且依赖路由上下文，夹具因此照 `DanmakuSendHistoryCard` 的结构
// 复刻一份（Card + CardHeader/CardAction + 限高正文 + 脚注）。限高值直接取自
// DANMAKU_CONTENT_MAX_HEIGHT_PX，避免复制品与实现漂移。
const { DANMAKU_CONTENT_MAX_HEIGHT_PX, DANMAKU_CARD_ESTIMATE_PX } = await import(
  "/src/features/history/historyVirtual.ts",
);
const { Card, CardAction, CardContent, CardHeader, CardTitle } = await import(
  "/src/components/ui/card.tsx",
);

clearHistoryScrollSnapshots();

const clamp = new URLSearchParams(location.search).get("clamp") === "1";
const dup = new URLSearchParams(location.search).get("dup") === "1";
const N = 400;
const ESTIMATE = Number(new URLSearchParams(location.search).get("est") ?? DANMAKU_CARD_ESTIMATE_PX);

/** 长短不一的弹幕内容：真实历史里既有短吐槽也有长句子。 */
const LEN = Number(new URLSearchParams(location.search).get("len") ?? 0);
const LENGTHS = LEN ? [LEN] : [8, 15, 25, 45, 80];
const TEXT = "这是一条弹幕历史记录内容用于观察换行后的实际高度表现";
function contentAt(index) {
  const target = LENGTHS[index % LENGTHS.length];
  let out = "";
  while (out.length < target) out += TEXT;
  return out.slice(0, target);
}

const items = Array.from({ length: N }, (_, index) => ({
  site_id: "bilibili",
  room_id: `room-${index % 37}`,
  room_title: `直播间 ${index % 37}`,
  room_user_name: `主播 ${index % 37}`,
  // dup=1：同房间、同一分钟内重复发同一条 —— sent_at 与 content 都相同，
  // 行键（site:sent_at:content）随之重复。
  sent_at: 1_760_000_000_000 - Math.floor(index / (dup ? 4 : 1)) * 60_000,
  content: dup ? contentAt(Math.floor(index / 4)) : contentAt(index),
}));

const groups = [{ key: "today", label: "今天", items }];

function DanmakuRow(item) {
  return h(
    Card,
    { size: "sm" },
    h(
      CardHeader,
      null,
      h(
        CardTitle,
        { className: "flex min-w-0 items-center gap-2" },
        h("span", { className: "size-7 shrink-0 rounded-lg bg-muted" }),
        h("span", { className: "truncate text-sm font-medium" }, item.room_title),
      ),
      h(CardAction, null, h("time", { className: "text-xs whitespace-nowrap" }, "12:34")),
    ),
    h(
      CardContent,
      null,
      h(
        "p",
        {
          className: "break-words text-sm leading-relaxed",
          style: clamp
            ? { maxHeight: DANMAKU_CONTENT_MAX_HEIGHT_PX, overflowY: "auto" }
            : undefined,
        },
        item.content,
      ),
      h(
        "div",
        { className: "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" },
        h("span", null, item.room_user_name),
        h("span", null, item.room_id),
      ),
    ),
  );
}


const root = createRoot(host);
root.render(
  h(HistoryTimeline, {
    groups,
    itemKey: (item) => `${item.site_id}:${item.sent_at}:${item.content}`,
    estimateItemSize: ESTIMATE,
    active: true,
    snapshotKey: "danmaku-fixture",
    renderItem: DanmakuRow,
  }),
);
await frames();
await frames();

const initialHeight = scroller.scrollHeight;
assert(initialHeight > scroller.clientHeight, `列表未撑开：${initialHeight}`);

// 逐屏下滚：这才是最接近真人的操作。若「新进入窗口的行被实测后变高」带来的
// 增量大于每次滚动的步长，内容高度就会持续跑在用户前面 —— 表现为怎么也滚不到底。
const STEP = 400;
const series = [];
let reachedBottom = false;
for (let step = 0; step < 400; step += 1) {
  const before = scroller.scrollTop;
  scroller.scrollTop = before + STEP;
  await frames();
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (scroller.scrollTop >= max - 2) {
    reachedBottom = true;
    series.push({ top: Math.round(scroller.scrollTop), h: scroller.scrollHeight, max: Math.round(max) });
    break;
  }
  series.push({ top: Math.round(scroller.scrollTop), h: scroller.scrollHeight, max: Math.round(max) });
}

// 实测行高：取当前渲染出来的记录行（含 <p> 正文）的高度。
const rendered = [...host.querySelectorAll("[data-index]")];
const itemHeights = rendered
  .filter((node) => node.querySelector("p"))
  .map((node) => node.getBoundingClientRect().height);

const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const last = series[series.length - 1];
const prev = series[series.length - 6] ?? series[0];

window.__diag = {
  clamp,
  dup,
  estimate: ESTIMATE,
  rows: N,
  initialHeight,
  finalHeight: last.h,
  finalTop: last.top,
  growthRatio: +(last.h / initialHeight).toFixed(3),
  // 末尾 5 次仍在增长说明没有收敛：滚到底了总高度还在变长。
  tailGrowth: last.h - prev.h,
  measured: {
    count: itemHeights.length,
    min: itemHeights.length ? +Math.min(...itemHeights).toFixed(1) : null,
    max: itemHeights.length ? +Math.max(...itemHeights).toFixed(1) : null,
    avg: itemHeights.length ? +avg(itemHeights).toFixed(1) : null,
  },
  steps: series.length,
  reachedBottom,
  // 每一步的内容增长量：为正说明内容跑在用户前面（滚不到底的根因）。
  growthPerStep: series.slice(1).map((s, i) => s.h - series[i].h),
};
window.__fixtureResult = "ok";
