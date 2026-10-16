import { describe, expect, test } from "bun:test";
import { isCookieDependentSiteQuery } from "../src/shared/api/cookieQueryInvalidation";
import { isBilibiliAppQuery } from "../src/shared/api/bilibiliAppQueryInvalidation";

/**
 * 两条 VOD 偏好的默认值本身就是行为契约：
 *
 * - 推荐接口默认 App API，是当前已上线的横竖混合流；切到 Web 是用户的显式选择。
 * - 下一分集预加载默认关闭：它会额外下载下一集的 init 段与首个音视频分片，
 *   不能在升级或首次启动后未经选择就产生流量。
 */

/**
 * 旧记录与新配置包都可能缺这两个字段。回填必须是「安全的默认」而不是
 * 「任意真值」：字符串错值不得让推荐接口变成一条无法请求的上游。
 */

/**
 * 账号 Cookie 变化后必须刷新的缓存范围。
 *
 * App API 推荐不按 Web Cookie 个性化，设备 buvid 与独立 TV 授权的边界见
 * `docs/zh/B站视频功能设计.md`「推荐源与画幅适配」；Web API 推荐是
 * 「有 Cookie 才是个性化流」。因此切换推荐接口与账号变更都必须让推荐页重取。
 */
describe("推荐缓存与账号的耦合", () => {
  test("推荐页签的列表缓存随 B 站账号失效", () => {
    expect(isCookieDependentSiteQuery(["video_list", "recommend", "", "app"], "bilibili")).toBe(
      true,
    );
    expect(isCookieDependentSiteQuery(["video_list", "recommend", "", "web"], "bilibili")).toBe(
      true,
    );
  });
  test("不依赖账号的页签不被顺带失效", () => {
    for (const tab of ["popular", "anime", "cinema"]) {
      expect(isCookieDependentSiteQuery(["video_list", tab, "", "web"], "bilibili")).toBe(false);
    }
  });
  test("站点不匹配时不失效", () => {
    expect(isCookieDependentSiteQuery(["video_list", "recommend", "", "app"], "douyu")).toBe(false);
  });
});

/**
 * APP 授权变更影响的范围：三条流 —— VOD 主推荐、story、直播首页推荐。
 *
 * 开启、关闭或换授权后旧身份的在途结果必须丢弃，否则用户会看到「切了没变」；
 * 反过来 Web 推荐、热门、作者 story 与其他站点不应被顺带重置。
 *
 * 直播首页推荐容易漏：它的凭据是同一份 TV 凭据而不是 Web Cookie，
 * 因此 `isCookieDependentSiteQuery` 覆盖不到它。
 */
describe("APP 授权缓存失效范围", () => {
  test("App 推荐页、story 与直播首页都属于 APP 授权范围", () => {
    expect(isBilibiliAppQuery(["video_list", "recommend", "", "app", true, 1])).toBe(true);
    expect(isBilibiliAppQuery(["shorts_story"])).toBe(true);
    expect(isBilibiliAppQuery(["recommend", "bilibili", 3])).toBe(true);
  });
  test("Web 推荐与其他页签不受 APP 授权影响", () => {
    expect(isBilibiliAppQuery(["video_list", "recommend", "", "web", false, 0])).toBe(false);
    expect(isBilibiliAppQuery(["video_list", "popular", "", "web", false, 0])).toBe(false);
    expect(isBilibiliAppQuery(["shorts_uploader_story", "1", "2", 3])).toBe(false);
    expect(isBilibiliAppQuery(["video_zone_list"])).toBe(false);
    // 其他平台的首页推荐不带 TV 凭据，换授权不该让它们的缓存失效。
    expect(isBilibiliAppQuery(["recommend", "douyin", 0])).toBe(false);
    expect(isBilibiliAppQuery(["recommend", "huya", 0])).toBe(false);
  });
});

/** 当前 store 状态对应的后端设置对象；测试只覆盖这两条字段，其余原样带上。 */
