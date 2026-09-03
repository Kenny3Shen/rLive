/**
 * 视频页的路由契约与页签语义。
 *
 * 抽成纯函数模块（不 import React）是为了让页签 → 条带内容、以及播放链接的
 * 参数组合都能单测，同时 Shell 只为一条页签切换器付出一次 import。
 */

export const VIDEO_HOME_PATH = "/video";
export const VIDEO_PLAY_PATH = "/video/play";

/** 头部整行的四个内容页签。顺序即移动端横滑与 `PagePan` 的方向顺序。 */
export const VIDEO_TABS = ["recommend", "popular", "anime", "cinema"] as const;

export type VideoTab = (typeof VIDEO_TABS)[number];

export const VIDEO_TAB_LABELS: Record<VideoTab, string> = {
  recommend: "推荐",
  popular: "热门",
  anime: "番剧",
  cinema: "影视",
};

export const VIDEO_TAB_PARAM = "tab";
export const VIDEO_ZONE_PARAM = "zone";

export function isVideoTab(value: unknown): value is VideoTab {
  return typeof value === "string" && (VIDEO_TABS as readonly string[]).includes(value);
}

/** 未知或缺失的页签一律回落推荐流，深链接因此不会打开空表面。 */
export function videoTabFromSearch(value: string | null): VideoTab {
  return isVideoTab(value) ? value : "recommend";
}

/**
 * 番剧 / 影视页签下「分区」的语义是 season_type 筛选，不是 UGC 的 rid。
 *
 * 番剧页签的条带列的是同为剧集的 season_type（番剧 1、国创 4、纪录 3），影视页签
 * 列的是电影 2、剧集 5、综艺 7 —— 与设计文档第一节锁定的产品决策一致。
 */
export const PGC_SEASON_TYPES = {
  anime: 1,
  guochuang: 4,
  documentary: 3,
  movie: 2,
  teleplay: 5,
  variety: 7,
} as const;

export type VideoZoneChip = {
  /** chip 的稳定身份，也是 `?zone=` 的取值。 */
  key: string;
  label: string;
};

/** 番剧页签的分区条：同属剧番的三个 season_type。 */
const ANIME_ZONE_CHIPS: readonly VideoZoneChip[] = [
  { key: String(PGC_SEASON_TYPES.anime), label: "番剧" },
  { key: String(PGC_SEASON_TYPES.guochuang), label: "国创" },
  { key: String(PGC_SEASON_TYPES.documentary), label: "纪录片" },
];

/** 影视页签的分区条。 */
const CINEMA_ZONE_CHIPS: readonly VideoZoneChip[] = [
  { key: String(PGC_SEASON_TYPES.movie), label: "电影" },
  { key: String(PGC_SEASON_TYPES.teleplay), label: "剧集" },
  { key: String(PGC_SEASON_TYPES.variety), label: "综艺" },
];

/**
 * 该页签是否有分区条。
 *
 * 推荐没有：它就是一条个性化信息流，没有分区概念。其余三个都有：
 * 热门挂 UGC 分区（首项「全部」= 全站热门榜，其余项 = 分区榜），
 * 番剧 / 影视挂 season_type 筛选。
 */
export function videoTabHasZoneStrip(tab: VideoTab): boolean {
  return tab !== "recommend";
}

/** 该页签的分区条是否为 PGC 的 season_type 筛选（而不是 UGC 的 rid）。 */
export function videoTabUsesPgc(tab: VideoTab): boolean {
  return tab === "anime" || tab === "cinema";
}

/**
 * 热门页签分区条的首项。
 *
 * 它不是一个 rid：选中时走 `video_get_popular`（全站热门，可翻页），而其余项走
 * `video_get_zone(rid)`（分区榜，单页）。两者同居一条条带是因为它们回答的是同一个
 * 问题「看哪一块的热门」，不是两个平行表面。
 */
export const VIDEO_POPULAR_ALL_ZONE_KEY = "all";

/**
 * 页签下的分区 chip 列表。
 *
 * UGC 分区（本应用只在番剧/影视之外用到它）由 `video_zone_list()` 提供，所以要把
 * 后端返回的 `[名称, rid]` 传进来；PGC 两个页签的条带是固定的 season_type 集合，
 * 与后端无关。
 */
export function videoZoneChips(
  tab: VideoTab,
  ugcZones: readonly (readonly [string, number])[],
): readonly VideoZoneChip[] {
  if (tab === "anime") return ANIME_ZONE_CHIPS;
  if (tab === "cinema") return CINEMA_ZONE_CHIPS;
  if (tab === "popular") {
    return [
      { key: VIDEO_POPULAR_ALL_ZONE_KEY, label: "全部" },
      ...ugcZones.map(([label, rid]) => ({ key: String(rid), label })),
    ];
  }
  return [];
}

/**
 * 页签当前生效的分区 key。
 *
 * `?zone=` 只有落在该页签自己的条带里才认，于是换页签时上一页签残留的 zone 参数
 * 自动失效、回落该页签的首项，而不是把番剧的 season_type 喂给 UGC 分区接口。
 */
export function resolveVideoZoneKey(
  tab: VideoTab,
  requested: string | null,
  chips: readonly VideoZoneChip[],
): string | null {
  if (!videoTabHasZoneStrip(tab)) return null;
  if (requested && chips.some((chip) => chip.key === requested)) return requested;
  return chips[0]?.key ?? null;
}

export function videoHomePath(tab: VideoTab, zone?: string | null): string {
  const params = new URLSearchParams();
  if (tab !== "recommend") params.set(VIDEO_TAB_PARAM, tab);
  if (zone) params.set(VIDEO_ZONE_PARAM, zone);
  const query = params.toString();
  return query ? `${VIDEO_HOME_PATH}?${query}` : VIDEO_HOME_PATH;
}

export type VideoPlayTarget = {
  /** UGC 必填；PGC 分集也带着它，仅用于展示与回链。 */
  bvid?: string | null;
  cid: number;
  /** 填了就走 PGC playurl。 */
  epId?: string | null;
  title?: string | null;
  /** 稿件 av 号，评论区的 `oid`。列表/分集数据都有；URL 直入时由播放页补齐。 */
  aid?: string | null;
};

/** 播放页链接。cid 是两条链路都必需的键，缺它无法取流。 */
export function videoPlayPath(target: VideoPlayTarget): string {
  const params = new URLSearchParams();
  params.set("cid", String(target.cid));
  if (target.bvid) params.set("bvid", target.bvid);
  if (target.epId) params.set("ep_id", target.epId);
  if (target.title) params.set("title", target.title);
  if (target.aid) params.set("aid", target.aid);
  return `${VIDEO_PLAY_PATH}?${params.toString()}`;
}

export type VideoPlayParams = {
  cid: number;
  bvid: string | null;
  epId: string | null;
  title: string | null;
  aid: string | null;
};

/**
 * 解析播放页参数。cid 不是正整数就返回 null，让页面渲染可读的失败态而不是拿 NaN
 * 去请求后端。aid 是评论区的键，可缺省：相关视频/分集链路带着它，URL 直入时由
 * 播放页用稿件详情补齐。
 */
export function parseVideoPlayParams(search: URLSearchParams): VideoPlayParams | null {
  const cid = Number(search.get("cid"));
  if (!Number.isSafeInteger(cid) || cid <= 0) return null;
  return {
    cid,
    bvid: search.get("bvid") || null,
    epId: search.get("ep_id") || null,
    title: search.get("title") || null,
    aid: search.get("aid") || null,
  };
}
