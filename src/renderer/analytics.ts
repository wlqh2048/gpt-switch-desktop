export type AnalyticsValue = string | number | boolean;
export type AnalyticsData = Record<string, AnalyticsValue | null | undefined>;

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "authjson",
  "auth_json",
  "configtoml",
  "config_toml",
  "codexdir",
  "codex_dir",
  "localpath",
  "local_path",
  "note",
  "profiletitle",
  "profile_title",
  "storedir",
  "store_dir",
  "title",
]);

declare global {
  interface Window {
    [key: string]: unknown;
  }
}

function normalizeKey(key: string) {
  return key.replace(/[-_\s]/g, "").toLowerCase();
}

export function sanitizeAnalyticsData(data: AnalyticsData = {}) {
  return Object.entries(data).reduce<Record<string, AnalyticsValue>>(
    (result, [key, value]) => {
      if (value === undefined || value === null || value === "") return result;
      if (SENSITIVE_KEYS.has(normalizeKey(key))) return result;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        result[key] = value;
      }
      return result;
    },
    {},
  );
}

function desktopOsFromUserAgent(userAgent: string) {
  const source = String(userAgent || "").toLowerCase();
  if (source.includes("windows") || source.includes("win32") || source.includes("win64")) {
    return "windows";
  }
  if (source.includes("macintosh") || source.includes("mac os x") || source.includes("macintel")) {
    return "macos";
  }
  if (source.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

export function desktopAnalyticsContext({
  appVersion,
  language,
  theme,
  userAgent,
}: {
  appVersion: string;
  language: string;
  theme: string;
  userAgent: string;
}) {
  return sanitizeAnalyticsData({
    surface: "desktop",
    app_version: appVersion,
    language,
    theme,
    os: desktopOsFromUserAgent(userAgent),
  });
}

export function formatAnalyticsEventName(
  surface: "web" | "desktop",
  eventName: string,
  trigger = "onClick",
) {
  return `${surface}_${eventName}(${trigger})`;
}

export function trackAnalyticsEvent(eventName: string, data: AnalyticsData = {}) {
  if (typeof window === "undefined") return;
  const tracker = window[["u", "m", "a", "m", "i"].join("")];
  const track =
    typeof tracker === "object" && tracker !== null && "track" in tracker
      ? tracker.track
      : null;
  if (typeof track !== "function") return;
  try {
    void track(eventName, sanitizeAnalyticsData(data));
  } catch (_error) {
    // Analytics must never interrupt the desktop workflow.
  }
}
