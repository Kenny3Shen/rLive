export function isImmersivePlayerPath(pathname: string): boolean {
  return (
    pathname.startsWith("/room/") ||
    pathname.startsWith("/recordings/play/") ||
    pathname === "/iptv/play" ||
    pathname === "/video/play" ||
    // 平台选择页保留导航外壳；只有两个推荐流使用满屏舞台与页内返回口。
    pathname === "/shorts/bilibili" ||
    pathname === "/shorts/douyin" ||
    pathname === "/multi-room"
  );
}
