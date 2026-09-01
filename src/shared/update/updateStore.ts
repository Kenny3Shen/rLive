import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { create } from "zustand";
import packageMetadata from "../../../package.json";

const LATEST_RELEASE_URL = "https://api.github.com/repos/Kenny3Shen/rLive/releases/latest";

export type UpdateRelease = {
  version: string;
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
};

export type UpdateStatus = "idle" | "checking" | "available" | "up-to-date" | "error";

type UpdateStore = {
  currentVersion: string;
  status: UpdateStatus;
  release: UpdateRelease | null;
  lastCheckedAt: number | null;
  error: string | null;
  dialogOpen: boolean;
  initialPromptShown: boolean;
  checkForUpdate: (options?: { force?: boolean }) => Promise<UpdateRelease | null>;
  showDialog: () => void;
  dismissDialog: () => void;
};

type GitHubReleaseResponse = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

let inFlight: Promise<UpdateRelease | null> | null = null;
let hasChecked = false;

export function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, "");
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  if ([match[1], match[2], match[3]].some((part) => part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  if (
    match[4]
      ?.split(".")
      .some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))
  ) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

/** 比较两个 SemVer 字符串；输入无效时返回 null。 */
export function compareVersionStrings(left: string, right: string): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  return parsedLeft && parsedRight ? compareVersions(parsedLeft, parsedRight) : null;
}

async function currentAppVersion(): Promise<string> {
  if (!isTauri()) return packageMetadata.version;
  try {
    return await getVersion();
  } catch {
    return packageMetadata.version;
  }
}

async function requestLatestRelease(): Promise<GitHubReleaseResponse> {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const response = isTauri()
    ? await tauriFetch(LATEST_RELEASE_URL, { headers, maxRedirections: 2 })
    : await globalThis.fetch(LATEST_RELEASE_URL, { headers });
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
  return (await response.json()) as GitHubReleaseResponse;
}

function normalizeRelease(value: GitHubReleaseResponse): UpdateRelease | null {
  if (typeof value.tag_name !== "string") return null;
  const version = value.tag_name.replace(/^v/i, "");
  if (!parseVersion(version)) return null;
  return {
    version,
    tagName: value.tag_name,
    name:
      typeof value.name === "string" && value.name.trim() ? value.name.trim() : `rLive ${version}`,
    body: typeof value.body === "string" ? value.body.trim() : "",
    htmlUrl:
      typeof value.html_url === "string" && value.html_url.startsWith("https://")
        ? value.html_url
        : `https://github.com/Kenny3Shen/rLive/releases/tag/${encodeURIComponent(value.tag_name)}`,
    publishedAt: typeof value.published_at === "string" ? value.published_at : null,
  };
}

async function performCheck(currentVersion: string): Promise<UpdateRelease | null> {
  const latest = normalizeRelease(await requestLatestRelease());
  if (!latest) return null;
  const current = parseVersion(currentVersion);
  const remote = parseVersion(latest.version);
  return current && remote && compareVersions(remote, current) > 0 ? latest : null;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  currentVersion: packageMetadata.version,
  status: "idle",
  release: null,
  lastCheckedAt: null,
  error: null,
  dialogOpen: false,
  initialPromptShown: false,
  checkForUpdate: async ({ force = false } = {}) => {
    if (inFlight) return inFlight;
    if (!force && hasChecked) return get().release;

    set({ status: "checking", error: null });
    inFlight = (async () => {
      try {
        const currentVersion = await currentAppVersion();
        set({ currentVersion });
        const release = await performCheck(currentVersion);
        hasChecked = true;
        set({
          currentVersion,
          status: release ? "available" : "up-to-date",
          release,
          lastCheckedAt: Date.now(),
          error: null,
          ...(release && !get().initialPromptShown
            ? { dialogOpen: true, initialPromptShown: true }
            : {}),
        });
        return release;
      } catch (cause) {
        hasChecked = true;
        const error = cause instanceof Error ? cause.message : String(cause);
        set({ status: "error", lastCheckedAt: Date.now(), error });
        throw cause;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
  showDialog: () => set({ dialogOpen: true }),
  dismissDialog: () => set({ dialogOpen: false }),
}));

/** 更新说明正文（Markdown）；为空时返回通用回退文案。 */
export function releaseNotes(release: UpdateRelease): string {
  return release.body.trim() || "此版本包含功能改进与问题修复。";
}
