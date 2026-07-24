import { useEffect, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import type { SiteId } from "@/shared/types/live";
import type { ThemeMode } from "@/shared/stores/settingsStore";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { PageHeader } from "@/shared/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const themes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

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
      <FieldSet>
        <FieldLegend variant="label">{title}</FieldLegend>
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldGroup className="gap-3">{children}</FieldGroup>
      </FieldSet>
    </section>
  );
}

function CookieField({
  siteId,
  title,
  description,
  placeholder,
}: {
  siteId: SiteId;
  title: string;
  description: string;
  placeholder: string;
}) {
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inputId = `${siteId}-cookie`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const value = await invokeCmd<string | null>("account_get_cookie", {
          siteId,
        });
        if (!cancelled) setCookie(value ?? "");
      } catch {
        if (!cancelled) setCookie("");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  async function saveCookie() {
    setStatus(null);
    try {
      const trimmed = cookie.trim();
      if (trimmed.length === 0) {
        await invokeCmd<void>("account_clear_cookie", { siteId });
        setCookie("");
        setStatus("Cookie 已清除");
      } else {
        await invokeCmd<void>("account_set_cookie", {
          siteId,
          cookie: trimmed,
        });
        setStatus("Cookie 已保存");
      }
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setStatus(`失败：${message}`);
    }
  }

  return (
    <Section title={title} description={description}>
      <Field>
        <FieldLabel htmlFor={inputId}>Cookie</FieldLabel>
        <FieldContent>
          <Textarea
            id={inputId}
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            disabled={loading}
            rows={5}
            placeholder={loading ? "加载中…" : placeholder}
            className="resize-y font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex items-center gap-3">
            <Button onClick={() => void saveCookie()} disabled={loading}>
              保存 Cookie
            </Button>
            {status && <FieldDescription>{status}</FieldDescription>}
          </div>
        </FieldContent>
      </Field>
    </Section>
  );
}

export function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const qualityLevel = useSettingsStore((s) => s.qualityLevel);
  const setQualityLevel = useSettingsStore((s) => s.setQualityLevel);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState("");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadFromBackend();
  }, [loadFromBackend]);

  useEffect(() => {
    setProxyDraft(proxy ?? "");
  }, [proxy]);

  async function saveProxy() {
    setProxyStatus(null);
    const next = proxyDraft.trim();
    setProxy(next.length === 0 ? null : next);
    setProxyStatus("代理已保存");
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
      setProfileStatus(`已导入 关注=${r.follows} 标签=${r.tags} 历史=${r.history}`);
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
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <PageHeader title="设置" />

      <Section title="外观">
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle id="theme-label">应用主题</FieldTitle>
            <FieldDescription>选择界面的亮暗模式。</FieldDescription>
          </FieldContent>
          <ToggleGroup
            aria-labelledby="theme-label"
            value={[theme]}
            variant="outline"
            size="sm"
            spacing={1}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "system" || next === "light" || next === "dark") {
                setTheme(next);
              }
            }}
          >
            {themes.map(({ value, label }) => (
              <ToggleGroupItem key={value} value={value}>
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      </Section>

      <Section
        title="默认清晰度"
        description="进入直播间时按偏好选择清晰度（高 / 中 / 低），对齐 Simple Live"
      >
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle id="quality-label">优先清晰度</FieldTitle>
            <FieldDescription>线路提供时优先选择此档位。</FieldDescription>
          </FieldContent>
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
      </Section>

      <Section title="网络代理" description="可选 HTTP(S) 代理，例如 http://127.0.0.1:7890">
        <Field>
          <FieldLabel htmlFor="proxy">代理地址</FieldLabel>
          <FieldContent>
            <div className="flex gap-2">
              <Input
                id="proxy"
                value={proxyDraft}
                onChange={(event) => setProxyDraft(event.target.value)}
                placeholder="http://127.0.0.1:7890"
              />
              <Button onClick={() => void saveProxy()}>保存</Button>
            </div>
            {proxyStatus && <FieldDescription>{proxyStatus}</FieldDescription>}
          </FieldContent>
        </Field>
      </Section>

      <CookieField
        siteId="bilibili"
        title="哔哩哔哩 Cookie"
        description="粘贴用于只读 API 的 Cookie。仅保存在本机；清空后保存即可删除。"
        placeholder="SESSDATA=…; bili_jct=…"
      />

      <CookieField
        siteId="douyin"
        title="抖音 Cookie"
        description="可选。保存网页端 Cookie（至少含 ttwid）可提高抖音房间解析与画质可用性；仅保存在本机。"
        placeholder="ttwid=…; msToken=…"
      />

      <Section
        title="配置导入 / 导出"
        description="非敏感备份：设置、关注、标签、历史、屏蔽词。不包含 Cookie。"
      >
        <Field>
          <FieldLabel htmlFor="profile-path">文件路径</FieldLabel>
          <FieldContent>
            <Input
              id="profile-path"
              value={profilePath}
              onChange={(event) => setProfilePath(event.target.value)}
              placeholder="/tmp/rlive-profile.json"
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void exportProfile()}>导出</Button>
              <Button variant="outline" onClick={() => void importProfile()}>
                导入
              </Button>
            </div>
            {profileStatus && <FieldDescription>{profileStatus}</FieldDescription>}
          </FieldContent>
        </Field>
      </Section>
    </div>
  );
}
