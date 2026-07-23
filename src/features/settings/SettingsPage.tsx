import { useEffect, useState } from "react";
import { invokeCmd } from "../../shared/api/tauri";
import type { ThemeMode } from "../../shared/stores/settingsStore";
import { useSettingsStore } from "../../shared/stores/settingsStore";

const themes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type PlayerStatus = { running: boolean; mpv_path: string };

export function SettingsPage() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);
  const mpvPath = useSettingsStore((s) => s.mpvPath);
  const setMpvPath = useSettingsStore((s) => s.setMpvPath);
  const loadFromBackend = useSettingsStore((s) => s.loadFromBackend);

  const [cookie, setCookie] = useState("");
  const [proxyDraft, setProxyDraft] = useState(proxy ?? "");
  const [mpvDraft, setMpvDraft] = useState(mpvPath ?? "");
  const [cookieStatus, setCookieStatus] = useState<string | null>(null);
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
  const [mpvStatusMsg, setMpvStatusMsg] = useState<string | null>(null);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [loadingCookie, setLoadingCookie] = useState(true);

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
        if (!cancelled) {
          setCookie(value ?? "");
        }
      } catch {
        if (!cancelled) {
          setCookie("");
        }
      } finally {
        if (!cancelled) {
          setLoadingCookie(false);
        }
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
        setCookieStatus("Cookie cleared");
      } else {
        await invokeCmd<void>("account_set_cookie", {
          siteId: "bilibili",
          cookie: trimmed,
        });
        setCookieStatus("Cookie saved");
      }
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setCookieStatus(`Failed: ${msg}`);
    }
  }

  async function saveProxy() {
    setProxyStatus(null);
    const next = proxyDraft.trim();
    setProxy(next.length === 0 ? null : next);
    setProxyStatus("Proxy saved");
  }

  async function saveMpvPath() {
    setMpvStatusMsg(null);
    const next = mpvDraft.trim();
    setMpvPath(next.length === 0 ? null : next);
    setMpvStatusMsg("mpv path saved");
    try {
      const st = await invokeCmd<PlayerStatus>("player_status");
      setPlayerStatus(st);
    } catch {
      /* ignore outside tauri */
    }
  }

  return (
    <div className="space-y-8 max-w-xl">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Theme
        </h2>
        <div className="flex flex-wrap gap-2">
          {themes.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={
                theme === value
                  ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Proxy
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Optional HTTP(S) proxy for site requests, e.g.{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            http://127.0.0.1:7890
          </code>
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={proxyDraft}
            onChange={(e) => setProxyDraft(e.target.value)}
            placeholder="http://127.0.0.1:7890"
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            onClick={() => void saveProxy()}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Save
          </button>
        </div>
        {proxyStatus && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{proxyStatus}</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          mpv player
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Optional absolute path to the mpv binary. Leave empty to use PATH (
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">mpv</code>
          ). Live playback opens an external mpv window.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={mpvDraft}
            onChange={(e) => setMpvDraft(e.target.value)}
            placeholder="/usr/bin/mpv"
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            onClick={() => void saveMpvPath()}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Save
          </button>
        </div>
        {mpvStatusMsg && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{mpvStatusMsg}</p>
        )}
        {playerStatus && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Resolved:{" "}
            <span className="font-mono">
              {playerStatus.mpv_path || "(not found)"}
            </span>
            {playerStatus.running ? " · running" : ""}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Bilibili cookie
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Paste cookie string for read-only APIs that require login. Stored only
          on this device. Leave empty and save to clear.
        </p>
        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          disabled={loadingCookie}
          rows={5}
          placeholder={loadingCookie ? "Loading…" : "SESSDATA=…; bili_jct=…"}
          className="w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void saveCookie()}
            disabled={loadingCookie}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Save cookie
          </button>
          {cookieStatus && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {cookieStatus}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
