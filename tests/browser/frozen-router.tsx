import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { PagePan } from "../../src/shared/motion/PagePan";
import { PageZoom } from "../../src/shared/motion/PageZoom";

/**
 * 离场子树的**路由上下文**夹具。
 *
 * 回归的失效方式：`PagePan` / `PageZoom` 让上一页在过渡期间继续挂载，但上下文
 * 不是元素的一部分 —— 路由一变，`useLocation` / `useSearchParams` / `useParams`
 * 就会带着**新**页面的取值重渲染旧页面。播放页据此把自己渲染成「缺少有效参数」
 * 的错误态，于是退出动画里看到的是一块错误卡而不是正在播放的画面（VOD 返回
 * 视频页尤其明显：返回箭头按下后画面直接塌成错误提示）。
 *
 * 夹具把三种取值都画进 DOM，并记录每个页面实例的挂载次数 —— 修复既要冻结取值，
 * 也要保证旧子树**不被重新挂载**（重新挂载会销毁媒体元素与播放器实例）。
 *
 * 两组路由分别覆盖两个宿主：
 *   - `/list/:id` ⇄ `/play/:id`：`PageZoom`（沉浸式播放页进出，与 `Shell` 同构）；
 *   - `/a/:id` ⇄ `/b/:id`：`PagePan`（普通路由之间的平移，桌面侧栏与前进后退）。
 */
const log: { event: string; page: string; instance: number }[] = [];
let mountSeq = 0;
Object.assign(window, { frozenRouterLog: log });

function useInstance(page: string): number {
  const ref = useRef<number | null>(null);
  if (ref.current === null) ref.current = ++mountSeq;
  useLayoutEffect(() => {
    const instance = ref.current!;
    log.push({ event: "mount", page, instance });
    return () => log.push({ event: "unmount", page, instance });
  }, [page]);
  return ref.current;
}

/** 播放页形态：查询参数与路由参数都参与渲染。 */
function PlayPage() {
  const [search] = useSearchParams();
  const params = useParams();
  const instance = useInstance("play");
  return (
    <div data-page="play">
      play#{instance} bvid={search.get("bvid") ?? "-"} cid={search.get("cid") ?? "-"} id=
      {params.id ?? "-"}
    </div>
  );
}

/** 列表页形态：只有 location，没有查询参数。 */
function ListPage() {
  const location = useLocation();
  const instance = useInstance("list");
  return (
    <div data-page="list">
      list#{instance} path={location.pathname}
    </div>
  );
}

/** 普通路由页（`PagePan` 那一组）。 */
function PlainPage({ name }: { name: string }) {
  const [search] = useSearchParams();
  const params = useParams();
  const instance = useInstance(name);
  return (
    <div data-page={name}>
      {name}#{instance} view={search.get("view") ?? "-"} id={params.id ?? "-"}
    </div>
  );
}

function ZoomLayout() {
  const location = useLocation();
  const immersive = location.pathname.startsWith("/play");
  return (
    <PageZoom
      zoomKey={immersive ? location.pathname : "shell"}
      enabled={immersive}
      className="h-full"
    >
      <Outlet />
    </PageZoom>
  );
}

function PanLayout() {
  const location = useLocation();
  return (
    <PagePan panKey={location.pathname} direction={1} className="h-full">
      <Outlet />
    </PagePan>
  );
}

const router = createMemoryRouter(
  [
    {
      element: <ZoomLayout />,
      children: [
        { path: "/list/:id", element: <ListPage /> },
        { path: "/play/:id", element: <PlayPage /> },
      ],
    },
    {
      element: <PanLayout />,
      children: [
        { path: "/a/:id", element: <PlainPage name="a" /> },
        { path: "/b/:id", element: <PlainPage name="b" /> },
      ],
    },
  ],
  { initialEntries: ["/list/1"] },
);
createRoot(document.getElementById("fixture")!).render(<RouterProvider router={router} />);
Object.assign(window, { frozenRouterFixture: { router, log } });
