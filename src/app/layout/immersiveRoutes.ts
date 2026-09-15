export function isImmersivePlayerPath(pathname: string): boolean {
  return (
    pathname.startsWith("/room/") ||
    pathname.startsWith("/recordings/play/") ||
    pathname === "/iptv/play" ||
    pathname === "/video/play" ||
    // 短视频是竖屏满屏消费：外壳的顶栏与侧栏会把 9:16 舞台挤成一条，
    // 返回口由页内 HUD 提供（与其他沉浸播放页同一位置同一画法）。
    pathname === "/shorts" ||
    pathname === "/multi-room"
  );
}
