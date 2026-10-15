/**
 * 媒体卡片网格（直播首页、直播搜索、VOD 发现页/搜索及其骨架屏）的列数与间距，
 * 唯一事实来源。
 *
 * 这些表面装的是同一种卡（16:9 封面 + 两行文字），等宽等高，因此共用同一串
 * 类名：列数档位、横纵间距与粗指针下的列数上限只在这里维护，改一处即全部对齐。
 * 曾经 VOD 列表单开过一套瀑布流网格，横竖画幅混排时列尾参差、卡片高度不等，
 * 与直播首页读起来是两种列表，现已统一。
 *
 * `grid-cols-2` 起步、`xl` 六列；粗指针在 `80rem` 及以上封到 5 列 —— 平板横屏
 * 下 6 列会把每张卡压到 184px 上下，封面里的角标与标题都读不清。
 */
export const CARD_GRID_CLASS =
  "grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 [@media(min-width:80rem)_and_(pointer:coarse)]:grid-cols-5!";
