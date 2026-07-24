import { useEffect, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import type { ThemeMode } from "@/shared/stores/settingsStore";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { PageHeader } from "@/shared/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const themes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

type PlayerStatus = { running: boolean; mpv_path: string };

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-subtle bg-card/60 p-4 md:p-5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const mpvPath = useSettingsStore((s) => s.mpvPath);
  const setMpvPath = useSettingsStore((s) => s.setMpvPath);
  const qualityLevel = useSettingsStore((s) => s.qualityLevel);
  const setQualityLevel = useSettingsStore((s) => s.setQualityLevel);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);

  const [cookie, setCookie] = useState("");
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [mpvDraft, setMpvDraft] = useState(mpvPath ?? "");
  const [cookieStatus, setCookieStatus] = useState<string | null>(null);
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [mpvStatusMsg, setMpvStatusMsg] = useState<string | null>(null);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [loadingCookie, setLoadingCookie] = useState(true);
  const [profilePath, setProfilePath] = useState("");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const danmakuShieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const [shieldDraft, setShieldDraft] = useState(danmakuShieldWords.join("\n"));

  useEffect(() => {
    void loadFromBackend();
  }, [loadFromBackend]);

  useEffect(() => {
    setProxyDraft(proxy ?? "");
  }, [proxy]);

  useEffect(() => {
    setMpvDraft(mpvPath ?? "");
  }, [mpvPath]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCookie(true);
      try {
        const value = await invokeCmd<string | null>("account_get_cookie", {
          siteId: "bilibili",
        });
        if (!cancelled) setCookie(value ?? "");
      } catch {
        if (!cancelled) setCookie("");
      } finally {
        if (!cancelled) setLoadingCookie(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const st = await invokeCmd<PlayerStatus>("player_status");
        if (!cancelled) setPlayerStatus(st);
      } catch {
        if (!cancelled) setPlayerStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveCookie() {
    setCookieStatus(null);
    try {
      const trimmed = cookie.trim();
      if (trimmed.length === 0) {
        await invokeCmd<void>("account_clear_cookie", { siteId: "bilibili" });
        setCookie("");
        setCookieStatus("Cookie 已清除");
      } else {
        await invokeCmd<void>("account_set_cookie", {
          siteId: "bilibili",
          cookie: trimmed,
        });
        setCookieStatus("Cookie 已保存");
      }
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setCookieStatus(`失败：${msg}`);
    }
  }

  async function saveProxy() {
    setProxyStatus(null);
    const next = proxyDraft.trim();
    setProxy(next.length === 0 ? null : next);
    setProxyStatus("代理已保存");
  }

  async function saveMpvPath() {
    setMpvStatusMsg(null);
    const next = mpvDraft.trim();
    setMpvPath(next.length === 0 ? null : next);
    setMpvStatusMsg("mpv 路径已保存");
    try {
      const st = await invokeCmd<PlayerStatus>("player_status");
      setPlayerStatus(st);
    } catch {
      /* ignore */
    }
  }

  async function saveShieldWords() {
    const words = shieldDraft
      .split(/\r?\n|,/)
      .map((w) => w.trim())
      .filter(Boolean);
    await useSettingsStore.getState().persistToBackend({
      danmaku_shield_words: words,
    });
    useSettingsStore.setState({ danmakuShieldWords: words });
    setShieldDraft(words.join("\n"));
  }

  async function exportProfile() {
    setProfileStatus(null);
    const path = profilePath.trim();
    if (!path) {
      setProfileStatus("请填写导出路径");
      return;
    }
    try {
      await invokeCmd("profile_export", { path });
      setProfileStatus(`已导出到 ${path}`);
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setProfileStatus(`导出失败：${msg}`);
    }
  }

  async function importProfile() {
    setProfileStatus(null);
    const path = profilePath.trim();
    if (!path) {
      setProfileStatus("请填写导入路径");
      return;
    }
    try {
      const r = await invokeCmd<{
        follows: number;
        tags: number;
        history: number;
        settings: boolean;
      }>("profile_import", { path });
      setProfileStatus(
        `已导入 关注=${r.follows} 标签=${r.tags} 历史=${r.history}`,
      );
      await loadFromBackend();
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setProfileStatus(`导入失败：${msg}`);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title="设置" />

      <Section title="外观">
        <div className="flex flex-wrap gap-2">
          {themes.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-ring",
                theme === value
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="默认清晰度"
        description="进入直播间时按偏好选择清晰度（高 / 中 / 低），对齐 Simple Live"
      >
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: "high" as const, label: "最高" },
              { value: "mid" as const, label: "中间" },
              { value: "low" as const, label: "最低" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setQualityLevel(value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-ring",
                qualityLevel === value
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="网络代理"
        description="可选 HTTP(S) 代理，例如 http://127.0.0.1:7890"
      >
        <div className="flex gap-2">
          <Input
            value={proxyDraft}
            onChange={(e) => setProxyDraft(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
          <Button onClick={() => void saveProxy()}>保存</Button>
        </div>
        {proxyStatus && (
          <p className="text-xs text-muted-foreground">{proxyStatus}</p>
        )}
      </Section>

      <Section
        title="mpv 播放器"
        description="可选：mpv 可执行文件绝对路径。留空则使用 PATH 中的 mpv。"
      >
        <div className="flex gap-2">
          <Input
            value={mpvDraft}
            onChange={(e) => setMpvDraft(e.target.value)}
            placeholder="/usr/bin/mpv"
            className="font-mono text-xs"
          />
          <Button onClick={() => void saveMpvPath()}>保存</Button>
        </div>
        {mpvStatusMsg && (
          <p className="text-xs text-muted-foreground">{mpvStatusMsg}</p>
        )}
        {playerStatus && (
          <p className="text-xs text-muted-foreground">
            当前解析：
            <span className="ml-1 font-mono">
              {playerStatus.mpv_path || "（未找到）"}
            </span>
            {playerStatus.running ? " · 运行中" : ""}
          </p>
        )}
      </Section>

      <Section
        title="哔哩哔哩 Cookie"
        description="粘贴用于只读 API 的 Cookie。仅保存在本机。清空后点保存即可删除。"
      >
        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          disabled={loadingCookie}
          rows={5}
          placeholder={loadingCookie ? "加载中…" : "SESSDATA=…; bili_jct=…"}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs focus-ring disabled:opacity-50"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex items-center gap-3">
          <Button onClick={() => void saveCookie()} disabled={loadingCookie}>
            保存 Cookie
          </Button>
          {cookieStatus && (
            <p className="text-xs text-muted-foreground">{cookieStatus}</p>
          )}
        </div>
      </Section>

      <Section
        title="弹幕屏蔽词"
        description="每行一个词。匹配的聊天消息将在列表与飘屏中隐藏。"
      >
        <textarea
          value={shieldDraft}
          onChange={(e) => setShieldDraft(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
        />
        <Button onClick={() => void saveShieldWords()}>保存屏蔽词</Button>
      </Section>

      <Section
        title="配置导入 / 导出"
        description="非敏感备份：设置、关注、标签、历史、屏蔽词。不包含 Cookie。"
      >
        <Input
          value={profilePath}
          onChange={(e) => setProfilePath(e.target.value)}
          placeholder="/tmp/rlive-profile.json"
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void exportProfile()}>导出</Button>
          <Button variant="outline" onClick={() => void importProfile()}>
            导入
          </Button>
        </div>
        {profileStatus && (
          <p className="text-xs text-muted-foreground">{profileStatus}</p>
        )}
      </Section>
    </div>
  );
}
