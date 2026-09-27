import { describe, expect, test } from "bun:test";
import {
  VIDEO_NEXT_EPISODE_PRELOAD_DEFAULT,
  VIDEO_RECOMMEND_API_DEFAULT,
  useSettingsStore,
} from "../src/shared/stores/settingsStore";
import { isCookieDependentSiteQuery } from "../src/shared/api/cookieQueryInvalidation";
import { isBilibiliAppQuery } from "../src/shared/api/bilibiliAppQueryInvalidation";

/**
 * 两条 VOD 偏好的默认值本身就是行为契约：
 *
 * - 推荐接口默认 App API，是当前已上线的横竖混合流；切到 Web 是用户的显式选择。
 * - 下一分集预加载默认关闭：它会额外下载下一集的 init 段与首个音视频分片，
 *   不能在升级或首次启动后未经选择就产生流量。
 */
describe("VOD 偏好默认值", () => {
  test("推荐接口默认 App API", () => {
    expect(VIDEO_RECOMMEND_API_DEFAULT).toBe("app");
    expect(useSettingsStore.getState().videoRecommendApi).toBe("app");
  });

  test("下一分集预加载默认关闭", () => {
    expect(VIDEO_NEXT_EPISODE_PRELOAD_DEFAULT).toBe(false);
    expect(useSettingsStore.getState().videoNextEpisodePreload).toBe(false);
  });
});

/**
 * 旧记录与新配置包都可能缺这两个字段。回填必须是「安全的默认」而不是
 * 「任意真值」：字符串错值不得让推荐接口变成一条无法请求的上游。
 */
describe("VOD 偏好回填", () => {
  test("后端记录缺字段时回填默认值", () => {
    const base = useSettingsStore.getState();
    useSettingsStore.getState().applyFromBackend({
      ...settingsFromState(),
      video_recommend_api: undefined as unknown as "app",
      video_next_episode_preload: undefined as unknown as boolean,
    });
    expect(useSettingsStore.getState().videoRecommendApi).toBe("app");
    expect(useSettingsStore.getState().videoNextEpisodePreload).toBe(false);
    // 其余字段保持既有取值，回填不顺手改动别的设置。
    expect(useSettingsStore.getState().qualityLevel).toBe(base.qualityLevel);
  });

  test("无法识别的推荐接口取值退回 App API", () => {
    useSettingsStore.getState().applyFromBackend({
      ...settingsFromState(),
      video_recommend_api: "rdm" as unknown as "app",
    });
    expect(useSettingsStore.getState().videoRecommendApi).toBe("app");
  });

  test("显式选择 Web API 与开启预加载都被保留", () => {
    useSettingsStore.getState().applyFromBackend({
      ...settingsFromState(),
      video_recommend_api: "web",
      video_next_episode_preload: true,
    });
    expect(useSettingsStore.getState().videoRecommendApi).toBe("web");
    expect(useSettingsStore.getState().videoNextEpisodePreload).toBe(true);
  });
});

/**
 * 账号 Cookie 变化后必须刷新的缓存范围。
 *
 * App API 推荐不按 Cookie 个性化（设备轴才是旋钮，见
 * `docs/zh/短视频调研-B站与抖音.md` 的实测），但 Web API 推荐是
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
 * APP 授权变更影响的范围：两条 APP 推荐流（主推荐与 story）。
 *
 * 开启、关闭或换授权后旧身份的在途结果必须丢弃，否则用户会看到「切了没变」；
 * 反过来 Web 推荐、热门、作者 story 不应被顺带重置。
 */
describe("APP 授权缓存失效范围", () => {
  test("App 推荐页与 story 都属于 APP 授权范围", () => {
    expect(isBilibiliAppQuery(["video_list", "recommend", "", "app", true, 1])).toBe(true);
    expect(isBilibiliAppQuery(["shorts_story"])).toBe(true);
  });

  test("Web 推荐与其他页签不受 APP 授权影响", () => {
    expect(isBilibiliAppQuery(["video_list", "recommend", "", "web", false, 0])).toBe(false);
    expect(isBilibiliAppQuery(["video_list", "popular", "", "web", false, 0])).toBe(false);
    expect(isBilibiliAppQuery(["shorts_uploader_story", "1", "2", 3])).toBe(false);
    expect(isBilibiliAppQuery(["video_zone_list"])).toBe(false);
  });
});

/** 当前 store 状态对应的后端设置对象；测试只覆盖这两条字段，其余原样带上。 */
function settingsFromState() {
  const state = useSettingsStore.getState();
  return {
    theme: state.theme,
    default_site: state.siteId,
    disabled_site_ids: state.disabledSiteIds,
    hidden_home_entry_ids: state.hiddenHomeEntryIds,
    proxy: state.proxy,
    danmaku_opacity: state.danmakuOpacity,
    danmaku_font_stroke: state.danmakuFontStroke,
    danmaku_font_size: state.danmakuFontSize,
    danmaku_speed: state.danmakuSpeed,
    danmaku_area: state.danmakuArea,
    danmaku_filter_gifts: state.danmakuFilterGifts,
    danmaku_merge_window_seconds: state.danmakuMergeWindowSeconds,
    super_chat_enabled: state.superChatEnabled,
    danmaku_shield_words: state.danmakuShieldWords,
    danmaku_blocked_users: state.danmakuBlockedUsers,
    quality_level: state.qualityLevel,
    playback_soft_switch_enabled: state.playbackSoftSwitchEnabled,
    video_recommend_api: state.videoRecommendApi,
    video_next_episode_preload: state.videoNextEpisodePreload,
    room_card_preview_enabled: state.roomCardPreviewEnabled,
    dynamic_background_enabled: state.dynamicBackgroundEnabled,
    danmaku_send_enabled: state.danmakuSendEnabled,
    asr_enabled: state.asrEnabled,
    asr_provider: state.asrProvider,
    asr_vad_enabled: state.asrVadEnabled,
    asr_punctuation_enabled: state.asrPunctuationEnabled,
    asr_speaker_diarization_enabled: state.asrSpeakerDiarizationEnabled,
    asr_hotwords: state.asrHotwords,
    asr_window_seconds: state.asrWindowSeconds,
    asr_font_size: state.asrFontSize,
    asr_translation_enabled: state.asrTranslationEnabled,
    asr_translation_from: state.asrTranslationFrom,
    asr_translation_to: state.asrTranslationTo,
    iptv_custom_m3u_url: state.iptvCustomM3uUrl,
    recording_include_danmaku: state.recordingIncludeDanmaku,
    recording_auto_split_minutes: state.recordingAutoSplitMinutes,
    recording_max_concurrent: state.recordingMaxConcurrent,
    ffmpeg_rw_timeout_seconds: state.ffmpegRwTimeoutSeconds,
    ffmpeg_reconnect_delay_max_seconds: state.ffmpegReconnectDelayMaxSeconds,
    ffmpeg_hls_segment_retry_count: state.ffmpegHlsSegmentRetryCount,
    recording_ass: state.recordingAssSettings,
  };
}
