export function isImmersivePlayerPath(pathname: string): boolean {
  return (
    pathname.startsWith("/room/") ||
    pathname.startsWith("/recordings/play/") ||
    pathname === "/iptv/play" ||
    pathname === "/video/play" ||
    // 短视频推荐流使用满屏舞台与页内返回口。旧的 `/shorts` 平台选择页已下线，
    // 只在 loader 里重定向，不会再作为可见页面出现。
    pathname === "/shorts/bilibili" ||
    pathname === "/multi-room"
  );
}
