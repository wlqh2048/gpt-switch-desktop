import {
  DisplayProfile,
  SyncProgress,
  SyncSummary,
} from "../shared/types";
import { DEFAULT_LANGUAGE, Language, translate } from "./i18n";

export type ThemeMode = "dark" | "light";
export type ViewMode = "grid" | "list";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

export interface SyncProgressPercentState {
  runId: string;
  percent: number;
}

const OFFICIAL_API_KEY_PREFIX = "ai-switch:official-api-key:";
export const SYNC_PROGRESS_DONE_HOLD_MS = 700;
const SYNC_PHASE_RANGES: Record<string, { start: number; end: number }> = {
  scan: { start: 8, end: 42 },
  rollout: { start: 42, end: 82 },
  index: { start: 82, end: 92 },
  pinned: { start: 92, end: 96 },
  done: { start: 100, end: 100 },
};

export function officialApiKeyStorageKey(profileId: string) {
  return `${OFFICIAL_API_KEY_PREFIX}${String(profileId || "").trim()}`;
}

export function readOfficialApiKey(profileId: string, storage: StorageLike = window.localStorage) {
  return String(storage.getItem(officialApiKeyStorageKey(profileId)) || "").trim();
}

export function storeOfficialApiKey(profileId: string, apiKey: string, storage: StorageLike = window.localStorage) {
  const key = officialApiKeyStorageKey(profileId);
  const value = String(apiKey || "").trim();
  if (value) {
    storage.setItem(key, value);
  } else {
    storage.removeItem(key);
  }
}

export function profilesWithLocalOfficialKeys(
  profiles: DisplayProfile[],
  storage: StorageLike = window.localStorage,
) {
  return profiles.map((profile) => {
    if (profile.source !== "official" || profile.apiKeyState === "saved") return profile;
    return readOfficialApiKey(profile.id, storage) ? { ...profile, apiKeyState: "saved" as const } : profile;
  });
}

export function initialSyncProgress(runId: string): SyncProgress {
  return {
    runId,
    phase: "scan",
    processed: 0,
    message: "准备同步消息",
  };
}

export function displayModel(profile: DisplayProfile) {
  return profile.models.find((item) => item.slug === profile.model)?.display_name || profile.model;
}

export function shellClassNameForUserAgent(userAgent: string) {
  const source = String(userAgent || "");
  const isMac = /Macintosh|Mac OS X|MacIntel/i.test(source);
  const isWindows = /Windows|Win32|Win64|WOW64/i.test(source);
  return [
    "app-shell",
    "is-overlay-titlebar",
    isMac ? "is-mac" : "",
    isWindows ? "is-windows" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function clientDownloadPlatformForUserAgent(userAgent: string) {
  const source = String(userAgent || "");
  if (/Macintosh|Mac OS X|MacIntel/i.test(source)) return "macos";
  if (/Windows|Win32|Win64|WOW64/i.test(source)) return "windows";
  return "unknown";
}

function parseSemver(value: string) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left: string, right: string) {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  if (!leftVersion || !rightVersion) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = leftVersion[key] - rightVersion[key];
    if (diff) return diff;
  }
  return 0;
}

export function updateNoticeForVersions(
  currentVersion: string,
  latestVersion: string,
  language: Language = DEFAULT_LANGUAGE,
) {
  const current = String(currentVersion || "").trim();
  const latest = String(latestVersion || "").trim();
  if (!current || !latest) return null;
  if (compareSemver(latest, current) <= 0) return null;
  return {
    latestVersion: latest,
    label: translate(language, "updateAvailable", { version: latest }),
  };
}

export function applyUpdateBlockForVersions(
  currentVersion: string,
  manifestVersion: string,
  language: Language = DEFAULT_LANGUAGE,
) {
  const notice = updateNoticeForVersions(currentVersion, manifestVersion, language);
  if (!notice) return null;
  return {
    latestVersion: notice.latestVersion,
    title: translate(language, "applyUpdateTitle"),
    content: translate(language, "applyUpdateContent", {
      version: notice.latestVersion,
    }),
    okText: translate(language, "updateNow"),
    cancelText: translate(language, "cancel"),
  };
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function progressRatio(progress: SyncProgress) {
  const processed = Math.max(0, Number(progress.processed) || 0);
  const total = Number(progress.total) || 0;
  if (total > 0) return Math.min(1, processed / total);
  if (processed <= 0) return 0;
  return Math.min(0.96, processed / (processed + 220));
}

function estimatedSyncProgressPercent(progress: SyncProgress) {
  const phase = String(progress.phase || "scan");
  const range = SYNC_PHASE_RANGES[phase] || { start: 8, end: 92 };
  if (phase === "done") return 100;
  return clampPercent(range.start + (range.end - range.start) * progressRatio(progress));
}

export function nextSyncProgressPercent(
  progress: SyncProgress,
  previous: SyncProgressPercentState | null = null,
): SyncProgressPercentState {
  const estimated = estimatedSyncProgressPercent(progress);
  const previousPercent = previous?.runId === progress.runId ? previous.percent : 0;
  return {
    runId: progress.runId,
    percent: progress.phase === "done" ? 100 : Math.max(previousPercent, estimated),
  };
}

export function cardTextForProfile(profile: DisplayProfile, language: Language = DEFAULT_LANGUAGE) {
  if (profile.configMode === "chatgpt") {
    return {
      title: profile.title,
      remark: translate(language, "chatgptRawConfig"),
      statusLabel: profile.isActive ? translate(language, "applied") : translate(language, "notEnabled"),
      statusTone: profile.isActive ? "applied" : "idle",
      primaryAction: translate(language, "apply"),
      secondaryAction: translate(language, "edit"),
      canApply: true,
    } as const;
  }

  const modelName = displayModel(profile);
  return {
    title: profile.title,
    remark: `${profile.source === "official" ? translate(language, "officialConfig") : translate(language, "customConfig")} · ${modelName}`,
    statusLabel: profile.isActive ? translate(language, "applied") : translate(language, "notEnabled"),
    statusTone: profile.isActive ? "applied" : "idle",
    primaryAction: translate(language, "apply"),
    secondaryAction: translate(language, "edit"),
    canApply: true,
  } as const;
}

export function syncSuccessMessage(summary?: SyncSummary, language: Language = DEFAULT_LANGUAGE) {
  if (!summary || summary.skipped) return translate(language, "syncSuccess", { count: 0 });
  const changed =
    summary.normalizedRows +
    summary.dedupedRows +
    summary.staleRowsRemoved +
    summary.orphanStateRefsRemoved +
    summary.rolloutPathsRepaired +
    summary.rolloutMetaUpdated +
    (summary.indexChanged ? 1 : 0) +
    (summary.pinnedChanged ? 1 : 0);
  return translate(language, "syncSuccess", { count: changed });
}

export function syncProgressMessage(progress: SyncProgress, language: Language = DEFAULT_LANGUAGE) {
  switch (progress.message) {
    case "准备同步消息":
      return translate(language, "syncProgressPreparing");
    case "扫描 ChatGPT 线程数据库":
      return translate(language, "syncProgressScanDb");
    case "同步消息文件元数据":
      return translate(language, "syncProgressRollout");
    case "扫描线程记录":
      return translate(language, "syncProgressScanRows");
    default:
      return progress.message;
  }
}
