declare module "@/vendor/mpegts.js" {
  import type { MpegtsStatic } from "./mpegts";
  const mpegts: MpegtsStatic;
  export default mpegts;
}

declare module "*.js" {
  const value: unknown;
  export default value;
}
