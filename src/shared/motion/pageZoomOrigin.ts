/** 来源窗口相对于 PageZoom 宿主的归一化矩形；不持有可能已卸载的卡片 DOM。 */
export type ZoomRect = Readonly<{ left: number; top: number; width: number; height: number }>;
export type PageZoomOrigin = Readonly<{
  id: string;
  page: string;
  rect: ZoomRect;
}>;

type Rect = Readonly<{ left: number; top: number; width: number; height: number }>;

/** 只保留宿主内可见的部分，安全区、标题栏与宿主偏移不参与放大。 */
export function normalizeZoomRect(rect: Rect, scope: Rect): ZoomRect | null {
  if (
    ![
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      scope.left,
      scope.top,
      scope.width,
      scope.height,
    ].every(Number.isFinite) ||
    scope.width <= 0 ||
    scope.height <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  const left = Math.max(rect.left, scope.left);
  const top = Math.max(rect.top, scope.top);
  const right = Math.min(rect.left + rect.width, scope.left + scope.width);
  const bottom = Math.min(rect.top + rect.height, scope.top + scope.height);
  if (right <= left || bottom <= top) return null;
  return {
    left: (left - scope.left) / scope.width,
    top: (top - scope.top) / scope.height,
    width: (right - left) / scope.width,
    height: (bottom - top) / scope.height,
  };
}

/** FLIP：最终布局已经铺满宿主，只补间 transform，不逐帧修改布局尺寸。 */
export function zoomRectTransform(rect: ZoomRect): string {
  const format = (value: number) => String(Number(value.toFixed(5)));
  const x = (rect.left + rect.width / 2 - 0.5) * 100;
  const y = (rect.top + rect.height / 2 - 0.5) * 100;
  return `translate(${format(x)}%, ${format(y)}%) scale(${format(rect.width)}, ${format(rect.height)})`;
}

export function readZoomOrigin(
  element: HTMLElement,
  scope: HTMLElement,
  page: string,
): PageZoomOrigin | null {
  const id = element.dataset.playerOrigin;
  const rect = normalizeZoomRect(element.getBoundingClientRect(), scope.getBoundingClientRect());
  return id && rect ? { id, page, rect } : null;
}

/** 返回时优先测量恢复后的卡片；卡片未加载或已离屏时使用进入时的归一化窗口。 */
export function resolveZoomOrigin(
  origin: PageZoomOrigin | null,
  page: string,
  incoming: HTMLElement,
  scope: HTMLElement,
): ZoomRect | null {
  if (!origin || origin.page !== page) return null;
  const card = Array.from(incoming.querySelectorAll<HTMLElement>("[data-player-origin]")).find(
    (element) => element.dataset.playerOrigin === origin.id,
  );
  return (card && readZoomOrigin(card, scope, page)?.rect) || origin.rect;
}
