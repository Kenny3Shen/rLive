/**
 * AcFun 内容区跨 IPC 类型。
 *
 * 这些 id 全部保持字符串：AcFun 视频 id 与 Bilibili BV/CID 不是同一种身份，
 * 不复用 `VideoItem` 可以避免两个平台的取流与选集语义互相泄漏。
 */

export type AcfunVideoItem = {
  id: string;
  title: string;
  cover: string;
  author: string;
  author_id?: string | null;
  author_avatar?: string | null;
  duration_sec: number;
  play_count: number;
  danmaku_count: number;
  comment_count?: number | null;
  published_at: number;
  channel_id?: string | null;
  channel_name?: string | null;
};

export type AcfunVideoListPage = {
  items: AcfunVideoItem[];
  has_more: boolean;
  next_page?: number | null;
};

export type AcfunVideoSection = {
  id: string;
  name: string;
};

export type AcfunVideoPart = {
  id: string;
  index: number;
  title: string;
  duration_sec: number;
  cover?: string | null;
};

export type AcfunVideoDetail = {
  item: AcfunVideoItem;
  description: string;
  tags: string[];
  parts: AcfunVideoPart[];
};

export type AcfunVideoQuality = {
  id: string;
  label: string;
  available: boolean;
};

export type AcfunVideoPlayInfo = {
  url: string;
  quality: string;
  quality_label: string;
  protocol: string;
  accept_qualities: AcfunVideoQuality[];
  headers: Record<string, string>;
  session_id: string;
};

export type AcfunCommentSort = "hot" | "time";

export type AcfunVideoComment = {
  id: string;
  parent_id?: string | null;
  author: string;
  author_id?: string | null;
  avatar?: string | null;
  content: string;
  created_at: number;
  like_count: number;
  is_uploader: boolean;
  pictures: string[];
  reply_to_name?: string | null;
  /** 一级评论首屏附带的楼中楼预览，最多约三条。 */
  replies: AcfunVideoComment[];
  reply_count: number;
};

export type AcfunCommentPage = {
  items: AcfunVideoComment[];
  has_more: boolean;
  next_page?: number | null;
  /** 评论与回复的聚合总数，不是当前页主评论条数。 */
  total: number;
};

export type AcfunCommentReplyPage = {
  items: AcfunVideoComment[];
  has_more: boolean;
  next_cursor?: string | null;
  total: number;
};

export type AcfunArticleChannel = {
  id: string;
  name: string;
};

export type AcfunArticleItem = {
  id: string;
  title: string;
  summary: string;
  cover?: string | null;
  author: string;
  author_id?: string | null;
  view_count: number;
  comment_count: number;
  published_at: number;
  channel_id?: string | null;
  channel_name?: string | null;
};

export type AcfunArticleListPage = {
  items: AcfunArticleItem[];
  has_more: boolean;
  /** 下一次请求的文章游标；缺省表示不能继续或已经结束。 */
  next_cursor?: string | null;
};

export type AcfunArticleInline =
  | { type: "text"; text: string; bold?: boolean; italic?: boolean }
  | { type: "link"; text: string; url: string; bold?: boolean; italic?: boolean };

export type AcfunArticleBlock =
  | { type: "paragraph"; text: string; inlines?: AcfunArticleInline[] }
  | { type: "heading"; level: number; text: string }
  | { type: "image"; url: string; alt?: string | null }
  | { type: "link"; text: string; url: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string | null; text: string }
  | { type: "divider" };

export type AcfunArticleDetail = {
  item: AcfunArticleItem;
  tags: string[];
  blocks: AcfunArticleBlock[];
};
