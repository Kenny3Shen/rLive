export function isImmersivePlayerPath(pathname: string): boolean {
  return (
    pathname.startsWith("/room/") ||
    pathname.startsWith("/recordings/play/") ||
    pathname === "/iptv/play" ||
    pathname === "/multi-room"
  );
}
