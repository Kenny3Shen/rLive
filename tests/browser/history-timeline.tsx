/**
 * 历史时间线「刷新回顶」的浏览器夹具。
 *
 * 复现的是这个缺陷：时间倒序列表在 `anchorTo:"end"` 下会把可见行钉在原位，新记录
 * 从顶部插入后 scrollTop 被加上新记录高度——锚点行看着没动，真正新的那几条却落到
 * 视口上方（负偏移），刷新于是像什么都没发生。
 *
 * 夹具因此断言「新记录的第一行在视口内」而不是「scrollTop 变了」：后者在缺陷版本
 * 里同样成立（scrollTop 确实变了，只是内容被顶走了）。
 *
 * 前置断言刻意严格（列表必须真的撑开高度、必须真的渲染了行）：否则行塌在 0 位置或
 * 根本没渲染时，视口内外的判断会落空，夹具会以「没渲染任何行」的姿态假通过。
 */
const { assert, frames } = await import("/tests/browser/harness.js");
const { default: React } = await import("react");
const { createRoot } = await import("react-dom/client");
// 必须显式引应用样式表：行的 `absolute` 定位与内边距来自 Tailwind utilities，
// 夹具不引它就没有类生效，行会全部塌在 0 位置、量出来的偏移全是错的。
await import("/src/styles.css");

const h = React.createElement;

const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");
const scroller = document.getElementById("scroller");
if (!scroller) throw new Error("缺少滚动容器 #scroller");

const { HistoryTimeline } = await import("/src/features/history/HistoryTimeline.tsx");
const { resetHistoryScrollForRefresh, clearHistoryScrollSnapshots } = await import(
  "/src/features/history/historyVirtual.ts"
);

clearHistoryScrollSnapshots();

const REFRESH_TOKEN = 1;
const ITEM_COUNT = 40;
const ITEM_HEIGHT = 98;

/** 造 `count` 条记录，键从 `offset` 起编号，便于模拟「顶部插入新记录」。 */
function makeItems(offset, count) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const id = offset + index;
    items.push({ id: `item-${id}`, label: `记录 ${id}` });
  }
  return items;
}

function makeGroups(offset, count) {
  return [{ key: "today", label: "今天", items: makeItems(offset, count) }];
}

let setGroupsExternal;
let resetExternal;

function Fixture() {
  const [groups, setGroups] = React.useState(() => makeGroups(0, ITEM_COUNT));
  setGroupsExternal = setGroups;
  React.useEffect(() => {
    resetExternal = () => resetHistoryScrollForRefresh(REFRESH_TOKEN);
  }, []);
  return h(HistoryTimeline, {
    groups,
    itemKey: (item) => item.id,
    estimateItemSize: ITEM_HEIGHT,
    active: true,
    snapshotKey: "fixture",
    refreshResetToken: REFRESH_TOKEN,
    // 定高行：测量与估高一致，锚点行为不受测量抖动干扰。
    renderItem: (item) =>
      h("div", { "data-item": item.id, style: { height: `${ITEM_HEIGHT}px` } }, item.label),
  });
}

const root = createRoot(host);
root.render(h(Fixture));
await frames();
await frames();

assert(
  scroller.scrollHeight > scroller.clientHeight,
  `列表未撑开滚动高度：${scroller.scrollHeight} <= ${scroller.clientHeight}`,
);
const renderedCount = host.querySelectorAll("[data-item]").length;
assert(renderedCount > 0, "没有渲染任何记录行：夹具无法验证锚点行为");

// 滚过 8px 容差：此时锚点方向切到 "end"，缺陷才能发生。
//
// 桌面刷新按钮（RefreshFab）在任意滚动位置都可点，因此「向下滚过一段再刷新」是真实
// 路径；下拉刷新只能从 scrollTop <= 0 起手，而容差内锚点仍是 "start"、不锚定，
// 新记录本来就可见——真正的缺口在容差之外。
scroller.scrollTop = 300;
await frames();
await frames();
assert(
  scroller.scrollTop > 8,
  `前置条件失败：需滚过 8px 容差才会切到 end 锚定，实际 ${scroller.scrollTop}`,
);

// 顶部插入 3 条新记录（刷新后数据到达），再走刷新回顶。
setGroupsExternal(makeGroups(ITEM_COUNT + 1, ITEM_COUNT + 3));
await frames();
resetExternal();
await frames();
await frames();

const firstNew = host.querySelector("[data-item='item-41']");
assert(firstNew, `未渲染最新插入的第一条记录（已渲染 ${host.querySelectorAll("[data-item]").length} 行）`);

const scrollerBox = scroller.getBoundingClientRect();
const firstBox = firstNew.getBoundingClientRect();
// 新记录的第一行必须落在视口内：顶部之下、视口底之上。
assert(
  firstBox.top >= scrollerBox.top - 1,
  `新记录被顶到视口上方：top=${firstBox.top} 视口顶=${scrollerBox.top}`,
);
assert(
  firstBox.top < scrollerBox.bottom,
  `新记录落在视口下方：top=${firstBox.top} 视口底=${scrollerBox.bottom}`,
);

root.unmount();
window.__fixtureResult = "ok";
