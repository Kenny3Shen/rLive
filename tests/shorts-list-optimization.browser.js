// 真浏览器验证历史同数量替换、隐藏订阅/偏移恢复与瀑布流增量观察。
async (page) => page.evaluate(async () => {
  const { setupHarness, frames, until, assert } = await import("/tests/browser/harness.js");
  const { HistoryTimeline } = await import("/src/features/history/HistoryTimeline.tsx");
  const { VideoMasonry } = await import("/src/features/video/VideoMasonry.tsx");
  const scroller = document.createElement("div");
  scroller.style.cssText = "position:fixed;inset:0 auto auto 0;height:240px;width:500px;overflow:auto;z-index:99999;background:white";
  document.body.append(scroller);
  const adds = new Set();
  const add = scroller.addEventListener.bind(scroller);
  const remove = scroller.removeEventListener.bind(scroller);
  scroller.addEventListener = (type, fn, options) => { if (type === "scroll") adds.add(fn); add(type, fn, options); };
  scroller.removeEventListener = (type, fn, options) => { if (type === "scroll") adds.delete(fn); remove(type, fn, options); };
  const harness = await setupHarness({ parent: scroller });
  const { h } = harness;
  const key = (item) => item;
  const row = (item) => h("div", { "data-row": item, style: { height: "70px" } }, item);
  const items = Array.from({ length: 40 }, (_, i) => String(i));
  const render = (active, values = items) => harness.render(h(HistoryTimeline, { groups: [{ key: "today", label: "今天", items: values }], itemKey: key, renderItem: row, estimateItemSize: 80, active, snapshotKey: "optimization-fixture" }));
  try {
    render(true);
    await until(() => !!harness.query('[data-row="0"]'), "历史行未出现");
    const old = harness.query('[data-row="0"]');
    render(true, ["replacement", ...items.slice(1)]);
    await frames();
    assert(harness.query('[data-row="replacement"]') !== old, "同数量替换复用了旧行key");
    scroller.scrollTop = 600;
    scroller.dispatchEvent(new Event("scroll"));
    await frames();
    const offset = scroller.scrollTop;
    render(false, ["replacement", ...items.slice(1)]);
    await frames();
    assert(adds.size === 0, "隐藏列表仍订阅滚动");
    assert(!harness.query("[data-index]"), "隐藏列表仍挂载行");
    render(true, ["replacement", ...items.slice(1)]);
    await frames();
    assert(Math.abs(scroller.scrollTop - offset) < 2, "重新激活丢失偏移");
  } finally { harness.dispose(); scroller.remove(); }

  const Original = window.ResizeObserver;
  const observed = new Map();
  window.ResizeObserver = class extends Original {
    observe(node, options) {
      if (node.dataset?.slot === "video-masonry-item") observed.set(node, (observed.get(node) ?? 0) + 1);
      super.observe(node, options);
    }
  };
  const masonry = await setupHarness({ style: "width:500px;position:fixed;left:0;top:0;z-index:99999" });
  const draw = (count) => masonry.render(masonry.h(VideoMasonry, null, Array.from({ length: count }, (_, i) => masonry.h("div", { key: i, style: { height: `${70 + i * 10}px` } }, i))));
  try {
    draw(3);
    await frames();
    const oldNodes = [...masonry.host.querySelectorAll('[data-slot="video-masonry-item"]')];
    const before = oldNodes.map((node) => observed.get(node));
    draw(5);
    await frames();
    assert(oldNodes.every((node, i) => observed.get(node) === before[i]), "追加重绑了所有旧卡观察器");
    assert(masonry.host.querySelectorAll('[data-slot="video-masonry-item"]').length === 5, "追加卡片丢失");
    assert(oldNodes.every((node) => node.style.gridRowEnd.startsWith("span")), "卡片未得到行跨度");
    draw(2);
    await frames();
    return { historyKeys: true, hiddenUnsubscribed: true, restoredOffset: true, masonryIncremental: true };
  } finally { masonry.dispose(); window.ResizeObserver = Original; }
})
