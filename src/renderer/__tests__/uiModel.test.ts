import { describe, expect, it } from "vitest";
import {
  cardTextForProfile,
  applyUpdateBlockForVersions,
  clientDownloadPlatformForUserAgent,
  initialSyncProgress,
  nextSyncProgressPercent,
  officialApiKeyStorageKey,
  profilesWithLocalOfficialKeys,
  readOfficialApiKey,
  shellClassNameForUserAgent,
  storeOfficialApiKey,
  syncSuccessMessage,
  updateNoticeForVersions,
} from "../uiModel";
import { DisplayProfile, SyncProgress, SyncSummary } from "../../shared/types";

function profile(overrides: Partial<DisplayProfile> = {}): DisplayProfile {
  return {
    id: "fixture-official",
    source: "official",
    configMode: "official",
    title: "Fixture Provider",
    description: "官方配置",
    locked: true,
    providerId: "fixture-provider",
    providerName: "Fixture Provider",
    baseUrl: "https://provider.invalid/",
    wireApi: "responses",
    model: "fixture-pro",
    models: [{ slug: "fixture-pro", display_name: "Fixture Pro" }],
    keyUrl: "https://provider.invalid/api_keys",
    apiKeyState: "saved",
    isActive: false,
    updatedAt: "2026-08-25T00:00:00.000Z",
    ownedFiles: ["config.toml", "models.json"],
    ...overrides,
  };
}

function progress(overrides: Partial<SyncProgress> = {}): SyncProgress {
  return {
    runId: "run-1",
    phase: "scan",
    processed: 0,
    message: "同步消息",
    ...overrides,
  };
}

describe("uiModel", () => {
  it("keeps card actions simple and direct", () => {
    expect(cardTextForProfile(profile({ isActive: true })).statusLabel).toBe("已应用");
    expect(cardTextForProfile(profile({ isActive: true })).primaryAction).toBe("应用");
    expect(cardTextForProfile(profile({ apiKeyState: "missing" })).canApply).toBe(true);
    expect(cardTextForProfile(profile({ source: "custom", locked: false })).remark).toBe(
      "自定义配置 · Fixture Pro",
    );
    expect(cardTextForProfile(profile({ source: "custom", configMode: "chatgpt", locked: false })).remark).toBe(
      "ChatGPT 配置 · 原样文件",
    );
  });

  it("formats sync success feedback from streamed sync summary", () => {
    const summary: SyncSummary = {
      skipped: false,
      sqliteFiles: 2,
      normalizedRows: 10,
      dedupedRows: 3,
      staleRowsRemoved: 0,
      orphanStateRefsRemoved: 0,
      rolloutPathsRepaired: 0,
      rolloutMetaScanned: 30,
      rolloutMetaUpdated: 4,
      legacyRolloutsDetected: 0,
      legacyReasoningRowsRestored: 0,
      threadHistoryProjectionsReset: 0,
      repairBackupsCreated: 0,
      indexChanged: true,
      pinnedChanged: false,
      errors: [],
    };

    expect(syncSuccessMessage(summary)).toBe("同步成功，更新 18 条配置");
  });

  it("keeps sync progress from moving backward inside one run", () => {
    const scan79 = nextSyncProgressPercent(progress({ processed: 79 }), null);
    const scan80 = nextSyncProgressPercent(progress({ processed: 80 }), scan79);
    const rollout1 = nextSyncProgressPercent(progress({ phase: "rollout", processed: 1 }), scan80);

    expect(scan80.percent).toBeGreaterThanOrEqual(scan79.percent);
    expect(rollout1.percent).toBeGreaterThanOrEqual(scan80.percent);
  });

  it("starts a new sync run from its own progress range", () => {
    const previous = nextSyncProgressPercent(progress({ phase: "rollout", processed: 200 }), null);
    const nextRun = nextSyncProgressPercent(progress({ runId: "run-2", processed: 0 }), previous);

    expect(previous.percent).toBeGreaterThan(nextRun.percent);
    expect(nextRun.runId).toBe("run-2");
  });

  it("creates an immediate local sync progress entry for apply clicks", () => {
    const initial = initialSyncProgress("apply-fixture");
    const next = nextSyncProgressPercent(initial, null);

    expect(initial).toEqual({
      runId: "apply-fixture",
      phase: "scan",
      processed: 0,
      message: "准备同步消息",
    });
    expect(next.percent).toBeGreaterThan(0);
  });

  it("keeps official api keys in renderer localStorage helpers", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    storeOfficialApiKey("fixture-official", "  local-api-key  ", storage);

    expect(values.get(officialApiKeyStorageKey("fixture-official"))).toBe("local-api-key");
    expect(readOfficialApiKey("fixture-official", storage)).toBe("local-api-key");
    expect(profilesWithLocalOfficialKeys([profile({ apiKeyState: "missing" })], storage)[0].apiKeyState).toBe("saved");
  });

  it("marks Windows and macOS as single overlay titlebar shells", () => {
    expect(shellClassNameForUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "app-shell is-overlay-titlebar is-windows",
    );
    expect(shellClassNameForUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)")).toBe(
      "app-shell is-overlay-titlebar is-mac",
    );
  });

  it("uses backend version only as a newer-version reminder", () => {
    expect(updateNoticeForVersions("0.1.0", "0.1.1")).toEqual({
      latestVersion: "0.1.1",
      label: "可更新 v0.1.1",
    });
    expect(updateNoticeForVersions("0.1.1", "0.1.1")).toBeNull();
    expect(updateNoticeForVersions("0.2.0", "0.1.9")).toBeNull();
    expect(updateNoticeForVersions("", "0.1.1")).toBeNull();
    expect(updateNoticeForVersions("0.1.0", "")).toBeNull();
  });

  it("detects the current desktop platform for dynamic downloads", () => {
    expect(clientDownloadPlatformForUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(clientDownloadPlatformForUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)")).toBe("macos");
    expect(clientDownloadPlatformForUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unknown");
  });

  it("blocks applying profiles when the version manifest reports a newer client version", () => {
    expect(
      applyUpdateBlockForVersions(
        "0.1.0",
        "0.2.0",
      ),
    ).toEqual({
      latestVersion: "0.2.0",
      title: "请更新客户端",
      content: "检测到新版本 v0.2.0，请先更新客户端后再应用配置。",
      okText: "立即更新",
      cancelText: "取消",
    });
    expect(applyUpdateBlockForVersions("0.2.0", "0.2.0")).toBeNull();
    expect(applyUpdateBlockForVersions("0.3.0", "0.2.0")).toBeNull();
    expect(applyUpdateBlockForVersions("0.1.0", "0.2.0")?.okText).toBe(
      "立即更新",
    );
  });

});
