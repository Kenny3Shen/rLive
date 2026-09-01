import type { LiveRoomItem } from "@/shared/types/live";

export type RoomCardLabels = {
  /** 平台明确说了未开播。缺省（分类/推荐列表）不算未开播。 */
  offline: boolean;
  /** 卡片主标题：直播标题优先，未开播没有标题时退回主播名。 */
  primaryText: string;
  /** 卡片副标题。为空字符串时只占位，不显示文字。 */
  secondaryText: string;
  /** 是否显示热度角标。未开播或人数为 0 时不显示。 */
  showOnline: boolean;
};

/**
 * 由房间条目推导卡片上的文字与角标。
 *
 * 搜索会返回未开播的主播，这些条目没有直播标题、也没有当前人数：
 * 主标题退回主播名、副行改说开播状态，避免显示成「未命名直播间 / 主播名」
 * 这种既冗余又误导的两行；人数为 0 时也不硬显示一个「0」。
 */
export function roomCardLabels(room: LiveRoomItem): RoomCardLabels {
  const offline = room.live_status === false;
  const roomTitle = room.title.trim();
  const userName = room.user_name.trim();
  return {
    offline,
    primaryText: roomTitle || userName || "未命名直播间",
    secondaryText: roomTitle ? userName || "未知主播" : offline ? "未开播" : "",
    showOnline: !offline && room.online > 0,
  };
}
