import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import packageMetadata from "../../../package.json";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ChevronRight,
  CircleDot,
  Database,
  Download,
  ExternalLink,
  Info,
  LogOut,
  MonitorPlay,
  Network,
  Palette,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  SearchX,
  ShieldAlert,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { invokeCmd } from "@/shared/api/tauri";
import { fadeTheme } from "@/app/theme";
import { invalidateCookieDependentSiteQueries } from "@/shared/api/cookieQueryInvalidation";
import { enabledSiteIds, LIVE_SITE_IDS } from "@/shared/siteId";
import type { AsrProvider, SiteId } from "@/shared/types/live";
import {
  ASR_FONT_SIZE_DEFAULT,
  ASR_WINDOW_SECONDS_DEFAULT,
  ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
  useSettingsStore,
  type ThemeMode,
} from "@/shared/stores/settingsStore";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { isMobileClient, isWindowsDesktop } from "@/shared/clientPlatform";
import { PagePan } from "@/shared/motion/PagePan";
import { describeAsrModelStatus, useAsrModelStatus } from "@/features/asr/model";
import {
  AsrCaptionFontSizeField,
  AsrChunkIntervalField,
  AsrHotwordsField,
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
  resetDanmakuAppearanceSettings,
} from "@/features/settings/PlaybackPreferenceFields";
import { cn, SITE_LABELS } from "@/lib/utils";
import { directPlayerPath } from "@/features/iptv/iptvRoute";
import { isHttpUrl } from "@/features/iptv/playlistSource";
import { FieldTip } from "@/features/settings/FieldTip";
import { ImageCacheField } from "@/features/settings/CacheSettings";
import { AppLogField } from "@/features/settings/AppLogField";
import { LanSyncField } from "@/features/settings/LanSyncField";
import {
  FfmpegSettingsFields,
  RecordingAssSettingsFields,
  RecordingDefaultsFields,
} from "@/features/settings/RecordingSettingsFields";
import { RecordingStoragePathField } from "@/features/settings/StoragePathSettings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

type SettingsCategory =
  | "appearance"
  | "playback"
  | "platform"
  | "network"
  | "recording"
  | "account"
  | "data"
  | "about";

export const SETTINGS_SECTION_PARAM = "section";
const SETTINGS_OVERVIEW_NAVIGATION_STATE = "settingsOverviewNavigation";

type AccountLoginMethod = "manual" | "qr";

type AccountQrLoginStart = {
  qr_code_url: string;
  qr_key: string;
};

type AccountQrLoginPoll = {
  status: "pending" | "scanned" | "expired" | "success";
  message: string;
};

type AccountProfile = {
  username: string | null;
  has_cookie: boolean;
  status: "none" | "valid" | "expired" | "unknown";
};

const settingsCategories: {
  value: SettingsCategory;
  label: string;
  icon: LucideIcon;
  tone: string;
}[] = [
  {
    value: "appearance",
    label: "外观配置",
    icon: Palette,
    tone: "text-settings-appearance bg-settings-appearance/12",
  },
  {
    value: "playback",
    label: "播放与弹幕",
    icon: MonitorPlay,
    tone: "text-settings-playback bg-settings-playback/12",
  },
  {
    value: "platform",
    label: "直播平台",
    icon: Radio,
    tone: "text-settings-platform bg-settings-platform/12",
  },
  {
    value: "network",
    label: "网络与 IPTV",
    icon: Network,
    tone: "text-settings-network bg-settings-network/12",
  },
  {
    value: "recording",
    label: "录制设置",
    icon: CircleDot,
    tone: "text-settings-recording bg-settings-recording/12",
  },
  {
    value: "account",
    label: "账号与权限",
    icon: UserRound,
    tone: "text-settings-account bg-settings-account/12",
  },
  {
    value: "data",
    label: "数据管理",
    icon: Database,
    tone: "text-settings-data bg-settings-data/12",
  },
  {
    value: "about",
    label: "关于 rLive",
    icon: Info,
    tone: "text-settings-about bg-settings-about/12",
  },
];

const PROJECT_HOMEPAGE_URL = "https://github.com/Kenny3Shen/rLive";
const PROFILE_FILE_FILTERS = [{ name: "rLive 配置档案", extensions: ["json"] }];

export const settingsCategorySearchText: Record<SettingsCategory, string> = {
  appearance:
    "外观 配置 主题 深色 暗色 浅色 亮色 亮暗 明暗 模式 跟随系统 系统 切换 深色模式 浅色模式 亮暗模式",
  playback:
    "播放 播放质量 清晰度 线路记忆 软切换 悬停 预览 卡片 封面 语音 字幕 asr zipformer 标点 说话人 热词 刷新间隔 CUDA NVIDIA GPU 推理后端 弹幕 轨道 区域 文字 透明度 字号 描边 速度 过滤 屏蔽词 重复 礼物 合并 醒目留言 sc 恢复默认 重置 reset",
  platform: "平台 直播平台 bilibili 哔哩哔哩 douyu 斗鱼 huya 虎牙 douyin 抖音 twitch",
  network: "网络 代理 iptv IPTV M3U 源 地址 直链 播放 媒体 HLS M3U8 FLV MPEG-TS MP4",
  recording:
    "录制 设置 默认 弹幕 后台 离开 自动 分割 时长 保存 路径 目录 ASS 导出 分辨率 字体 不透明度 描边 阴影 粗体 屏蔽 正则 FFmpeg 超时 重连 HLS 分片 重试",
  account:
    "账号 发送权限 平台账号 bilibili 哔哩哔哩 douyu 斗鱼 huya 虎牙 douyin 抖音 cookie 登录 扫码",
  data: "数据 保存 路径 位置 目录 应用 局域网 同步 Wi-Fi 配对 发送 接收 导入 导出 配置 档案 缓存 图片缓存 图片 头像 封面 清除 清理 占用 空间 cache",
  about: "关于 rLive 当前版本 version 项目主页 github 免责声明 运行日志 log 报错 错误 诊断",
};

const SettingsSearchContext = createContext("");

function searchTokens(value: string): string[] {
  return value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

function matchesSearch(value: string, query: string): boolean {
  const tokens = searchTokens(query);
  const haystack = value.toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function errorMessage(cause: unknown): string {
  return typeof cause === "object" && cause && "message" in cause
    ? String((cause as { message: string }).message)
    : String(cause);
}

function isDanmakuSendCookieSite(siteId: SiteId): boolean {
  return siteId === "bilibili" || siteId === "douyu" || siteId === "huya" || siteId === "douyin";
}

/** 虎牙 UDB 直接提供现成的 PNG；其他平台返回可编码的负载。 */
function isHostedQrImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "udblgn.huya.com" || url.hostname.endsWith(".huya.com")) &&
      url.pathname.includes("/qrLgn/getQrImg")
    );
  } catch {
    return false;
  }
}

function Section({
  title,
  keywords,
  children,
}: {
  title: string;
  keywords?: string;
  children: React.ReactNode;
}) {
  const query = useContext(SettingsSearchContext);
  if (!matchesSearch(`${title} ${keywords ?? ""}`, query)) return null;

  return (
    <section
      data-slot="settings-section"
      className="settings-section overflow-hidden rounded-xl border border-border/80 bg-card/80 shadow-sm shadow-black/10"
    >
      <FieldSet className="gap-0 py-0">
        <div className="settings-section-heading border-b border-border-subtle bg-muted/20 px-4 py-2.5">
          <FieldLegend variant="label" className="m-0 text-sm font-semibold text-foreground">
            {title}
          </FieldLegend>
        </div>
        <FieldGroup className="gap-0 [&>[data-slot=field]]:px-4 [&>[data-slot=field]]:py-3">
          {children}
        </FieldGroup>
      </FieldSet>
    </section>
  );
}

function QrLogin({
  siteId,
  siteName,
  onSaved,
}: {
  siteId: SiteId;
  siteName: string;
  onSaved: () => Promise<void>;
}) {
  const [session, setSession] = useState<AccountQrLoginStart | null>(null);
  const [status, setStatus] = useState("正在获取二维码…");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setSession(null);
    setStatus("正在获取二维码…");
    try {
      const next = await invokeCmd<AccountQrLoginStart>("account_qr_login_start", {
        siteId,
      });
      setSession(next);
      setStatus(`请使用${siteName} App 扫描二维码`);
    } catch (error) {
      const message =
        typeof error === "object" && error && "message" in error
          ? String((error as { message: string }).message)
          : String(error);
      setStatus(`获取二维码失败：${message}`);
    } finally {
      setLoading(false);
    }
  }, [siteId, siteName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let polling = false;
    let interval: number | null = null;

    const poll = async () => {
      if (cancelled || polling) return;
      polling = true;
      try {
        const result = await invokeCmd<AccountQrLoginPoll>("account_qr_login_poll", {
          siteId,
          qrKey: session.qr_key,
        });
        if (cancelled) return;
        setStatus(result.message);
        if (result.status === "success") {
          await onSaved();
        }
        if (result.status === "success" || result.status === "expired") {
          if (interval !== null) window.clearInterval(interval);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            typeof error === "object" && error && "message" in error
              ? String((error as { message: string }).message)
              : String(error);
          setStatus(`扫码状态检查失败：${message}`);
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    interval = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [onSaved, session, siteId]);

  return (
    <Field>
      <FieldContent>
        <div className="flex flex-wrap items-center gap-4">
          {/* 二维码底色固定为白色（含白色静默区），避免深色主题下反色导致无法扫码。 */}
          <div className="rounded-xl border border-border-subtle bg-white p-3 text-neutral-500 shadow-sm">
            {session ? (
              isHostedQrImageUrl(session.qr_code_url) ? (
                // 虎牙 UDB 的 getQrImg 返回 PNG；其他平台给出由 QRCodeSVG 本地编码的负载字符串。
                <img
                  src={session.qr_code_url}
                  alt={`${siteName}登录二维码`}
                  width={176}
                  height={176}
                  className="size-44 bg-white object-contain"
                  draggable={false}
                />
              ) : (
                <QRCodeSVG
                  value={session.qr_code_url}
                  size={176}
                  level="M"
                  marginSize={0}
                  fgColor="#111111"
                  bgColor="#ffffff"
                  title={`${siteName}登录二维码`}
                />
              )
            ) : (
              <div className="flex size-44 items-center justify-center">
                <RefreshCw className="size-5 animate-spin-soft" aria-hidden />
                <span className="sr-only">正在加载二维码</span>
              </div>
            )}
          </div>
          <div className="flex min-w-44 flex-1 flex-col gap-2">
            <p className="text-sm font-medium">手机扫码登录</p>
            <FieldDescription role="status" aria-live="polite">
              {status}
            </FieldDescription>
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              刷新二维码
            </Button>
          </div>
        </div>
      </FieldContent>
    </Field>
  );
}

function AccountCard({
  siteId,
  title,
  placeholder,
  qrLogin = false,
}: {
  siteId: SiteId;
  title: string;
  placeholder: string;
  qrLogin?: boolean;
}) {
  const queryClient = useQueryClient();
  const markDanmakuCookieChanged = useSettingsStore((s) => s.markDanmakuCookieChanged);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<AccountLoginMethod | null>(null);
  const [cookieDraft, setCookieDraft] = useState("");
  const [manualCookieLoaded, setManualCookieLoaded] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const inputId = `${siteId}-cookie`;

  const refreshCookieDependentQueries = useCallback(() => {
    // 此时 Cookie 写入已经成功。一次失败的网络刷新不得把成功的账号更新变成 UI 错误；
    // 受影响的查询保留自己的错误状态并保持过期以便重试。
    void invalidateCookieDependentSiteQueries(queryClient, siteId).catch(() => {});
  }, [queryClient, siteId]);

  const refreshProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError(null);
    if (!isTauri()) {
      setProfile({ username: null, has_cookie: false, status: "none" });
      setProfileLoading(false);
      return;
    }
    try {
      const next = await invokeCmd<AccountProfile>("account_get_profile", {
        siteId,
      });
      setProfile(next);
    } catch (error) {
      setProfile(null);
      setProfileError(`账号状态读取失败：${errorMessage(error)}`);
    } finally {
      setProfileLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  useEffect(() => {
    if (loginMethod !== "manual" || manualCookieLoaded) return;
    if (!isTauri()) {
      setManualCookieLoaded(true);
      return;
    }

    let cancelled = false;
    setManualLoading(true);
    setManualError(null);
    void invokeCmd<string | null>("account_get_cookie", { siteId })
      .then((cookie) => {
        if (cancelled) return;
        setCookieDraft(cookie ?? "");
        setManualCookieLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setManualError(`读取失败：${errorMessage(error)}`);
      })
      .finally(() => {
        if (!cancelled) setManualLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loginMethod, manualCookieLoaded, siteId]);

  const applySavedCookie = useCallback(
    async (message: string) => {
      if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
      refreshCookieDependentQueries();
      await refreshProfile();
      setNotice(message);
    },
    [markDanmakuCookieChanged, refreshCookieDependentQueries, refreshProfile, siteId],
  );

  function closeLoginDialog() {
    if (saving) return;
    setLoginMethod(null);
    setManualError(null);
  }

  async function saveCookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cookie = cookieDraft.trim();
    if (!cookie) {
      setManualError("请输入完整 Cookie。");
      return;
    }

    setSaving(true);
    setManualError(null);
    try {
      await invokeCmd<void>("account_set_cookie", { siteId, cookie });
      await applySavedCookie("已保存。");
      setLoginMethod(null);
      setCookieDraft(cookie);
      setManualCookieLoaded(true);
    } catch (error) {
      setManualError(`保存失败：${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function clearCookie() {
    setClearing(true);
    setLogoutError(null);
    try {
      await invokeCmd<void>("account_clear_cookie", { siteId });
      await applySavedCookie("已退出当前账号。");
      setCookieDraft("");
      setManualCookieLoaded(true);
      setLogoutOpen(false);
    } catch (error) {
      setLogoutError(`退出登录失败：${errorMessage(error)}`);
    } finally {
      setClearing(false);
    }
  }

  const displayName = profile?.username ?? null;
  const hasCookie = profile?.has_cookie ?? false;
  const expired = profile?.status === "expired";
  const accountState = profileLoading
    ? "读取中"
    : expired
      ? "已失效"
      : hasCookie
        ? "已登录"
        : "未登录";

  // Cookie 过期时自动登出
  useEffect(() => {
    if (profileLoading || !expired || !hasCookie) return;

    let cancelled = false;
    const autoLogout = async () => {
      try {
        await invokeCmd<void>("account_clear_cookie", { siteId });
        if (!cancelled) {
          await refreshProfile();
          setCookieDraft("");
          setManualCookieLoaded(true);
          if (isDanmakuSendCookieSite(siteId)) markDanmakuCookieChanged();
          refreshCookieDependentQueries();
        }
      } catch (error) {
        // 静默失败 —— 用户仍可手动登出
        console.error("Auto logout failed:", error);
      }
    };
    void autoLogout();

    return () => {
      cancelled = true;
    };
  }, [
    expired,
    hasCookie,
    profileLoading,
    siteId,
    refreshProfile,
    markDanmakuCookieChanged,
    refreshCookieDependentQueries,
  ]);

  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <div className="flex flex-wrap items-center gap-2">
            <FieldTitle className="min-h-7">
              <SiteLogo siteId={siteId} className="size-5" />
              {title}
            </FieldTitle>
            <Badge variant={expired ? "destructive" : hasCookie ? "secondary" : "outline"}>
              {accountState}
            </Badge>
            {displayName && (
              <span className="min-w-0 truncate text-sm text-muted-foreground">{displayName}</span>
            )}
          </div>
          {notice && <FieldDescription role="status">{notice}</FieldDescription>}
          {profileError && <FieldError>{profileError}</FieldError>}
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:hidden">
            {qrLogin && (
              <Button variant="outline" size="sm" onClick={() => setLoginMethod("qr")}>
                <QrCode data-icon="inline-start" aria-hidden />
                扫码
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setLoginMethod("manual")}>
              <UserRound data-icon="inline-start" aria-hidden />
              输入
            </Button>
            {hasCookie && (
              <AlertDialog
                open={logoutOpen}
                onOpenChange={(open) => {
                  if (clearing) return;
                  setLogoutOpen(open);
                  setLogoutError(null);
                }}
              >
                <AlertDialogTrigger
                  render={
                    <Button variant="destructive" size="sm">
                      <LogOut data-icon="inline-start" aria-hidden />
                      退出
                    </Button>
                  }
                />
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogMedia className="bg-destructive/10 text-destructive">
                      <LogOut aria-hidden />
                    </AlertDialogMedia>
                    <AlertDialogTitle>退出{title}登录？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将删除本机保存的{title}{" "}
                      Cookie，登录内容与弹幕发送将暂时不可用。之后可重新登录。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {logoutError && (
                    <p role="alert" className="text-sm text-destructive">
                      {logoutError}
                    </p>
                  )}
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={clearing}>取消</AlertDialogCancel>
                    <AlertDialogAction
                      type="button"
                      variant="destructive"
                      disabled={clearing}
                      onClick={() => void clearCookie()}
                    >
                      {clearing ? (
                        <>
                          <Spinner data-icon="inline-start" aria-hidden />
                          正在退出…
                        </>
                      ) : (
                        <>
                          <LogOut data-icon="inline-start" aria-hidden />
                          确认退出
                        </>
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </FieldContent>
        <div className="hidden shrink-0 flex-wrap items-center justify-end gap-2 sm:flex">
          {qrLogin && (
            <Button variant="outline" size="sm" onClick={() => setLoginMethod("qr")}>
              <QrCode data-icon="inline-start" aria-hidden />
              扫码登录
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setLoginMethod("manual")}>
            <UserRound data-icon="inline-start" aria-hidden />
            手动输入
          </Button>
          {hasCookie && (
            <AlertDialog
              open={logoutOpen}
              onOpenChange={(open) => {
                if (clearing) return;
                setLogoutOpen(open);
                setLogoutError(null);
              }}
            >
              <AlertDialogTrigger
                render={
                  <Button variant="destructive" size="sm">
                    <LogOut data-icon="inline-start" aria-hidden />
                    退出登录
                  </Button>
                }
              />
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-destructive/10 text-destructive">
                    <LogOut aria-hidden />
                  </AlertDialogMedia>
                  <AlertDialogTitle>退出{title}登录？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将删除本机保存的{title} Cookie，登录内容与弹幕发送将暂时不可用。之后可重新登录。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {logoutError && (
                  <p role="alert" className="text-sm text-destructive">
                    {logoutError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={clearing}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    type="button"
                    variant="destructive"
                    disabled={clearing}
                    onClick={() => void clearCookie()}
                  >
                    {clearing ? (
                      <>
                        <Spinner data-icon="inline-start" aria-hidden />
                        正在退出…
                      </>
                    ) : (
                      <>
                        <LogOut data-icon="inline-start" aria-hidden />
                        确认退出
                      </>
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </Field>

      <Dialog
        open={loginMethod === "qr"}
        onOpenChange={(open) => {
          if (!open) closeLoginDialog();
        }}
      >
        {loginMethod === "qr" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}扫码登录</DialogTitle>
              <DialogDescription>请使用 {title} App 扫描二维码并在手机上确认。</DialogDescription>
            </DialogHeader>
            <QrLogin
              siteId={siteId}
              siteName={title}
              onSaved={async () => {
                await applySavedCookie("扫码登录成功，当前账号已更新。");
                setCookieDraft("");
                setManualCookieLoaded(false);
                setLoginMethod(null);
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={closeLoginDialog}>
                取消
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={loginMethod === "manual"}
        onOpenChange={(open) => {
          if (!open) closeLoginDialog();
        }}
      >
        {loginMethod === "manual" && (
          <DialogContent>
            <form onSubmit={(event) => void saveCookie(event)}>
              <DialogHeader>
                <DialogTitle>{title} Cookie</DialogTitle>
                <DialogDescription>Cookie 仅保存在本机。</DialogDescription>
              </DialogHeader>
              <FieldGroup className="mt-4">
                <Field
                  data-disabled={saving || manualLoading ? true : undefined}
                  data-invalid={manualError ? true : undefined}
                >
                  <FieldLabel htmlFor={inputId}>Cookie</FieldLabel>
                  <Textarea
                    id={inputId}
                    value={cookieDraft}
                    onChange={(event) => {
                      setCookieDraft(event.target.value);
                      setManualCookieLoaded(true);
                      setManualError(null);
                    }}
                    rows={6}
                    className="max-h-[40vh] overflow-y-auto resize-y"
                    placeholder={placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={saving || manualLoading}
                    aria-invalid={manualError ? true : undefined}
                  />
                  {manualError && <FieldError>{manualError}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter className="mt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeLoginDialog}
                  disabled={saving}
                >
                  取消
                </Button>
                <Button type="submit" disabled={saving || manualLoading}>
                  {saving ? <Spinner data-icon="inline-start" /> : null}
                  保存
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function DanmakuSendField() {
  const enabled = useSettingsStore((s) => s.danmakuSendEnabled);
  const setEnabled = useSettingsStore((s) => s.setDanmakuSendEnabled);

  return (
    <Field orientation="horizontal">
      <FieldTitle id="danmaku-send-title">允许发送弹幕</FieldTitle>
      <Switch aria-labelledby="danmaku-send-title" checked={enabled} onCheckedChange={setEnabled} />
    </Field>
  );
}

function PlaybackSettingsResetField() {
  const mobileClient = isMobileClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resetAll() {
    setResetting(true);
    setStatus(null);
    setError(null);
    try {
      const store = useSettingsStore.getState();
      // 先关闭 ASR，使剩余字段的重置不会在中途重启识别会话。
      if (!mobileClient && store.asrEnabled) {
        await store.setAsrEnabled(false);
      }
      resetDanmakuAppearanceSettings();
      useSettingsStore.setState({
        qualityLevel: "high",
        playbackSoftSwitchEnabled: true,
        danmakuShieldWords: [],
        danmakuBlockedUsers: [],
        superChatEnabled: true,
        ...(mobileClient
          ? null
          : {
              roomCardPreviewEnabled: ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
              asrProvider: "auto" as const,
              asrVadEnabled: true,
              asrPunctuationEnabled: true,
              asrSpeakerDiarizationEnabled: false,
              asrHotwords: [],
              asrWindowSeconds: ASR_WINDOW_SECONDS_DEFAULT,
              asrFontSize: ASR_FONT_SIZE_DEFAULT,
            }),
      });
      await store.persistToBackend({
        quality_level: "high",
        playback_soft_switch_enabled: true,
        danmaku_shield_words: [],
        danmaku_blocked_users: [],
        super_chat_enabled: true,
        ...(mobileClient
          ? null
          : {
              room_card_preview_enabled: ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
              asr_provider: "auto",
              asr_vad_enabled: true,
              asr_punctuation_enabled: true,
              asr_speaker_diarization_enabled: false,
              asr_hotwords: [],
              asr_window_seconds: ASR_WINDOW_SECONDS_DEFAULT,
              asr_font_size: ASR_FONT_SIZE_DEFAULT,
            }),
      });
      setStatus("已恢复本页全部设置项的默认值。");
      setConfirmOpen(false);
    } catch (cause) {
      setError(`恢复默认设置失败：${errorMessage(cause)}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <Field orientation="horizontal" data-invalid={error ? true : undefined}>
      <FieldContent>
        <FieldTitle>
          恢复默认设置
          <FieldTip>重置本页全部设置项，包括屏蔽词、屏蔽用户和语音字幕热词。</FieldTip>
        </FieldTitle>
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          status && (
            <FieldDescription role="status" aria-live="polite">
              {status}
            </FieldDescription>
          )
        )}
      </FieldContent>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (resetting) return;
          setConfirmOpen(open);
        }}
      >
        <AlertDialogTrigger
          render={
            <Button variant="outline">
              <RotateCcw data-icon="inline-start" aria-hidden />
              恢复默认
            </Button>
          }
        />
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <RotateCcw aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>恢复默认设置？</AlertDialogTitle>
            <AlertDialogDescription>
              {mobileClient
                ? "将重置本页全部设置项，包括画质、弹幕和屏蔽词。"
                : "将重置本页全部设置项，包括画质、语音字幕、热词、弹幕和屏蔽词；已开启的语音字幕会被关闭。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>取消</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={resetting}
              onClick={() => void resetAll()}
            >
              {resetting ? (
                <>
                  <Spinner data-icon="inline-start" aria-hidden />
                  正在恢复…
                </>
              ) : (
                <>
                  <RotateCcw data-icon="inline-start" aria-hidden />
                  恢复默认
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Field>
  );
}

function AsrModelField() {
  const enabled = useSettingsStore((state) => state.asrEnabled);
  const provider = useSettingsStore((state) => state.asrProvider);
  const vadEnabled = useSettingsStore((state) => state.asrVadEnabled);
  const punctuationEnabled = useSettingsStore((state) => state.asrPunctuationEnabled);
  const speakerEnabled = useSettingsStore((state) => state.asrSpeakerDiarizationEnabled);
  const pending = useSettingsStore((state) => state.asrPending);
  const setEnabled = useSettingsStore((state) => state.setAsrEnabled);
  const setProvider = useSettingsStore((state) => state.setAsrProvider);
  const setVadEnabled = useSettingsStore((state) => state.setAsrVadEnabled);
  const setPunctuationEnabled = useSettingsStore((state) => state.setAsrPunctuationEnabled);
  const setSpeakerEnabled = useSettingsStore((state) => state.setAsrSpeakerDiarizationEnabled);
  const model = useAsrModelStatus({ enabled });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const presentation = describeAsrModelStatus(model.status, {
    enabled,
    supported: model.supported,
    queryError: model.queryError,
  });

  async function applyEnabled(next: boolean) {
    setActionError(null);
    try {
      await setEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function retryPreparation() {
    setActionError(null);
    try {
      await model.prepare();
      await model.refetch();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function applySpeakerEnabled(next: boolean) {
    setActionError(null);
    try {
      await setSpeakerEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function applyProvider(next: AsrProvider) {
    setActionError(null);
    try {
      await setProvider(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function applyVadEnabled(next: boolean) {
    setActionError(null);
    try {
      await setVadEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function applyPunctuationEnabled(next: boolean) {
    setActionError(null);
    try {
      await setPunctuationEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  const invalid = presentation.error || actionError !== null;
  const busy = pending || (enabled && presentation.busy);
  const estimatedModelSize = punctuationEnabled
    ? speakerEnabled
      ? "577"
      : "550"
    : speakerEnabled
      ? "515"
      : "488";
  const estimatedDownloadSize = isWindowsDesktop()
    ? String(Number(estimatedModelSize) + 212)
    : estimatedModelSize;
  return (
    <>
      <Field
        orientation="horizontal"
        data-disabled={!model.supported || undefined}
        data-invalid={invalid || undefined}
      >
        <FieldContent>
          <FieldTitle id="asr-enabled-title">语音字幕</FieldTitle>
          {invalid ? (
            <FieldError role="status" aria-live="polite">
              {actionError ?? presentation.message}
            </FieldError>
          ) : (
            // 稳态文案（就绪/禁用摘要）保持隐藏；
            // 这里只显示模型下载之类的瞬态进度。
            enabled &&
            presentation.busy && (
              <FieldDescription role="status" aria-live="polite">
                {presentation.message}
              </FieldDescription>
            )
          )}
          {enabled && presentation.error && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="mt-2 w-fit"
              disabled={pending}
              onClick={() => void retryPreparation()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              重试
            </Button>
          )}
        </FieldContent>
        <div className="flex shrink-0 items-center gap-2">
          {busy && <Spinner aria-hidden />}
          <Switch
            aria-labelledby="asr-enabled-title"
            aria-invalid={invalid || undefined}
            checked={enabled}
            disabled={!model.supported || model.isPending || pending}
            onCheckedChange={(checked) => {
              if (checked && model.status?.state === "not_downloaded") {
                setConfirmOpen(true);
                return;
              }
              void applyEnabled(checked);
            }}
          />
        </div>
      </Field>

      <Field orientation="horizontal" data-disabled={!model.supported || pending || undefined}>
        <FieldContent>
          <FieldTitle>
            <span id="asr-vad-title">VAD（静音端点检测）</span>
            <FieldTip>关闭后仅按最长 20 秒切分。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="asr-vad-title"
          checked={vadEnabled}
          disabled={!model.supported || model.isPending || pending}
          onCheckedChange={(checked) => void applyVadEnabled(checked)}
        />
      </Field>

      {isWindowsDesktop() && (
        <Field orientation="horizontal" data-disabled={!model.supported || pending || undefined}>
          <FieldContent>
            <FieldTitle>
              <span id="asr-provider-title">推理后端</span>
              <FieldTip>自动优先使用 CUDA，不可用时回退 CPU。</FieldTip>
            </FieldTitle>
          </FieldContent>
          <ToggleGroup
            aria-labelledby="asr-provider-title"
            value={[provider]}
            variant="outline"
            size="sm"
            spacing={1}
            disabled={!model.supported || model.isPending || pending}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "auto" || next === "cpu" || next === "cuda") {
                void applyProvider(next);
              }
            }}
          >
            <ToggleGroupItem value="auto">自动</ToggleGroupItem>
            <ToggleGroupItem value="cuda">CUDA</ToggleGroupItem>
            <ToggleGroupItem value="cpu">CPU</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}

      <Field orientation="horizontal" data-disabled={!model.supported || pending || undefined}>
        <FieldContent>
          <FieldTitle>
            <span id="asr-punctuation-title">自动标点</span>
            <FieldTip>关闭后保留原始文本。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="asr-punctuation-title"
          checked={punctuationEnabled}
          disabled={!model.supported || model.isPending || pending}
          onCheckedChange={(checked) => void applyPunctuationEnabled(checked)}
        />
      </Field>

      <Field orientation="horizontal" data-disabled={!model.supported || pending || undefined}>
        <FieldContent>
          <FieldTitle>
            <span id="asr-speaker-title">说话人区分</span>
            <FieldTip>首次启用需下载约 27 MB。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="asr-speaker-title"
          checked={speakerEnabled}
          disabled={!model.supported || model.isPending || pending}
          onCheckedChange={(checked) => void applySpeakerEnabled(checked)}
        />
      </Field>

      <AsrHotwordsField idPrefix="settings" layout="page" disabled={!model.supported} />

      <AsrChunkIntervalField
        idPrefix="settings"
        layout="page"
        disabled={!model.supported || pending}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Download aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>下载语音字幕模型</AlertDialogTitle>
            <AlertDialogDescription>
              将下载约 {estimatedDownloadSize} MB 的字幕运行库和模型，完成后自动启用并保留在本机。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                void applyEnabled(true);
              }}
            >
              下载并启用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function IptvCustomM3uUrlField() {
  const customM3uUrl = useSettingsStore((s) => s.iptvCustomM3uUrl);
  const setCustomM3uUrl = useSettingsStore((s) => s.setIptvCustomM3uUrl);
  const [draft, setDraft] = useState(customM3uUrl ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(customM3uUrl ?? "");
  }, [customM3uUrl]);

  function save() {
    const next = draft.trim();
    if (next && !isHttpM3uUrl(next)) {
      setStatus(null);
      setError("请输入以 http:// 或 https:// 开头的 M3U 地址");
      return;
    }
    setError(null);
    setCustomM3uUrl(next || null);
    setStatus(next ? "自定义 M3U 地址已保存" : "自定义 M3U 地址已清除");
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="iptv-custom-m3u-url">M3U 地址</FieldLabel>
      <FieldContent>
        <form
          className="w-full"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <InputGroup>
            <InputGroupInput
              id="iptv-custom-m3u-url"
              type="url"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="https://example.com/playlist.m3u"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit" variant="secondary" size="sm">
                保存
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          status && (
            <FieldDescription role="status" aria-live="polite">
              {status}
            </FieldDescription>
          )
        )}
      </FieldContent>
    </Field>
  );
}

function DirectPlaybackField() {
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function play() {
    const directUrl = draft.trim();
    if (!isHttpUrl(directUrl)) {
      setError("请输入以 http:// 或 https:// 开头的媒体直链");
      return;
    }
    setError(null);
    navigate(directPlayerPath({ directUrl }), {
      state: { returnTo: `${location.pathname}${location.search}` },
    });
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center gap-1.5">
        <FieldLabel htmlFor="direct-playback-url">媒体直链</FieldLabel>
        <FieldTip>
          支持 HLS、FLV、MPEG-TS 和 MP4 等媒体地址；播放请求会通过 rLive 本机代理转发。
        </FieldTip>
      </div>
      <FieldContent>
        <form
          className="w-full"
          onSubmit={(event) => {
            event.preventDefault();
            play();
          }}
        >
          <InputGroup>
            <InputGroupInput
              id="direct-playback-url"
              type="url"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              placeholder="https://example.com/live.m3u8"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit" variant="secondary" size="sm">
                <Play data-icon="inline-start" aria-hidden />
                播放
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
    </Field>
  );
}

function isHttpM3uUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpProxy(value: string): {
  value: string | null;
  error: string | null;
} {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { value: null, error: "仅支持 HTTP 或 HTTPS 代理地址" };
    }
    if (!parsed.hostname) {
      return { value: null, error: "请填写代理主机和端口" };
    }
    return { value: parsed.href, error: null };
  } catch {
    return {
      value: null,
      error: "请输入有效的代理地址，例如 http://127.0.0.1:7890",
    };
  }
}

function PlatformEnablementField() {
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  const setSiteEnabled = useSettingsStore((s) => s.setSiteEnabled);
  const enabled = enabledSiteIds(disabledSiteIds);

  return (
    <Section title="直播平台" keywords="bilibili 哔哩哔哩 douyu 斗鱼 huya 虎牙 douyin 抖音 twitch">
      {LIVE_SITE_IDS.map((siteId) => {
        const isEnabled = enabled.includes(siteId);
        const isLastEnabled = isEnabled && enabled.length === 1;
        const titleId = `platform-${siteId}-enabled`;

        return (
          <Field key={siteId} orientation="horizontal" data-disabled={isLastEnabled || undefined}>
            <FieldContent>
              <FieldTitle id={titleId}>
                <SiteLogo siteId={siteId} className="size-5" />
                {SITE_LABELS[siteId] ?? siteId}
              </FieldTitle>
            </FieldContent>
            <Switch
              aria-labelledby={titleId}
              aria-description={isLastEnabled ? "需至少保留一个平台" : undefined}
              checked={isEnabled}
              disabled={isLastEnabled}
              onCheckedChange={(checked) => setSiteEnabled(siteId, checked)}
            />
          </Field>
        );
      })}
    </Section>
  );
}

function AppearanceSettings() {
  const switchingRef = useRef(false);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  function applyThemeMode(next: ThemeMode) {
    if (next === theme || switchingRef.current) return;
    switchingRef.current = true;
    const transition = fadeTheme(() => flushSync(() => setTheme(next)));
    void transition.finished.finally(() => {
      switchingRef.current = false;
    });
  }

  return (
    <Section title="外观" keywords="主题 深色 暗色 浅色 亮色 亮暗 明暗 模式 跟随系统 系统">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="theme-mode-label">亮暗模式</span>
            <FieldTip>跟随系统时，rLive 会随系统亮暗设置自动切换。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <ToggleGroup
          aria-labelledby="theme-mode-label"
          value={[theme]}
          variant="outline"
          size="sm"
          spacing={1}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "system" || next === "light" || next === "dark") {
              applyThemeMode(next);
            }
          }}
        >
          <ToggleGroupItem value="system">跟随系统</ToggleGroupItem>
          <ToggleGroupItem value="light">浅色</ToggleGroupItem>
          <ToggleGroupItem value="dark">深色</ToggleGroupItem>
        </ToggleGroup>
      </Field>
    </Section>
  );
}

function settingsCategoryFromSearch(value: string | null): SettingsCategory | null {
  return settingsCategories.some((category) => category.value === value)
    ? (value as SettingsCategory)
    : null;
}

export function settingsPageMotion(
  section: string | null,
  mobileClient = false,
): {
  category: SettingsCategory | null;
  key: string;
  direction: 1 | -1;
} {
  const requestedCategory = settingsCategoryFromSearch(section);
  const category = mobileClient && requestedCategory === "recording" ? null : requestedCategory;
  return {
    category,
    key: category ? `settings:${category}` : "settings:overview",
    direction: category ? 1 : -1,
  };
}

const settingsCategoryGroups: {
  label: string;
  values: SettingsCategory[];
}[] = [
  { label: "通用", values: ["appearance"] },
  { label: "观看体验", values: ["playback", "platform", "network"] },
  { label: "账号与数据", values: ["account", "recording", "data"] },
  { label: "应用信息", values: ["about"] },
];

export function settingsCategoryValuesForClient(mobileClient: boolean): SettingsCategory[] {
  return settingsCategories
    .map((category) => category.value)
    .filter((value) => !mobileClient || value !== "recording");
}

function SettingsCategoryButton({
  category,
  onOpen,
}: {
  category: (typeof settingsCategories)[number];
  onOpen: (value: SettingsCategory) => void;
}) {
  const Icon = category.icon;

  return (
    <button
      type="button"
      data-motion-press
      onClick={() => onOpen(category.value)}
      className="settings-category-button group flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-[transform,background-color,color] duration-150 ease-[var(--motion-ease-out)] hover:bg-muted/40 focus-visible:bg-muted/40 focus-ring"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          category.tone,
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {category.label}
      </span>
      <ChevronRight
        className="motion-disclosure-icon size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-150 ease-[var(--motion-ease-out)] group-hover:text-foreground motion-reduced:transition-colors"
        aria-hidden
      />
    </button>
  );
}

function SettingsCategoryOverview({
  query,
  onQueryChange,
  onOpen,
  mobileClient,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onOpen: (value: SettingsCategory) => void;
  mobileClient: boolean;
}) {
  const visibleCategoryValues = settingsCategoryValuesForClient(mobileClient);
  const visibleGroups = settingsCategoryGroups
    .map((group) => ({
      ...group,
      categories: group.values
        .map((value) => settingsCategories.find((category) => category.value === value))
        .filter(
          (category): category is (typeof settingsCategories)[number] =>
            category !== undefined &&
            visibleCategoryValues.includes(category.value) &&
            matchesSearch(`${category.label} ${settingsCategorySearchText[category.value]}`, query),
        ),
    }))
    .filter((group) => group.categories.length > 0);

  return (
    <div className="settings-overview flex min-h-full flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">设置</h1>
        </div>
        <InputGroup className="settings-search h-11 max-w-2xl rounded-xl border-border-subtle bg-card/80 shadow-sm">
          <InputGroupAddon align="inline-start" className="pl-3">
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="搜索设置项"
            placeholder="搜索设置项"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <InputGroupAddon align="inline-end" className="pr-2">
              <InputGroupButton
                size="icon-xs"
                aria-label="清除设置搜索"
                onClick={() => onQueryChange("")}
              >
                <X aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>

      {visibleGroups.length > 0 ? (
        <div className="flex max-w-4xl flex-col gap-5 px-px">
          {visibleGroups.map((group) => (
            <section key={group.label} aria-label={group.label} className="settings-category-group">
              <p className="settings-category-group-label mb-2 px-1 text-xs font-semibold text-muted-foreground">
                {group.label}
              </p>
              <Card className="settings-category-list overflow-hidden rounded-xl bg-card/85 p-0 ring-border-subtle shadow-sm shadow-black/10">
                <CardContent className="divide-y divide-border-subtle p-0">
                  {group.categories.map((category) => (
                    <SettingsCategoryButton
                      key={category.value}
                      category={category}
                      onOpen={onOpen}
                    />
                  ))}
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      ) : (
        <Empty className="min-h-64 max-w-4xl border border-dashed border-border-subtle bg-muted/10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden />
            </EmptyMedia>
            <EmptyTitle>没有匹配的设置</EmptyTitle>
            <EmptyDescription>试试其他关键词，或清除搜索继续浏览。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function AboutSettings() {
  const versionQuery = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
    enabled: isTauri(),
    staleTime: Infinity,
    retry: false,
  });
  const appVersion = versionQuery.data ?? packageMetadata.version;

  function openProjectHomepage() {
    void openUrl(PROJECT_HOMEPAGE_URL).catch(() => {
      // 让链接在基于浏览器的开发预览中仍然有用，
      // 那里刻意不提供原生 opener 插件。
      window.open(PROJECT_HOMEPAGE_URL, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <AlertDialog>
        <Section
          title="关于 rLive"
          keywords="当前版本 version 项目主页 github 免责声明 运行日志 log 报错 错误 诊断"
        >
          <Field orientation="horizontal">
            <FieldTitle id="app-version">当前版本</FieldTitle>
            <Badge variant="secondary" className="tabular-nums">
              v{appVersion}
            </Badge>
          </Field>
          <AppLogField />
          <Field orientation="horizontal">
            <FieldTitle id="project-homepage">项目主页</FieldTitle>
            <Button onClick={openProjectHomepage} variant="outline">
              <ExternalLink data-icon="inline-start" aria-hidden />
              GitHub
            </Button>
          </Field>
          <Field orientation="horizontal">
            <FieldTitle id="disclaimer-title">免责声明</FieldTitle>
            <AlertDialogTrigger
              render={
                <Button variant="outline">
                  <ShieldAlert data-icon="inline-start" aria-hidden />
                  查看
                </Button>
              }
            />
          </Field>
        </Section>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ShieldAlert aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>免责声明</AlertDialogTitle>
            <AlertDialogDescription>
              rLive
              是本地桌面直播客户端，不托管、制作或控制任何第三方直播内容，也不代表或隶属于任何直播平台。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              使用直播平台、账号、Cookie、节目源和互动功能时，请确认你拥有相应授权，并遵守平台规则、内容版权、隐私要求及所在地法律。
            </p>
            <p>
              第三方服务、内容可用性和访问条件可能随时变化；rLive
              不对其持续可用性、准确性或适用性作出保证。
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>我已了解</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const qualityLevel = useSettingsStore((s) => s.qualityLevel);
  const setQualityLevel = useSettingsStore((s) => s.setQualityLevel);
  const playbackSoftSwitchEnabled = useSettingsStore((s) => s.playbackSoftSwitchEnabled);
  const setPlaybackSoftSwitchEnabled = useSettingsStore((s) => s.setPlaybackSoftSwitchEnabled);
  const roomCardPreviewEnabled = useSettingsStore((s) => s.roomCardPreviewEnabled);
  const setRoomCardPreviewEnabled = useSettingsStore((s) => s.setRoomCardPreviewEnabled);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<"import" | "export" | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const mobileClient = isMobileClient();
  const {
    category,
    key: settingsMotionKey,
    direction: settingsMotionDirection,
  } = settingsPageMotion(searchParams.get(SETTINGS_SECTION_PARAM), mobileClient);

  function setCategory(next: SettingsCategory | null, replace = false) {
    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set(SETTINGS_SECTION_PARAM, next);
    else nextParams.delete(SETTINGS_SECTION_PARAM);
    const previousState =
      typeof location.state === "object" && location.state !== null ? location.state : {};
    setSearchParams(nextParams, {
      replace,
      state: next
        ? { ...previousState, [SETTINGS_OVERVIEW_NAVIGATION_STATE]: true }
        : previousState,
    });
  }

  function returnToOverview() {
    const openedFromOverview =
      typeof location.state === "object" &&
      location.state !== null &&
      SETTINGS_OVERVIEW_NAVIGATION_STATE in location.state &&
      location.state[SETTINGS_OVERVIEW_NAVIGATION_STATE] === true;
    if (openedFromOverview) navigate(-1);
    else setCategory(null, true);
  }

  // 分类主体保持此处的 key，使概览导航只改变页面外壳；
  // 每个既有设置与持久化路径原样保留。
  const settingsCategoryPanels: Record<SettingsCategory, ReactNode> = {
    appearance: (
      <SettingsContent title="外观">
        <AppearanceSettings />
      </SettingsContent>
    ),
    playback: (
      <SettingsContent title="播放">
        <Section title="播放质量" keywords="清晰度 线路记忆 软切换 线路">
          <Field orientation="horizontal">
            <FieldTitle id="quality-label">优先清晰度</FieldTitle>
            <ToggleGroup
              aria-labelledby="quality-label"
              value={[qualityLevel]}
              variant="outline"
              size="sm"
              spacing={1}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "high" || next === "mid" || next === "low") {
                  setQualityLevel(next);
                }
              }}
            >
              <ToggleGroupItem value="high">最高</ToggleGroupItem>
              <ToggleGroupItem value="mid">中间</ToggleGroupItem>
              <ToggleGroupItem value="low">最低</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                <span id="soft-switch-title">软切换</span>
                <FieldTip>
                  同协议换源时保留播放器；FLV 会重建内部流内核，失败时自动完整重建。
                </FieldTip>
              </FieldTitle>
            </FieldContent>
            <Switch
              aria-labelledby="soft-switch-title"
              checked={playbackSoftSwitchEnabled}
              onCheckedChange={setPlaybackSoftSwitchEnabled}
            />
          </Field>
        </Section>
        {!mobileClient && (
          <Section title="浏览页" keywords="悬停 预览 卡片 封面 试看 静音 直播间 浏览">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>
                  <span id="room-card-preview-title">悬停卡片预览</span>
                  <FieldTip>
                    鼠标停留在直播间卡片上时播放静音低画质预览；仅桌面端且系统未开启减少动态效果时生效。
                  </FieldTip>
                </FieldTitle>
              </FieldContent>
              <Switch
                aria-labelledby="room-card-preview-title"
                checked={roomCardPreviewEnabled}
                onCheckedChange={setRoomCardPreviewEnabled}
              />
            </Field>
          </Section>
        )}
        {!mobileClient && (
          <Section
            title="语音字幕"
            keywords="语音 字幕 asr zipformer 标点 说话人 热词 刷新间隔 CUDA NVIDIA GPU 推理后端"
          >
            <AsrModelField />
            <AsrCaptionFontSizeField idPrefix="settings" layout="page" />
          </Section>
        )}
        <Section title="弹幕设置" keywords="弹幕 轨道 区域 文字 透明度 字号 描边 速度">
          <DanmakuTrackSettingsFields idPrefix="settings" layout="page" />
          <DanmakuAppearanceSettingsFields idPrefix="settings" layout="page" />
        </Section>
        <Section
          title="消息过滤"
          keywords="弹幕 消息 过滤 屏蔽词 屏蔽用户 重复 礼物 合并 醒目留言 sc"
        >
          <DanmakuFilterSettingsFields idPrefix="settings" layout="page" showSuperChat />
        </Section>
        <Section title="恢复默认" keywords="恢复 默认 重置 reset">
          <PlaybackSettingsResetField />
        </Section>
      </SettingsContent>
    ),
    platform: (
      <SettingsContent title="平台">
        <PlatformEnablementField />
      </SettingsContent>
    ),
    network: (
      <SettingsContent title="网络">
        <Section title="代理" keywords="代理 地址">
          <Field data-invalid={proxyError ? true : undefined}>
            <FieldLabel htmlFor="proxy">代理地址</FieldLabel>
            <FieldContent>
              <form
                className="w-full"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveProxy();
                }}
              >
                <InputGroup>
                  <InputGroupInput
                    id="proxy"
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    value={proxyDraft}
                    onChange={(event) => {
                      setProxyDraft(event.target.value);
                      setProxyError(null);
                      setProxyStatus(null);
                    }}
                    placeholder="http://127.0.0.1:7890"
                    aria-invalid={proxyError ? true : undefined}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit" variant="secondary" size="sm">
                      保存
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
              {proxyError ? (
                <FieldError>{proxyError}</FieldError>
              ) : (
                proxyStatus && (
                  <FieldDescription role="status" aria-live="polite">
                    {proxyStatus}
                  </FieldDescription>
                )
              )}
            </FieldContent>
          </Field>
        </Section>
        <Section title="IPTV 源" keywords="iptv IPTV M3U 源 地址">
          <IptvCustomM3uUrlField />
        </Section>
        <Section title="直链播放" keywords="直链 播放 媒体 HLS M3U8 FLV MPEG-TS MP4">
          <DirectPlaybackField />
        </Section>
      </SettingsContent>
    ),
    account: (
      <SettingsContent title="账号">
        <Section title="发送权限" keywords="发送 弹幕 权限">
          <DanmakuSendField />
        </Section>
        <Section
          title="平台账号"
          keywords="账号 平台 bilibili 哔哩哔哩 douyu 斗鱼 huya 虎牙 douyin 抖音 cookie 登录 扫码"
        >
          <AccountCard
            siteId="bilibili"
            title="哔哩哔哩"
            placeholder="SESSDATA=…; bili_jct=…"
            qrLogin
          />
          <AccountCard
            siteId="douyu"
            title="斗鱼"
            placeholder="acf_username=…; acf_stk=…; acf_ltkid=…"
            qrLogin
          />
          <AccountCard
            siteId="huya"
            title="虎牙"
            placeholder="yyuid=…; udb_uid=…; udb_n=…; udb_cred=…"
            qrLogin
          />
          <AccountCard
            siteId="douyin"
            title="抖音"
            placeholder="sessionid=…; ttwid=…; msToken=…"
            qrLogin
          />
        </Section>
      </SettingsContent>
    ),
    recording: (
      <SettingsContent title="录制">
        <Section title="录制设置" keywords="录制 默认 弹幕 后台 离开 自动 分割 时长">
          <RecordingDefaultsFields />
        </Section>
        <Section title="保存位置" keywords="录制 保存 路径 目录">
          <RecordingStoragePathField />
        </Section>
        <Section
          title="导出 ASS 弹幕"
          keywords="ASS 弹幕 导出 配置 选项 分辨率 字体 字号 不透明度 描边 阴影 粗体 滚动 显示区域 合并 礼物 醒目留言 屏蔽 关键词 正则"
        >
          <RecordingAssSettingsFields />
        </Section>
        <Section title="FFmpeg" keywords="FFmpeg 超时 重连 HLS 分片 重试">
          <FfmpegSettingsFields />
        </Section>
      </SettingsContent>
    ),
    data: (
      <SettingsContent title="数据">
        <Section title="局域网同步" keywords="局域网 同步 Wi-Fi 配对 发送 接收">
          <LanSyncField />
        </Section>
        <Section title="导入 / 导出" keywords="数据 导入 导出 配置 档案">
          <Field orientation="horizontal" data-invalid={profileError ? true : undefined}>
            <FieldContent>
              <FieldTitle>配置档案</FieldTitle>
              {profileError ? (
                <FieldError>{profileError}</FieldError>
              ) : (
                profileStatus && (
                  <FieldDescription role="status" aria-live="polite">
                    {profileStatus}
                  </FieldDescription>
                )
              )}
            </FieldContent>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <Button
                onClick={() => void chooseProfileForExport()}
                disabled={profileAction !== null}
              >
                {profileAction === "export" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Download data-icon="inline-start" aria-hidden />
                )}
                {profileAction === "export" ? "正在导出…" : "导出配置"}
              </Button>
              <Button
                variant="outline"
                onClick={() => void chooseProfileForImport()}
                disabled={profileAction !== null}
              >
                {profileAction === "import" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Upload data-icon="inline-start" aria-hidden />
                )}
                {profileAction === "import" ? "正在导入…" : "导入配置"}
              </Button>
            </div>
          </Field>
        </Section>
        <Section title="本地缓存" keywords="缓存 图片 头像 封面 清除 清理 占用 空间">
          <ImageCacheField />
        </Section>
      </SettingsContent>
    ),
    about: (
      <SettingsContent title="关于">
        <AboutSettings />
      </SettingsContent>
    ),
  };
  const normalizedSearchQuery = searchQuery.trim();
  const categoryMetadata = category
    ? settingsCategories.find((item) => item.value === category)
    : undefined;

  useEffect(() => {
    setProxyDraft(proxy ?? "");
  }, [proxy]);

  function saveProxy() {
    setProxyStatus(null);
    const next = normalizeHttpProxy(proxyDraft);
    if (next.error) {
      setProxyError(next.error);
      return;
    }
    setProxyError(null);
    setProxy(next.value);
    setProxyDraft(next.value ?? "");
    setProxyStatus(next.value ? "代理已保存，将用于后续请求" : "代理已关闭，后续请求将直连");
  }

  async function exportProfile(path: string) {
    setProfileStatus(null);
    setProfileError(null);
    setProfileAction("export");
    try {
      await invokeCmd("profile_export", { path });
      setProfileStatus("配置已导出。档案不包含 Cookie、发送授权或本机路径。");
    } catch (cause) {
      setProfileError(`导出失败：${errorMessage(cause)}`);
    } finally {
      setProfileAction(null);
    }
  }

  async function importProfile(path: string) {
    setProfileStatus(null);
    setProfileError(null);
    setProfileAction("import");
    try {
      const r = await invokeCmd<{
        follows: number;
        iptv_favorites?: number;
        iptv_favorite_groups?: number;
        tags: number;
        history: number;
        settings: boolean;
      }>("profile_import", { path });
      await loadFromBackend();
      // 导入不仅改变关注/历史，也可能改变设置。把每个缓存页标记为过期并立即刷新
      // 当前屏幕上的页面，使外壳无法展示旧平台或过期的本地数据。
      await queryClient.invalidateQueries({ refetchType: "active" });
      setProfileStatus(
        `已导入：${r.follows} 个主播关注、${r.iptv_favorites ?? 0} 个 IPTV 关注、${r.iptv_favorite_groups ?? 0} 个 IPTV 分组、${r.tags} 个标签、${r.history} 条历史记录。`,
      );
    } catch (cause) {
      setProfileError(`导入失败：${errorMessage(cause)}`);
    } finally {
      setProfileAction(null);
    }
  }

  async function chooseProfileForImport() {
    if (profileAction) return;
    setProfileStatus(null);
    setProfileError(null);
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        title: "导入 rLive 配置档案",
        filters: PROFILE_FILE_FILTERS,
      });
      if (typeof path === "string") {
        await importProfile(path);
      }
    } catch (cause) {
      setProfileError(`打开导入文件失败：${errorMessage(cause)}`);
    }
  }

  async function chooseProfileForExport() {
    if (profileAction) return;
    setProfileStatus(null);
    setProfileError(null);
    try {
      const path = await saveFileDialog({
        title: "导出 rLive 配置档案",
        defaultPath: "rlive-profile.json",
        filters: PROFILE_FILE_FILTERS,
      });
      if (typeof path === "string") {
        await exportProfile(path);
      }
    } catch (cause) {
      setProfileError(`选择导出位置失败：${errorMessage(cause)}`);
    }
  }

  return (
    <div className="mx-auto flex h-full min-h-full w-full max-w-6xl flex-col">
      <SettingsSearchContext.Provider value={normalizedSearchQuery}>
        <PagePan
          panKey={settingsMotionKey}
          direction={settingsMotionDirection}
          className="min-h-full"
          contentClassName="min-h-full overflow-x-hidden overflow-y-auto overscroll-y-contain touch-pan-y"
        >
          {category && categoryMetadata ? (
            <div className="settings-detail flex min-h-full flex-col gap-5">
              <div className="settings-detail-header flex items-center gap-3 border-b border-border-subtle pb-4">
                <div className="settings-back-slot shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    className="motion-back-button"
                    aria-label="返回设置首页"
                    onClick={returnToOverview}
                  >
                    <ArrowLeft
                      className="transition-transform duration-150 ease-[var(--motion-ease-out)]"
                      aria-hidden
                    />
                  </Button>
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-xl font-semibold text-foreground">
                    {categoryMetadata.label}
                  </h1>
                </div>
              </div>
              <div className="min-w-0 max-w-4xl">{settingsCategoryPanels[category]}</div>
            </div>
          ) : (
            <SettingsCategoryOverview
              query={searchQuery}
              onQueryChange={setSearchQuery}
              mobileClient={mobileClient}
              onOpen={(value) => {
                setSearchQuery("");
                setCategory(value);
              }}
            />
          )}
        </PagePan>
      </SettingsSearchContext.Provider>
    </div>
  );
}

function SettingsContent({ title, children }: { title: string; children: React.ReactNode }) {
  const query = useContext(SettingsSearchContext);
  const hasCategoryMatch = matchesSearch(settingsCategorySearchText[titleToCategory(title)], query);

  return (
    <div data-slot="settings-content" className="flex min-h-full min-w-0 flex-col gap-4">
      <h2 className="sr-only">{title}</h2>
      {query && <p className="text-xs text-muted-foreground">当前分类的筛选结果</p>}
      {hasCategoryMatch ? (
        children
      ) : (
        <Empty className="min-h-64 border border-dashed border-border-subtle bg-muted/10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden />
            </EmptyMedia>
            <EmptyTitle>没有匹配的设置</EmptyTitle>
            <EmptyDescription>试试其他关键词，或清除搜索继续浏览。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function titleToCategory(title: string): SettingsCategory {
  switch (title) {
    case "外观":
      return "appearance";
    case "播放":
      return "playback";
    case "平台":
      return "platform";
    case "网络":
      return "network";
    case "账号":
      return "account";
    case "录制":
      return "recording";
    case "数据":
      return "data";
    default:
      return "about";
  }
}
