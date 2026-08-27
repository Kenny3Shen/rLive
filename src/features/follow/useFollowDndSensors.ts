import { KeyboardSensor, MouseSensor, useSensor, useSensors } from "@dnd-kit/core";

/** 直播房间与 IPTV 收藏分组共享的 DND 传感器。 */
export function useFollowDndSensors() {
  // 移动端长按操作抽屉在同一张卡片上拥有触摸长按。TouchSensor 会先激活，
  // 使 DND 与模态抽屉同时处理同一个手势 —— 而且在抽屉与路由变更处理期间
  // DND 仍可能阻止原生滚动。移动端用户可以通过长按弹出的抽屉移动条目；
  // 鼠标与键盘拖拽保持可用。
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
}
