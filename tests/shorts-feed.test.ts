import { describe, expect, test } from "bun:test";
import { isImmersivePlayerPath } from "../src/app/layout/immersiveRoutes";
import {
  SHORTS_BOTTOM_BAR_HEIGHT_PX,
  SHORTS_BOTTOM_CONTROLS_HEIGHT_PX,
  SHORTS_DANMAKU_TOP_OFFSET_PX,
  SHORTS_FRAME_FILL_MAX_CROP,
  SHORTS_PATH,
  SHORTS_PREFETCH_REMAINING,
  SHORTS_SAFE_AREA_BOTTOM,
  SHORTS_SAFE_AREA_TOP,
  SHORTS_SEEK_PREVIEW_WIDTH_PX,
  SHORTS_SWIPE_COMMIT_PROGRESS,
  SHORTS_TOP_BAR_HEIGHT_PX,
  SHORTS_SEEK_BAR_HEIGHT_PX,
  SHORTS_SEEK_BAR_HIT_HEIGHT_PX,
  SHORTS_SEEK_BAR_HIT_OVERHANG_PX,
  shortsFeedItems,
  shortsFrameAlign,
  shortsFrameCrop,
  shortsFrameFill,
  shortsItemKey,
  shortsMediaAspect,
  shortsMediaFrame,
  shortsMountedIndexes,
  shortsSeekPreviewLeft,
  shortsSeekRatio,
  shortsSeekTime,
  shortsShouldFetchMore,
  shortsSwipeDragOffset,
  shortsSwipeIntent,
  shortsSwipeSettleDuration,
  shortsSwipeTargetIndex,
  shortsSwipeVelocity,
  shortsTrackOffset,
} from "../src/features/shorts/shortsFeed";
import type { VideoItem } from "../src/shared/types/video";

function item(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    bvid: "BV1x",
    aid: "117263042742272",
    cid: 41_855_094_127,
    title: "标题",
    cover: "https://i1.hdslb.com/a.jpg",
    author: "up主",
    author_face: null,
    duration: 93,
    view: 100,
    danmaku: 2,
    pubdate: 1_789_292_152,
    rcmd_reason: null,
    dimension: { width: 1080, height: 1920, rotate: 0 },
    ...overrides,
  };
}

describe("显示宽高比", () => {
  test("媒体自报画幅优先于列表下发的 dimension", () => {
    // dimension 是起播前的先验，可能与真正取到的流不一致。
    expect(shortsMediaAspect({ width: 1080, height: 1920, rotate: 0 })).toBeCloseTo(0.5625);
    expect(
      shortsMediaAspect({ width: 1080, height: 1920, rotate: 0 }, { width: 1920, height: 1080 }),
    ).toBeCloseTo(1.7778, 4);
  });

  test("rotate 非 0 时宽高互换", () => {
    // B 站这个字段是 0/1 标志而不是角度，因此非 0 即互换。
    expect(shortsMediaAspect({ width: 1920, height: 1080, rotate: 1 })).toBeCloseTo(0.5625);
    expect(shortsMediaAspect({ width: 1080, height: 1920, rotate: 1 })).toBeCloseTo(1.7778, 4);
  });

  test("两个来源都缺失时返回 null，不猜 9:16", () => {
    expect(shortsMediaAspect(null)).toBeNull();
    expect(shortsMediaAspect(undefined)).toBeNull();
    expect(shortsMediaAspect({ width: 0, height: 1920, rotate: 0 })).toBeNull();
    expect(shortsMediaAspect({ width: 1080, height: 0, rotate: 0 })).toBeNull();
    // 元数据还没到时 intrinsic 是 null，此时仍要能退回 dimension。
    expect(shortsMediaAspect({ width: 1080, height: 1920, rotate: 0 }, null)).toBeCloseTo(0.5625);
  });
});

describe("画面框等比内切", () => {
  const portrait = 9 / 16;
  const landscape = 16 / 9;

  test("桌面宽舞台上竖屏画面按高度定框，不铺满宽度", () => {
    // 这是「不该强行铺满」的本体：1920 宽的舞台上按 cover 铺满会让高度溢出到
    // 约 3413px，只看得见画面中间一条。内切后是居中的 607.5×1080 竖卡。
    const frame = shortsMediaFrame(1920, 1080, portrait);
    expect(frame.height).toBe(1080);
    expect(frame.width).toBeCloseTo(607.5);
    expect(frame.width).toBeLessThan(1920);
  });

  test("手机竖舞台上竖屏画面按宽度定框", () => {
    // 视口比 9:16 更长（412×839），因此上下各留约 53px —— 不裁画面的代价。
    const frame = shortsMediaFrame(412, 839, portrait);
    expect(frame.width).toBe(412);
    expect(frame.height).toBeCloseTo(732.44, 2);
    expect(frame.height).toBeLessThan(839);
  });

  test("横屏画面在同比例舞台上正好铺满", () => {
    const frame = shortsMediaFrame(1920, 1080, landscape);
    expect(frame.width).toBeCloseTo(1920);
    expect(frame.height).toBeCloseTo(1080);
  });

  test("横屏画面在竖舞台上是居中的一条", () => {
    const frame = shortsMediaFrame(412, 839, landscape);
    expect(frame.width).toBe(412);
    expect(frame.height).toBeCloseTo(231.75);
  });

  test("宽高比未知时退回舞台尺寸，交给 object-contain", () => {
    expect(shortsMediaFrame(1920, 1080, null)).toEqual({ width: 1920, height: 1080 });
    expect(shortsMediaFrame(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(shortsMediaFrame(1920, 1080, Number.POSITIVE_INFINITY)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test("舞台还没量到尺寸时返回 0，由样式退回铺满", () => {
    expect(shortsMediaFrame(0, 0, portrait)).toEqual({ width: 0, height: 0 });
    expect(shortsMediaFrame(1920, 0, portrait)).toEqual({ width: 0, height: 0 });
  });
});

describe("进度条换算", () => {
  test("按进度条自身的矩形换算比例", () => {
    // 需求是「仅在进度条区域操作有效」：换算基准必须是轨道矩形，不是画面框。
    expect(shortsSeekRatio(100, 100, 300)).toBe(0);
    expect(shortsSeekRatio(250, 100, 300)).toBeCloseTo(0.5);
    expect(shortsSeekRatio(400, 100, 300)).toBe(1);
  });

  test("越出轨道两端一律夹到 0 与 1", () => {
    // 指针捕获期间手指可以移到轨道之外，那时仍要给出可用的比例。
    expect(shortsSeekRatio(20, 100, 300)).toBe(0);
    expect(shortsSeekRatio(9_999, 100, 300)).toBe(1);
  });

  test("零宽轨道不产生 NaN", () => {
    // 首帧或隐藏容器上 getBoundingClientRect 可能给出 0 宽。
    expect(shortsSeekRatio(50, 0, 0)).toBe(0);
  });

  test("比例换算成秒数，时长未知时返回 0", () => {
    expect(shortsSeekTime(0.5, 120)).toBeCloseTo(60);
    expect(shortsSeekTime(1, 93)).toBeCloseTo(93);
    // 时长未知时调用方据此不发起 seek。
    expect(shortsSeekTime(0.5, 0)).toBe(0);
  });
});

describe("操作栏高度契约", () => {
  test("弹幕起始纵坐标等于顶部控制栏高度", () => {
    // 画面框顶对齐到安全区下沿，控制栏正好压住画面框顶部这一条：两者相等，
    // 弹幕才会从控制栏正下方开始滚而不穿过返回按钮。
    expect(SHORTS_DANMAKU_TOP_OFFSET_PX).toBe(SHORTS_TOP_BAR_HEIGHT_PX);
  });

  test("两条栏都是正数高度", () => {
    // 页面级操作栏与面板内画面区共用这两个数：任一为 0 会让画面区算错收边。
    expect(SHORTS_BOTTOM_BAR_HEIGHT_PX).toBeGreaterThan(0);
    expect(SHORTS_TOP_BAR_HEIGHT_PX).toBeGreaterThan(0);
  });

  test("底栏总高等于控制行加进度条", () => {
    // 进度条移进底栏后，「底栏多高」不再是独立的设计数字而是两段之和。写死总数会在
    // 改任一段时静默错位：画面区按总数收边，而两条栏各按自己那段绘制。
    expect(SHORTS_BOTTOM_BAR_HEIGHT_PX).toBe(
      SHORTS_BOTTOM_CONTROLS_HEIGHT_PX + SHORTS_SEEK_BAR_HEIGHT_PX,
    );
  });

  test("进度条命中区探进画面的高度等于命中区减视觉粗细", () => {
    // 贴底栏摆的浮层（信息与评论）按这个数让位。写死会在命中区或视觉粗细任一变动时
    // 静默重新压上去，而症状是「点评论数字变成 seek 到 0」——很难反查到这里。
    expect(SHORTS_SEEK_BAR_HIT_OVERHANG_PX).toBe(
      SHORTS_SEEK_BAR_HIT_HEIGHT_PX - SHORTS_SEEK_BAR_HEIGHT_PX,
    );
  });

  test("命中区比视觉粗细厚，且不超过控制行", () => {
    // 命中区存在的理由就是 3px 按不到；同时它只向上长，厚过整条底栏就会盖到画面
    // 中央去。
    expect(SHORTS_SEEK_BAR_HIT_HEIGHT_PX).toBeGreaterThan(SHORTS_SEEK_BAR_HEIGHT_PX);
    expect(SHORTS_SEEK_BAR_HIT_HEIGHT_PX).toBeLessThanOrEqual(SHORTS_BOTTOM_CONTROLS_HEIGHT_PX);
  });
});

describe("裁切铺满判定", () => {
  test("要裁的比例与哪个更「宽」无关", () => {
    // 同一对宽高比，无论谁当画面区谁当源，要裁掉的比例是同一个数：画面区更「高」时
    // 裁宽、更「宽」时裁高，但相对差值不变。调用方因此不必分轴讨论。
    expect(shortsFrameCrop(0.5, 0.5625)).toBeCloseTo(shortsFrameCrop(0.5625, 0.5), 10);
  });

  test("完全一致时无需裁切", () => {
    expect(shortsFrameCrop(0.5625, 0.5625)).toBe(0);
  });

  test("非法输入按 0 处理", () => {
    // 尺寸还没量到时会传 0 进来，此时不该报告「需要裁切」。
    expect(shortsFrameCrop(0, 0.5625)).toBe(0);
    expect(shortsFrameCrop(0.5625, 0)).toBe(0);
    expect(shortsFrameCrop(-1, 0.5625)).toBe(0);
  });

  test("主流竖屏机型铺满，16:9 与 21:9 留边", () => {
    // 阈值卡在 10% 的依据。画面区高度 = 视口高 − 底栏 − 底部安全区（顶栏浮在画面上，
    // 不占空间）。9:16 的源在各机型上要裁的比例见 shortsFeed.ts 的表格。
    const portrait = 9 / 16;
    const area = (w: number, h: number) => shortsFrameFill(w, h, portrait);
    // 19.5:9 与 20:9：差得少，裁两侧不到一成。
    expect(area(390, 704)).toBe(true); // iPhone 13，裁宽 1.5%
    expect(area(360, 673)).toBe(true); // Galaxy S22，裁宽 4.9%
    expect(area(393, 744)).toBe(true); // Pixel 5，裁宽 6.1%
    expect(area(412, 808)).toBe(true); // Pixel 8（20:9），裁宽 9.4%
    // 16:9 屏：画面区比源更「宽」，铺满要裁的是**高**（竖屏视频的上下两端）11.8%。
    expect(area(375, 588)).toBe(false);
    // 21:9：要裁 13.7%，超阈值。
    expect(area(393, 810)).toBe(false);
    // 桌面：画面区是横的，与竖屏源差得极远。
    expect(area(1440, 841)).toBe(false);
  });

  test("横屏与方形源一律不裁", () => {
    // 横屏源在竖屏视口里差得极远（16:9 放进 9:19.5 要裁掉七成），必须留边居中。
    // 桌面上画面区已接近 16:9，若只看差值就会转成裁切 —— 那不是这次要改的东西，
    // 因此判据写成「竖屏 + 差值够小」而不是只看差值。
    expect(shortsFrameFill(1440, 841, 16 / 9)).toBe(false);
    expect(shortsFrameFill(360, 673, 16 / 9)).toBe(false);
    expect(shortsFrameFill(500, 500, 1)).toBe(false);
  });

  test("宽高比未知或尺寸未量到时不裁", () => {
    // 首帧 area 是 0×0；aspect 为 null 表示两个来源都没给出画幅。两种情况下
    // 「铺满」都是在猜，宁可留边。
    expect(shortsFrameFill(360, 673, null)).toBe(false);
    expect(shortsFrameFill(0, 0, 9 / 16)).toBe(false);
    expect(shortsFrameFill(360, 0, 9 / 16)).toBe(false);
    expect(shortsFrameFill(360, 673, Number.NaN)).toBe(false);
  });

  test("阈值是一个不到两成的比例", () => {
    // 上界是产品判断而不是几何：裁掉两成以上的画面已经在改变构图。
    expect(SHORTS_FRAME_FILL_MAX_CROP).toBeGreaterThan(0);
    expect(SHORTS_FRAME_FILL_MAX_CROP).toBeLessThan(0.2);
  });
});

describe("跨页去重与可播性过滤", () => {
  test("同一 bvid 只保留首次出现", () => {
    // 上游无游标：翻页就是再拉一批轮换内容，跨页重复由这里折叠。
    const items = shortsFeedItems([
      { items: [item({ bvid: "a" }), item({ bvid: "b" })] },
      { items: [item({ bvid: "b" }), item({ bvid: "c" })] },
    ]);
    expect(items.map((entry) => entry.bvid)).toEqual(["a", "b", "c"]);
  });

  test("丢掉缺取流键的条目", () => {
    // 竖屏舞台没有「先取详情补 cid」的中间态，拿不到 cid 就不该进流。
    const items = shortsFeedItems([
      { items: [item({ bvid: "ok" }), item({ bvid: "no-cid", cid: null })] },
      { items: [item({ bvid: "", cid: 1 }), item({ bvid: "zero-cid", cid: 0 })] },
    ]);
    expect(items.map((entry) => entry.bvid)).toEqual(["ok"]);
  });

  test("条目身份与播放列表项同构", () => {
    expect(shortsItemKey({ bvid: "BV1x", cid: 42 })).toBe("BV1x_42");
    expect(shortsItemKey({ bvid: "BV1x", cid: null })).toBe("BV1x_0");
  });
});

describe("纵向手势轴锁", () => {
  test("阈值内保持 pending，纵向接手，横向与斜向拒绝", () => {
    // pending 期间不能移动条带，也不能作废子元素的点按。
    expect(shortsSwipeIntent(4, 6)).toBe("pending");
    expect(shortsSwipeIntent(0, 40)).toBe("switch");
    expect(shortsSwipeIntent(0, -40)).toBe("switch");
    // 横向留给系统返回手势。
    expect(shortsSwipeIntent(40, 0)).toBe("reject");
    // 斜向：纵向没有明显优势（比例不足 1.25）时不认领。
    expect(shortsSwipeIntent(30, 32)).toBe("reject");
  });
});

describe("换片提交判定", () => {
  const height = 800;

  test("慢拖必须走过约定比例才换片", () => {
    const short = -height * (SHORTS_SWIPE_COMMIT_PROGRESS - 0.05);
    const long = -height * (SHORTS_SWIPE_COMMIT_PROGRESS + 0.05);
    expect(shortsSwipeTargetIndex(1, 5, short, 0, height)).toBeNull();
    expect(shortsSwipeTargetIndex(1, 5, long, 0, height)).toBe(2);
  });

  test("顺向一甩任何距离都换片，回甩任何距离都取消", () => {
    // 上滑（负偏移）前进：顺向速度为负。
    expect(shortsSwipeTargetIndex(1, 5, -10, -1, height)).toBe(2);
    // 拖过中点又甩回去不该违背最后意图。
    expect(shortsSwipeTargetIndex(1, 5, -height * 0.9, 1, height)).toBeNull();
  });

  test("正偏移回到上一条", () => {
    expect(shortsSwipeTargetIndex(2, 5, height * 0.5, 0, height)).toBe(1);
  });

  test("首尾越界返回 null", () => {
    // 最后一条是「暂时到底」：流仍在增长，但这一刻没有下一条可去。
    expect(shortsSwipeTargetIndex(0, 5, height * 0.5, 0, height)).toBeNull();
    expect(shortsSwipeTargetIndex(4, 5, -height * 0.5, 0, height)).toBeNull();
    expect(shortsSwipeTargetIndex(0, 1, -height * 0.5, 0, height)).toBeNull();
    // 零位移不构成手势。
    expect(shortsSwipeTargetIndex(1, 5, 0, 0, height)).toBeNull();
  });
});

describe("跟手偏移与条带定位", () => {
  test("有效方向最多跟手一整个舞台高度", () => {
    expect(shortsSwipeDragOffset(1, 5, -300, 800)).toBe(-300);
    // 超过一屏的位移被钳住，条带不会滑过头。
    expect(shortsSwipeDragOffset(1, 5, -1200, 800)).toBe(-800);
  });

  test("首尾条目上的越界位移被阻尼", () => {
    const damped = shortsSwipeDragOffset(0, 5, 300, 800);
    expect(damped).toBeGreaterThan(0);
    expect(damped).toBeLessThan(300 * 0.25);
    const dampedTail = shortsSwipeDragOffset(4, 5, -300, 800);
    expect(dampedTail).toBeLessThan(0);
    expect(Math.abs(dampedTail)).toBeLessThan(300 * 0.25);
  });

  test("条带按绝对下标定位", () => {
    expect(shortsTrackOffset(0, 800)).toBe(0);
    expect(shortsTrackOffset(3, 800)).toBe(-2400);
    // 尺寸还没测出来时不要产出 NaN。
    expect(shortsTrackOffset(3, 0)).toBe(0);
  });

  test("释放速度取自样本尾部窗口", () => {
    // 抬手前停顿过的手指上报约 0，而不是继承停顿前的速度。
    const stalled = shortsSwipeVelocity([
      { y: 0, time: 0 },
      { y: -200, time: 100 },
      { y: -200, time: 200 },
    ]);
    expect(Math.abs(stalled)).toBeLessThan(0.01);
    const flung = shortsSwipeVelocity([
      { y: 0, time: 0 },
      { y: -40, time: 16 },
      { y: -80, time: 32 },
    ]);
    expect(flung).toBeLessThan(-1);
  });

  test("收尾时长随剩余距离与速度落在边界内", () => {
    expect(shortsSwipeSettleDuration(0.5, 1)).toBe(0);
    const slow = shortsSwipeSettleDuration(800, 0.1);
    const fast = shortsSwipeSettleDuration(800, 5);
    expect(slow).toBeLessThanOrEqual(400);
    expect(fast).toBeGreaterThanOrEqual(170);
    expect(fast).toBeLessThanOrEqual(slow);
  });
});

describe("挂载窗口与补货", () => {
  test("只挂载上一条、当前、下一条", () => {
    // 相邻条目必须真实挂载，否则跟手拖动时手指下方是空白。
    expect(shortsMountedIndexes(0, 5)).toEqual([0, 1]);
    expect(shortsMountedIndexes(2, 5)).toEqual([1, 2, 3]);
    expect(shortsMountedIndexes(4, 5)).toEqual([3, 4]);
    expect(shortsMountedIndexes(0, 1)).toEqual([0]);
    expect(shortsMountedIndexes(0, 0)).toEqual([]);
  });

  test("剩余不足约定条数就提前补货", () => {
    const length = 10;
    const trigger = length - SHORTS_PREFETCH_REMAINING - 1;
    expect(shortsShouldFetchMore(trigger - 1, length, true, false)).toBe(false);
    expect(shortsShouldFetchMore(trigger, length, true, false)).toBe(true);
  });

  test("在途或没有下一页时不重复请求", () => {
    expect(shortsShouldFetchMore(9, 10, true, true)).toBe(false);
    expect(shortsShouldFetchMore(9, 10, false, false)).toBe(false);
    expect(shortsShouldFetchMore(0, 0, true, false)).toBe(false);
  });
});

describe("画面框纵向对齐", () => {
  test("竖屏源顶对齐：上方不留黑边", () => {
    // 9:16 放进 9:19.5 的手机视口，居中会在状态栏之下留一条黑边。
    expect(shortsFrameAlign(9 / 16)).toBe("start");
    expect(shortsFrameAlign(0.5625)).toBe("start");
    // 轻微竖也算竖：判据是「是否竖」，不是「竖多少」。
    expect(shortsFrameAlign(0.99)).toBe("start");
  });

  test("横屏源居中：上下对称留边", () => {
    // 16:9 顶对齐会把画面按在顶部控制栏底下，下方剩一大片背景。
    expect(shortsFrameAlign(16 / 9)).toBe("center");
    expect(shortsFrameAlign(1.7778)).toBe("center");
  });

  test("方形归到居中一侧", () => {
    // 正方形没有「竖屏要顶格」的诉求。
    expect(shortsFrameAlign(1)).toBe("center");
  });

  test("宽高比未知时居中", () => {
    // 起播前拿不到 dimension 也没有 intrinsic size：不猜竖屏。
    expect(shortsFrameAlign(null)).toBe("center");
    expect(shortsFrameAlign(0)).toBe("center");
    expect(shortsFrameAlign(Number.NaN)).toBe("center");
    expect(shortsFrameAlign(Number.POSITIVE_INFINITY)).toBe("center");
  });

  test("对齐方式与视口无关", () => {
    // 同一条视频在手机与桌面上必须得到同样的构图，否则换设备就换画法。
    const portrait = shortsMediaAspect({ width: 1080, height: 1920, rotate: 0 });
    expect(shortsFrameAlign(portrait)).toBe("start");
    // 桌面上这条竖屏正好铺满高度，对齐方式此时不产生可见差异，但结论仍一致。
    expect(shortsMediaFrame(1440, 844, portrait).height).toBe(844);
  });
});

describe("进度预览气泡定位", () => {
  test("居中跟随手指", () => {
    // 360 宽轨道、160 宽气泡，拖到一半：气泡中心对齐手指。
    expect(shortsSeekPreviewLeft(0.5, 360, 160)).toBe(100);
  });

  test("两端夹住，不探出轨道", () => {
    // 贴左端时居中算出 -80，会有一半飘到画面外。
    expect(shortsSeekPreviewLeft(0, 360, 160)).toBe(0);
    // 贴右端时夹到 track - preview。
    expect(shortsSeekPreviewLeft(1, 360, 160)).toBe(200);
  });

  test("轨道比气泡窄时退回 0", () => {
    // 无处可夹：任何偏移都会探出去，贴左端最不坏。
    expect(shortsSeekPreviewLeft(0.5, 120, 160)).toBe(0);
  });

  test("尺寸缺失时退回 0", () => {
    expect(shortsSeekPreviewLeft(0.5, 0, 160)).toBe(0);
    expect(shortsSeekPreviewLeft(0.5, 360, 0)).toBe(0);
  });

  test("越界比例先被夹进 0~1", () => {
    expect(shortsSeekPreviewLeft(-1, 360, 160)).toBe(0);
    expect(shortsSeekPreviewLeft(2, 360, 160)).toBe(200);
  });
});

describe("安全区表达式", () => {
  test("原生注入的变量优先，env() 兜底", () => {
    /*
     * Android WebView 的 `env(safe-area-inset-*)` 会读到 0，本项目因此由
     * MainActivity 把真值写成 CSS 变量。裸 env() 在那里等于不留安全区，底部操作栏
     * 会被系统手势指示条压住 —— 这两条断言锁的就是这个顺序。
     */
    expect(SHORTS_SAFE_AREA_TOP).toBe("var(--android-safe-area-top, env(safe-area-inset-top))");
    expect(SHORTS_SAFE_AREA_BOTTOM).toBe(
      "var(--android-safe-area-bottom, env(safe-area-inset-bottom))",
    );
  });

  test("两个方向都带回退", () => {
    // 旧 APK 与浏览器都没有那个变量，回退不能省。
    for (const expression of [SHORTS_SAFE_AREA_TOP, SHORTS_SAFE_AREA_BOTTOM]) {
      expect(expression).toContain("--android-safe-area-");
      expect(expression).toContain("env(safe-area-inset-");
    }
  });
});

describe("路由契约", () => {
  test("短视频是沉浸式路由", () => {
    // 外壳的顶栏与侧栏会把 9:16 舞台挤成一条；返回口由页内 HUD 提供。
    expect(isImmersivePlayerPath(SHORTS_PATH)).toBe(true);
  });

  test("路径不挂在 /video 之下", () => {
    // 侧栏目的地按前缀匹配，挂进去会让「视频」项跟着高亮。
    expect(SHORTS_PATH.startsWith("/video")).toBe(false);
    expect(SHORTS_PATH).toBe("/shorts");
  });
});
