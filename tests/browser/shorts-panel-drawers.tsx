/**
 * 短视频面板抽屉几何的浏览器测量夹具。
 *
 * 测的是「一级评论抽屉」与叠在它上面的「二级回复抽屉」是否**完全重合**：两层
 * 差一点就会露出下面那层的边（曾经二级走基础组件的 20rem 而一级是 22rem，桌面上
 * 右侧露出一条 32px 的缝；手机上更明显 —— 一级从底部弹出而二级从右侧滑入）。
 *
 * 只断言纯函数算不出、必须真机渲染才成立的部分：Base UI 的 portal 定位、
 * `cn`/twMerge 的类名合并结果、以及 `70dvh` 这类相对单位。侧别与尺寸本身由
 * `tests/player-controls.test.ts` 里的单测覆盖，这里不再重复。
 *
 * 真组件 + 只桩 IPC：抽屉外壳用 `ShortsPage` 的那个（不导出，因此这里按同样的
 * 几何参数走一遍 `DrawerContent`），评论区用真 `CommentsPanel`。
 */
const { default: React } = await import("react");
const { createRoot } = await import("react-dom/client");
// 必须显式引应用样式表：Tailwind 的 utilities 由 `@tailwindcss/vite` 从这张表里
// 生成，夹具不引它就没有任何类名生效（抽屉会退化成普通块级元素，量出来的几何
// 全是错的）。
await import("/src/styles.css");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Drawer, DrawerContent, DrawerTitle } = await import("/src/components/ui/drawer.tsx");
const { CommentsPanel } = await import("/src/features/video/CommentsPanel.tsx");
const { panelDrawerSide, panelDrawerSizeClass } = await import(
  "/src/shared/components/player/panelDrawer.ts"
);
const { cn } = await import("/src/lib/utils.ts");

const h = React.createElement;

/** 与 `ShortsPage` 的抽屉外壳同参：同一个 `panelDrawer` 几何。 */
function PanelDrawer({ compact, open, title, children }) {
  const side = panelDrawerSide(compact);
  return h(
    Drawer,
    { open },
    h(
      DrawerContent,
      {
        side,
        className: cn("flex flex-col overflow-hidden p-0", panelDrawerSizeClass(side)),
      },
      h(
        "div",
        { className: "flex h-12 shrink-0 items-center border-b border-border px-3" },
        h(DrawerTitle, null, title),
      ),
      h(
        "div",
        { className: "min-h-0 flex-1 overflow-y-auto overscroll-contain", "data-slot": "scroll" },
        children,
      ),
    ),
  );
}

function Fixture({ compact }) {
  return h(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    h(
      "div",
      { "data-drawer-geometry-fixture": "" },
      // 一级：评论抽屉，里面是评论区（评论区自带二级抽屉）。
      h(
        PanelDrawer,
        { compact, open: true, title: "评论" },
        // 与 `ShortsPage` 同接法：底部形态下把安全区让位传给二级回复抽屉。
        h(CommentsPanel, { aid: "170001", bottomInset: compact ? "12px" : undefined }),
      ),
    ),
  );
}

const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");

/** 供驱动脚本调用：`render(false)` 切桌面、`render(true)` 切手机。 */
window.__drawerGeometry = {
  render(compact) {
    React.startTransition?.(() => {});
    window.__drawerGeometryRoot ??= createRoot(host);
    window.__drawerGeometryRoot.render(h(Fixture, { compact }));
  },
  /** 打开二级抽屉：点第一条评论的「共 N 条回复」。 */
  async openReplies() {
    const button = [...document.querySelectorAll("button")].find((node) =>
      /共 .* 条回复/.test(node.textContent ?? ""),
    );
    if (!button) throw new Error("未找到回复入口，评论接口桩可能没返回数据");
    button.click();
  },
  /** 两个抽屉的矩形，按 DOM 顺序：一级在前、二级在后。 */
  boxes() {
    // `role="dialog"` 而不是 `data-slot="drawer-content"`：`DrawerContent` 里
    // `data-slot` 写在展开 props 之前，夹具传同名属性会把基础值覆盖掉。
    return [...document.querySelectorAll('[role="dialog"]')].map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { side: node.getAttribute("data-side"), x, y, width, height };
    });
  },
  /** 二级抽屉滚动容器的底部内边距（安全区让位）。 */
  repliesScrollPaddingBottom() {
    const scopes = [...document.querySelectorAll('[role="dialog"]')];
    const replies = scopes[scopes.length - 1];
    const scroll = replies?.querySelector('[data-slot="scroll"]') ?? replies?.querySelector(".overflow-y-auto");
    return scroll ? getComputedStyle(scroll).paddingBottom : null;
  },
};

window.__drawerGeometry.render(false);
