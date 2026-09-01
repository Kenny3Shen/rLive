import { isSiteId } from "@/shared/siteId";
import type { LiveCategory, LiveSubCategory, SiteId } from "@/shared/types/live";

/**
 * 首页分区选择的查询参数名。首页把「推荐 + 分区」合成同一个发现表面，
 * 因此分区不再是独立路由，而是首页的一个可分享状态。
 */
export const CATEGORY_PARAM = "cat";

/**
 * 一次分区选择的完整身份。
 *
 * 参数里带 `siteId` 不是冗余：移动端首页用一个横滑 track 同时挂载相邻平台的
 * 多个面板（见 `Shell.tsx` 的 `liveSwipePanels`），这些面板共享同一个 URL、
 * 只有 platform scope 不同。把平台写进参数后，非当前平台的面板解析出 null
 * 自然回落到推荐态，切平台不需要任何「清参数」逻辑，切走再切回还能恢复
 * 原平台上的选择。
 */
export type CategorySelection = Readonly<{
  siteId: SiteId;
  parentId: string;
  categoryId: string;
}>;

/**
 * 编码成 `?cat=` 的值。用 `siteId:parentId:categoryId` 而不是 JSON，
 * 是为了让 URL 保持可读、可手写、可分享。
 */
export function encodeCategorySelection(selection: CategorySelection): string {
  return `${selection.siteId}:${selection.parentId}:${selection.categoryId}`;
}

/**
 * 解析 `?cat=` 值。格式不符、平台 id 未知、或平台与当前 `siteId` 不匹配时返回
 * null —— 后者正是多面板并存时「只有属主面板认领这个参数」的保障。
 *
 * 分类 id 可能含逗号（抖音是 `101,2` 这种）但不会含冒号，所以只定位前两个冒号，
 * 第三段整体保留；用 `split(":")` 会把含冒号的 id 切碎。
 */
export function parseCategorySelection(
  value: string | null,
  siteId: SiteId,
): CategorySelection | null {
  if (!value) return null;

  const firstColon = value.indexOf(":");
  if (firstColon <= 0) return null;
  const secondColon = value.indexOf(":", firstColon + 1);
  if (secondColon < 0) return null;

  const site = value.slice(0, firstColon);
  const parentId = value.slice(firstColon + 1, secondColon);
  const categoryId = value.slice(secondColon + 1);
  if (!parentId || !categoryId) return null;
  if (!isSiteId(site) || site !== siteId) return null;

  return { siteId: site, parentId, categoryId };
}

/** 首页 URL；传 null 得到不带参数的推荐态首页。 */
export function homeCategoryPath(selection: CategorySelection | null): string {
  if (!selection) return "/";
  const query = new URLSearchParams({ [CATEGORY_PARAM]: encodeCategorySelection(selection) });
  return `/?${query.toString()}`;
}

/** 桌面端「全部分类」页的路径。 */
export const CATEGORY_BROWSE_PATH = "/category";

/**
 * 分类页 URL，带上当前选中态使分类墙能回显「你正在看哪个分区」。
 *
 * 复用首页那个 `?cat=` 参数而不是另立一个：同一个分区身份在两个表面上应当只有
 * 一种写法，否则两处解析规则会各自漂移。分类页对这个参数是只读的。
 */
export function categoryBrowsePath(selection: CategorySelection | null): string {
  if (!selection) return CATEGORY_BROWSE_PATH;
  const query = new URLSearchParams({ [CATEGORY_PARAM]: encodeCategorySelection(selection) });
  return `${CATEGORY_BROWSE_PATH}?${query.toString()}`;
}

/** chips 条上直接可见的分区数量上限，超出的留给展开面板。 */
export const CATEGORY_CHIP_LIMIT = 12;

export type CategoryChip = Readonly<{
  /** 稳定 key，同时用于比较选中态。 */
  key: string;
  label: string;
  /**
   * 所属父分区名，仅深层子分类有。
   *
   * 条带上绝大多数项是父分区的「全部X」聚合入口，唯一的例外是从展开面板选进来、被
   * `categoryChips` 插到自己父项之后的那一个深层子分类。它光显示子分类名看不出隶属
   * 关系（「原神」插在「手游」之后，读起来像又一个平级分区），所以带上父分区名构成
   * 复合标签。聚合项不需要：它的标签本身就是父分区名。
   */
  parentLabel?: string;
  category: LiveSubCategory;
}>;

/**
 * 父分区的「全部X」聚合项。后端约定 id "0" 表示按 parent_id 聚合，
 * 因此这一项无需真实子分类 id 就能直接喂给 `site_get_category_rooms`。
 */
export function allCategoryOf(parent: LiveCategory): LiveSubCategory {
  return {
    id: "0",
    name: `全部${parent.name}`,
    parent_id: parent.id,
    pic: null,
  };
}

/** chip key 与选中态比较都走这一个规则，避免两处口径漂移。 */
export function categoryChipKey(parentId: string, categoryId: string): string {
  return `${parentId}:${categoryId}`;
}

/**
 * `label` 与 `category.name` 分开的原因：聚合项在条带上叫「网游」，在展开面板里
 * 叫「全部网游」。面板里那一格紧挨着「网游」分组标题，不带前缀会看起来像一个
 * 名叫「网游」的子分类；而条带上父分区之间横向并列，前缀对每一项都成立，纯属
 * 复读 —— 一行「全部网游 全部手游 全部娱乐」把宽度让给了没有信息量的两个字。
 */
function chipOf(
  category: LiveSubCategory,
  label = category.name,
  parentLabel?: string,
): CategoryChip {
  return {
    key: categoryChipKey(category.parent_id, category.id),
    label,
    ...(parentLabel ? { parentLabel } : {}),
    category,
  };
}

/**
 * 展开面板里是否还有 chips 条上看不到的分类，决定「全部分类」入口是否值得显示。
 *
 * 与 `categoryChips` 分开导出而不是让它多返回一个字段：这个判断与选中态无关，
 * 且组件里「条带内容」和「展开入口可见性」本来就是两个独立关注点。调用方因此
 * 无需自己再数一遍 children，避免把扁平化规则在组件里重新推导一次。
 */
export function hasHiddenCategories(categories: readonly LiveCategory[]): boolean {
  if (categories.length === 0) return false;
  // 多父分区时 chips 只有聚合项，任何子分类都只能从面板进入。
  if (categories.length > 1) return categories.some((parent) => parent.children.length > 0);
  return categoryEntriesOf(categories, categories[0]!).length > CATEGORY_CHIP_LIMIT;
}

/**
 * 一个父分区在条带与面板里应当列出的条目（可能包含开头的「全部X」聚合项）。
 *
 * 聚合项只在多父分区时才有意义。单父分区平台（Twitch；虎牙目录接口降级后也是
 * 这个形状）的那一个父分区就是全站，「全部X」于是与「推荐」完全重叠 —— 后端对
 * id "0" 的请求直接转给了 `get_recommend_rooms`，两个入口打同一个接口、返回同一批
 * 房间。因此这种形状下不合成聚合项，条带直接从「推荐」接真子分类。
 *
 * 后端自带 id "0" 子项时不重复合成，否则会出现两个「全部X」。
 */
export function categoryEntriesOf(
  categories: readonly LiveCategory[],
  parent: LiveCategory,
): readonly LiveSubCategory[] {
  if (parent.children.some((child) => child.id === "0")) return parent.children;
  if (categories.length <= 1) return parent.children;
  return [allCategoryOf(parent), ...parent.children];
}

/**
 * 把两级分类扁平成单行 chips（不含「推荐」项，那个由组件加）。
 *
 * 多父分区平台（B站/斗鱼/虎牙）每个父分区只出「全部X」聚合项：一条横滚放得下，
 * 且每项都直接可用。单父分区平台（Twitch 只有一个「热门分类」）没有可聚合的层级，
 * 于是直接铺该父分区的前若干 children（不包含聚合项，理由见 `categoryEntriesOf`）。
 *
 * 选中项若不在上述结果里（只能从展开面板选到的深层子分类），插入到其父项之后，
 * 保证选中态永远在条里可见，用户能一键滑到相邻分区。
 */
export function categoryChips(
  categories: readonly LiveCategory[],
  selection: CategorySelection | null,
): CategoryChip[] {
  if (categories.length === 0) return [];

  // 聚合项的条带标签一律取父分区名，而不是从 `name` 里裁掉「全部」二字：后端
  // 自带的 id "0" 子项名字不受我们控制（可能是「网游全部」这类语序），裁前缀会
  // 漏掉它们。父分区名才是这一项真正代表的东西。
  const chips =
    categories.length > 1
      ? categories.map((parent) => {
          const existingAll = parent.children.find((child) => child.id === "0");
          return chipOf(existingAll ?? allCategoryOf(parent), parent.name);
        })
      : categoryEntriesOf(categories, categories[0]!)
          .slice(0, CATEGORY_CHIP_LIMIT)
          .map((child) => chipOf(child, child.id === "0" ? categories[0]!.name : child.name));

  if (!selection) return chips;

  const selectedKey = categoryChipKey(selection.parentId, selection.categoryId);
  if (chips.some((chip) => chip.key === selectedKey)) return chips;

  const parent = categories.find((item) => item.id === selection.parentId);
  const child = parent?.children.find((item) => item.id === selection.categoryId);
  if (!parent || !child) return chips;

  // 紧随父项插入：视觉上仍属于那个父分区，滑动方向也符合直觉。
  const parentIndex = chips.findIndex((chip) => chip.category.parent_id === parent.id);
  const inserted = [...chips];
  inserted.splice(
    parentIndex < 0 ? inserted.length : parentIndex + 1,
    0,
    chipOf(child, child.name, parent.name),
  );
  return inserted;
}

/**
 * 标记由首页分类栏 push 出来的历史条目。照 `SIDEBAR_NAVIGATION_STATE` 的模式，
 * 用 location state 而不是猜测 history 长度来判断能否安全回退。
 */
export const CATEGORY_PUSH_STATE = { rliveCategorySource: "home-category" } as const;

/** 当前历史条目是否由首页分类栏 push 出来。 */
export function isCategoryPushEntry(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  return (
    "rliveCategorySource" in state &&
    (state as { rliveCategorySource?: unknown }).rliveCategorySource ===
      CATEGORY_PUSH_STATE.rliveCategorySource
  );
}

export type CategoryNavigationIntent =
  | Readonly<{ kind: "push" | "replace"; path: string }>
  | Readonly<{ kind: "back" }>;

/**
 * 推荐→分区 push（保留「返回回到推荐」的系统级手势）；分区→分区 replace
 * （chips 来回切不堆历史）；分区→推荐在本页 push 过时回退历史，
 * 否则（深链接直接进入分区态）replace 到干净首页。
 *
 * `next` 与 `current` 相同视作 replace 同路径：调用方可以无条件调用而不必先比较，
 * 也不会产生多余历史条目。
 */
export function categoryNavigationIntent(
  current: CategorySelection | null,
  next: CategorySelection | null,
  entryState: unknown,
): CategoryNavigationIntent {
  const path = homeCategoryPath(next);

  if (sameSelection(current, next)) return { kind: "replace", path };
  if (next) return { kind: current ? "replace" : "push", path };
  return isCategoryPushEntry(entryState) ? { kind: "back" } : { kind: "replace", path };
}

function sameSelection(a: CategorySelection | null, b: CategorySelection | null): boolean {
  if (!a || !b) return a === b;
  return a.siteId === b.siteId && a.parentId === b.parentId && a.categoryId === b.categoryId;
}

/**
 * 把选中态解析成 `site_get_category_rooms` 需要的 `LiveSubCategory`。
 *
 * 名字不写进 URL：URL 只保留 id，展示名从已缓存的 `["categories", siteId]` 解析，
 * 保证分类名只有一个数据来源、不会因为平台改名而留下过期的分享链接。代价是
 * 冷启动深链接要多一次串行往返（先取分类树再取房间），这是有意取舍。
 *
 * 解析不到时给中性兜底：id/parent_id 沿用 selection 的值，后端仍能正常返回房间，
 * 只是标题暂时显示通用文案。`fallbackName` 留给仍把分类名带在 URL 里的旧路由，
 * 它有更好的兜底文案可用。
 */
export const CATEGORY_FALLBACK_NAME = "分区直播";

export function resolveSelectedCategory(
  categories: readonly LiveCategory[] | undefined,
  selection: Pick<CategorySelection, "parentId" | "categoryId">,
  fallbackName = CATEGORY_FALLBACK_NAME,
): LiveSubCategory {
  const parent = categories?.find((item) => item.id === selection.parentId);
  const child = parent?.children.find((item) => item.id === selection.categoryId);
  if (child) return child;
  if (parent && selection.categoryId === "0") return allCategoryOf(parent);

  return {
    id: selection.categoryId,
    name: fallbackName || CATEGORY_FALLBACK_NAME,
    parent_id: selection.parentId,
    pic: null,
  };
}
