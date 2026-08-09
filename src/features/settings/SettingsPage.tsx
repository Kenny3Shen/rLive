import { useGSAP } from "@gsap/react";
import { useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import gsap from "gsap";
import { flushSync } from "react-dom";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  Download,
  ExternalLink,
  Info,
  LogOut,
  MonitorPlay,
  Network,
  QrCode,
  Radio,
  RefreshCw,
  Search,
  SearchX,
  ShieldAlert,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { invokeCmd } from "@/shared/api/tauri";
import { revealThemeAt } from "@/app/theme";
import { invalidateCookieDependentSiteQueries } from "@/shared/api/cookieQueryInvalidation";
import { enabledSiteIds, LIVE_SITE_IDS } from "@/shared/siteId";
import type { AsrProvider, SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { SiteLogo } from "@/shared/components/SiteLogo";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { isMobileClient, isWindowsDesktop } from "@/shared/clientPlatform";
import { motionProfile, prefersReducedMotion } from "@/shared/motion/tokens";
import { describeAsrModelStatus, useAsrModelStatus } from "@/features/asr/model";
import {
  AsrCaptionFontSizeField,
  AsrChunkIntervalField,
  AsrHotwordsField,
  DanmakuAppearanceResetButton,
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
  SuperChatSettingsFields,
} from "@/features/settings/PlaybackPreferenceFields";
import { cn, SITE_LABELS } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

type SettingsCategory = "playback" | "platform" | "network" | "account" | "data" | "about";

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
}[] = [
  { value: "playback", label: "播放", icon: MonitorPlay },
  { value: "platform", label: "平台", icon: Radio },
  { value: "network", label: "网络", icon: Network },
  { value: "account", label: "账号", icon: UserRound },
  { value: "data", label: "数据", icon: Database },
  { value: "about", label: "关于", icon: Info },
];

const PROJECT_HOMEPAGE_URL = "https://github.com/Kenny3Shen/rLive";
const PROFILE_FILE_FILTERS = [{ name: "rLive 配置档案", extensions: ["json"] }];

const settingsCategorySearchText: Record<SettingsCategory, string> = {
  playback:
    "播放 外观 主题 深色 暗色 浅色 亮色 播放质量 清晰度 线路记忆 软切换 语音 字幕 asr zipformer 标点 说话人 热词 刷新间隔 CUDA NVIDIA GPU 推理后端 弹幕 轨道 区域 行数 文字 透明度 字号 速度 字重 过滤 屏蔽词 重复 礼物 合并 醒目留言 sc",
  platform: "平台 直播平台 bilibili 哔哩哔哩 douyu 斗鱼 huya 虎牙 douyin 抖音 twitch",
  network: "网络 代理 iptv IPTV M3U 源 地址",
  account:
    "账号 发送权限 平台账号 bilibili 哔哩哔哩 douyu 斗鱼 huya 虎牙 douyin 抖音 cookie 登录 扫码",
  data: "数据 导入 导出 配置 档案",
  about: "关于 rLive 项目主页 github 免责声明",
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

function useCompactSettingsLayout(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function isDanmakuSendCookieSite(siteId: SiteId): boolean {
  return siteId === "bilibili" || siteId === "douyu" || siteId === "huya" || siteId === "douyin";
}

/** Huya UDB serves a ready-made PNG; other platforms return encodeable payloads. */
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
      className="overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm shadow-black/10"
    >
      <FieldSet className="gap-0 py-0">
        <div className="border-b border-border-subtle bg-muted/20 px-4 py-2.5">
          <FieldLegend variant="label" className="m-0 text-sm font-semibold text-foreground">
            {title}
          </FieldLegend>
        </div>
        <FieldGroup className="gap-0 divide-y divide-border-subtle [&>[data-slot=field]]:px-4 [&>[data-slot=field]]:py-3">
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
          <div className="rounded-xl border border-border-subtle bg-card p-2 shadow-sm">
            {session ? (
              isHostedQrImageUrl(session.qr_code_url) ? (
                // Huya UDB returns a PNG from getQrImg; other platforms give a
                // payload string that QRCodeSVG encodes locally.
                <img
                  src={session.qr_code_url}
                  alt={`${siteName}登录二维码`}
                  width={176}
                  height={176}
                  className="size-44 rounded-lg bg-white object-contain"
                  draggable={false}
                />
              ) : (
                <QRCodeSVG
                  value={session.qr_code_url}
                  size={176}
                  level="M"
                  includeMargin={false}
                  fgColor="#111111"
                  bgColor="#ffffff"
                  title={`${siteName}登录二维码`}
                />
              )
            ) : (
              <div className="flex size-44 items-center justify-center text-muted-foreground">
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
    // The Cookie write has already succeeded at this point. A failed network
    // refresh must not turn that successful account update into a UI error;
    // the affected query keeps its own error state and remains stale to retry.
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

  const COOKIE_EXPIRED_NOTICE = "Cookie 已失效，弹幕将改用匿名模式获取，发送功能不可用。";

  useEffect(() => {
    if (profileLoading) return;
    if (expired) {
      if (notice !== COOKIE_EXPIRED_NOTICE) setNotice(COOKIE_EXPIRED_NOTICE);
    } else if (notice === COOKIE_EXPIRED_NOTICE) {
      setNotice(null);
    }
  }, [expired, profileLoading, notice]);

  return (
    <>
      <Field orientation="responsive">
        <FieldContent>
          <div className="flex flex-wrap items-center gap-2">
            <FieldTitle>
              <SiteLogo siteId={siteId} className="size-5" />
              {title}
            </FieldTitle>
            <Badge variant={expired ? "destructive" : hasCookie ? "secondary" : "outline"}>
              {accountState}
            </Badge>
            {displayName && <span className="min-w-0 truncate text-sm">{displayName}</span>}
          </div>
          {notice && <FieldDescription role="status">{notice}</FieldDescription>}
          {profileError && <FieldError>{profileError}</FieldError>}
        </FieldContent>
        <div className="flex flex-wrap items-center gap-2">
          {qrLogin && (
            <Button variant="outline" size="sm" onClick={() => setLoginMethod("qr")}>
              <QrCode data-icon="inline-start" aria-hidden />
              扫码登录
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setLoginMethod("manual")}>
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
  const estimatedDownloadSize = punctuationEnabled
    ? speakerEnabled
      ? "577"
      : "550"
    : speakerEnabled
      ? "515"
      : "488";
  return (
    <>
      <FieldGroup className="gap-0 divide-y divide-border-subtle [&>[data-slot=field]]:px-4 [&>[data-slot=field]]:py-3">
        <Field
          orientation="responsive"
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
              <FieldDescription role="status" aria-live="polite">
                {presentation.message}
              </FieldDescription>
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

        <Field orientation="responsive" data-disabled={!model.supported || pending || undefined}>
          <FieldContent>
            <FieldTitle id="asr-vad-title">VAD（静音端点检测）</FieldTitle>
            <FieldDescription>关闭后仅按最长 20 秒切分。</FieldDescription>
          </FieldContent>
          <Switch
            aria-labelledby="asr-vad-title"
            checked={vadEnabled}
            disabled={!model.supported || model.isPending || pending}
            onCheckedChange={(checked) => void applyVadEnabled(checked)}
          />
        </Field>

        {isWindowsDesktop() && (
          <Field orientation="responsive" data-disabled={!model.supported || pending || undefined}>
            <FieldContent>
              <FieldTitle id="asr-provider-title">推理后端</FieldTitle>
              <FieldDescription>自动优先使用 CUDA，不可用时回退 CPU。</FieldDescription>
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

        <Field orientation="responsive" data-disabled={!model.supported || pending || undefined}>
          <FieldContent>
            <FieldTitle id="asr-punctuation-title">自动标点</FieldTitle>
            <FieldDescription>关闭后保留原始文本。</FieldDescription>
          </FieldContent>
          <Switch
            aria-labelledby="asr-punctuation-title"
            checked={punctuationEnabled}
            disabled={!model.supported || model.isPending || pending}
            onCheckedChange={(checked) => void applyPunctuationEnabled(checked)}
          />
        </Field>

        <Field orientation="responsive" data-disabled={!model.supported || pending || undefined}>
          <FieldContent>
            <FieldTitle id="asr-speaker-title">说话人区分</FieldTitle>
            <FieldDescription>首次启用需下载约 27 MB。</FieldDescription>
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
      </FieldGroup>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Download aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>下载语音字幕模型</AlertDialogTitle>
            <AlertDialogDescription>
              将下载约 {estimatedDownloadSize} MB 模型，完成后自动启用并保留在本机。
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
  const switchRef = useRef<HTMLButtonElement>(null);
  const switchingRef = useRef(false);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"));

  function handleThemeChange(checked: boolean) {
    if (checked === isDark || switchingRef.current) return;
    switchingRef.current = true;

    const rect = switchRef.current?.getBoundingClientRect();
    const transition = revealThemeAt(
      rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      () => flushSync(() => setTheme(checked ? "dark" : "light")),
    );

    void transition.finished.finally(() => {
      switchingRef.current = false;
    });
  }

  return (
    <Section title="外观" keywords="主题 深色 暗色 浅色 亮色">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle id="dark-mode-label">深色模式</FieldTitle>
        </FieldContent>
        <Switch
          ref={switchRef}
          aria-labelledby="dark-mode-label"
          checked={isDark}
          onCheckedChange={handleThemeChange}
        />
      </Field>
    </Section>
  );
}

function AboutSettings() {
  function openProjectHomepage() {
    void openUrl(PROJECT_HOMEPAGE_URL).catch(() => {
      // Keep the link useful in a browser-based development preview, where
      // the native opener plugin is intentionally unavailable.
      window.open(PROJECT_HOMEPAGE_URL, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <AlertDialog>
        <Section title="关于 rLive" keywords="项目主页 github 免责声明">
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
  const motionRootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const qualityLevel = useSettingsStore((s) => s.qualityLevel);
  const setQualityLevel = useSettingsStore((s) => s.setQualityLevel);
  const playbackSoftSwitchEnabled = useSettingsStore((s) => s.playbackSoftSwitchEnabled);
  const setPlaybackSoftSwitchEnabled = useSettingsStore((s) => s.setPlaybackSoftSwitchEnabled);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<"import" | "export" | null>(null);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("playback");
  const [searchQuery, setSearchQuery] = useState("");
  const compactLayout = useCompactSettingsLayout();
  const mobileClient = isMobileClient();
  const categoryTabRefs = useRef(new Map<SettingsCategory, HTMLButtonElement | null>());
  const settingsCategoryValues = useMemo(() => settingsCategories.map((item) => item.value), []);
  const settingsCategorySwipe = useHorizontalSwipe({
    items: settingsCategoryValues,
    value: category,
    onChange: setCategory,
    enabled: mobileClient,
    // The neighbouring category rides the same track, so it is already on
    // screen and follows the finger rather than appearing on release.
    layout: "track",
  });
  // Settings pages are heavy (the playback one carries every danmaku control).
  // A track only ever shows the current page and the one it is sliding toward,
  // so mount that window instead of all six.
  const categoryIndex = settingsCategoryValues.indexOf(category);
  const isCategoryMounted = (value: SettingsCategory) =>
    Math.abs(settingsCategoryValues.indexOf(value) - categoryIndex) <= 1;
  const categoryTrackStyle = { width: `${settingsCategoryValues.length * 100}%` };
  const categoryPanelStyle = { width: `${100 / settingsCategoryValues.length}%` };
  // Panel bodies keyed by category so the swipe track can mount just the
  // window it needs without duplicating this JSX.
  const settingsCategoryPanels: Record<SettingsCategory, ReactNode> = {
    playback: (
      <SettingsContent title="播放">
        <AppearanceSettings />
        <Section title="播放质量" keywords="清晰度 线路记忆 软切换 线路">
          <Field orientation="responsive">
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
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle id="soft-switch-title">软切换</FieldTitle>
              <FieldDescription>
                同协议换源时保留播放器；FLV 会重建内部流内核，失败时自动完整重建。
              </FieldDescription>
            </FieldContent>
            <Switch
              aria-labelledby="soft-switch-title"
              checked={playbackSoftSwitchEnabled}
              onCheckedChange={setPlaybackSoftSwitchEnabled}
            />
          </Field>
        </Section>
        {!mobileClient && (
          <Section
            title="语音字幕"
            keywords="语音 字幕 asr zipformer 标点 说话人 热词 刷新间隔 CUDA NVIDIA GPU 推理后端"
          >
            <AsrModelField />
            <AsrCaptionFontSizeField idPrefix="settings" layout="page" />
          </Section>
        )}
        <Section title="弹幕轨道" keywords="弹幕 轨道 区域 行数">
          <DanmakuTrackSettingsFields idPrefix="settings" layout="page" />
        </Section>
        <Section title="弹幕文字与节奏" keywords="弹幕 文字 透明度 字号 速度 字重">
          <DanmakuAppearanceSettingsFields idPrefix="settings" layout="page" />
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>恢复弹幕默认设置</FieldTitle>
              <FieldDescription>
                重置轨道、文字、过滤和 SC 透明度，屏蔽词不会被清空。
              </FieldDescription>
            </FieldContent>
            <DanmakuAppearanceResetButton />
          </Field>
        </Section>
        <Section title="弹幕过滤" keywords="弹幕 过滤 屏蔽词 重复 礼物 合并">
          <DanmakuFilterSettingsFields idPrefix="settings" layout="page" />
        </Section>
        <Section title="醒目留言" keywords="醒目留言 sc 透明度">
          <SuperChatSettingsFields idPrefix="settings" layout="page" />
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
    data: (
      <SettingsContent title="数据">
        <Section title="导入 / 导出" keywords="数据 导入 导出 配置 档案">
          <Field data-invalid={profileError ? true : undefined}>
            <FieldContent>
              <FieldTitle>配置档案</FieldTitle>
              <div className="mt-1 flex flex-wrap gap-2">
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
          </Field>
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

  useEffect(() => {
    if (
      !normalizedSearchQuery ||
      matchesSearch(settingsCategorySearchText[category], normalizedSearchQuery)
    ) {
      return;
    }
    const firstMatch = settingsCategories.find(({ value }) =>
      matchesSearch(settingsCategorySearchText[value], normalizedSearchQuery),
    );
    if (firstMatch) setCategory(firstMatch.value);
  }, [category, normalizedSearchQuery]);

  useGSAP(
    () => {
      const root = motionRootRef.current;
      if (!root || prefersReducedMotion()) return;
      const targets = gsap.utils.toArray<HTMLElement>("[data-settings-intro]", root);
      if (targets.length === 0) return;

      const profile = motionProfile();
      gsap.fromTo(
        targets,
        { autoAlpha: 0, y: 10, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          duration: profile.enter.duration,
          ease: profile.enter.ease,
          stagger: 0.04,
          clearProps: "transform,opacity,visibility,willChange",
        },
      );
    },
    { scope: motionRootRef },
  );

  // Switching category no longer fades a panel in: every category is mounted
  // side by side in the swipe track, so the change is carried by the track's
  // own pan. A `querySelector` entrance here would always hit the first panel
  // regardless of the selection, and stack a fade on top of that travel.

  useEffect(() => {
    setProxyDraft(proxy ?? "");
  }, [proxy]);

  useEffect(() => {
    if (!compactLayout) return;
    const activeTab = categoryTabRefs.current.get(category);
    if (!activeTab) return;

    // A compact tab strip intentionally scrolls horizontally. Keep keyboard
    // and programmatic category changes discoverable instead of leaving the
    // newly selected panel's trigger offscreen.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeTab.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [category, compactLayout]);

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
      // Import can change settings as well as follows/history. Mark every
      // cached page stale and immediately refresh pages currently on screen,
      // so the shell cannot show an old platform or stale local data.
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
    <div
      ref={motionRootRef}
      data-horizontal-swipe-surface
      className="mx-auto flex h-full min-h-full w-full max-w-6xl flex-col gap-6 touch-pan-y"
      onPointerDownCapture={settingsCategorySwipe.onPointerDownCapture}
      onPointerMoveCapture={settingsCategorySwipe.onPointerMoveCapture}
      onPointerUpCapture={settingsCategorySwipe.onPointerUpCapture}
      onPointerCancelCapture={settingsCategorySwipe.onPointerCancelCapture}
      onClickCapture={settingsCategorySwipe.onClickCapture}
    >
      <h1 className="sr-only">设置</h1>

      <SettingsSearchContext.Provider value={normalizedSearchQuery}>
        <Tabs
          value={category}
          orientation={compactLayout ? "horizontal" : "vertical"}
          className={cn("min-h-full gap-6", compactLayout ? "h-full" : "min-h-[32rem] gap-8")}
          onValueChange={(value) => setCategory(value as SettingsCategory)}
        >
          <div
            data-settings-intro
            className={cn(
              "flex shrink-0 flex-col gap-3",
              !compactLayout && "w-48 border-r border-border-subtle pr-5",
            )}
          >
            <InputGroup className={cn("w-full", compactLayout ? "order-2" : "order-1")}>
              <InputGroupAddon align="inline-start">
                <Search aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="搜索设置"
                placeholder="搜索设置"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              {searchQuery && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="清除设置搜索"
                    onClick={() => setSearchQuery("")}
                  >
                    <X aria-hidden />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <TabsList
              aria-label="设置分类"
              variant={compactLayout ? "line" : "default"}
              className={cn(
                compactLayout
                  ? "scroll-fade-x order-1 sticky top-0 h-12! w-full flex-row! justify-start overflow-x-auto bg-background"
                  : "order-2 w-full items-stretch",
              )}
            >
              {settingsCategories.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  ref={(node) => {
                    categoryTabRefs.current.set(value, node);
                  }}
                  className={cn(
                    "h-11 shrink-0 gap-2 px-3 py-2",
                    compactLayout ? "w-auto! flex-none! justify-center text-center" : "text-left",
                  )}
                >
                  <Icon aria-hidden />
                  <span>{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div
            data-slot="horizontal-swipe-viewport"
            // Only the horizontal overflow is clipped. The page scrolls in
            // Shell's scroller, so hiding overflow on both axes here would cut
            // long categories off at the viewport instead of letting them grow.
            className="min-h-0 w-full max-w-4xl min-w-0 flex-1 overflow-x-clip"
          >
            <div
              ref={settingsCategorySwipe.pageRef as React.Ref<HTMLDivElement>}
              data-slot="horizontal-swipe-track"
              className="flex min-h-0 items-start"
              style={categoryTrackStyle}
            >
              {settingsCategoryValues.map((value) => (
                // Every category holds its slot so the track keeps its
                // geometry; only the visible window renders real content.
                <TabsContent
                  key={value}
                  value={value}
                  keepMounted
                  hidden={false}
                  inert={category === value ? undefined : true}
                  className="mt-0 min-w-0 shrink-0"
                  style={categoryPanelStyle}
                >
                  {isCategoryMounted(value) && settingsCategoryPanels[value]}
                </TabsContent>
              ))}
            </div>
          </div>
        </Tabs>
      </SettingsSearchContext.Provider>
    </div>
  );
}

function SettingsContent({ title, children }: { title: string; children: React.ReactNode }) {
  const query = useContext(SettingsSearchContext);
  const hasCategoryMatch = matchesSearch(settingsCategorySearchText[titleToCategory(title)], query);

  return (
    <div data-slot="settings-content" className="flex min-h-full min-w-0 flex-col gap-4">
      <div className="flex items-baseline gap-3 border-b border-border-subtle pb-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        {query && <span className="text-xs text-muted-foreground">筛选结果</span>}
      </div>
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
    case "播放":
      return "playback";
    case "平台":
      return "platform";
    case "网络":
      return "network";
    case "账号":
      return "account";
    case "数据":
      return "data";
    default:
      return "about";
  }
}
