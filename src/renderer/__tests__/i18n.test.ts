import { describe, expect, it } from "vitest";
import {
  cardTextForProfile,
  syncSuccessMessage,
  syncProgressMessage,
  updateNoticeForVersions,
} from "../uiModel";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  createTranslator,
  isLanguage,
} from "../i18n";
import { DisplayProfile, SyncSummary } from "../../shared/types";

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

function syncSummary(): SyncSummary {
  return {
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
}

describe("renderer i18n", () => {
  it("keeps Chinese as the default language and persists under one stable key", () => {
    expect(DEFAULT_LANGUAGE).toBe("zh-CN");
    expect(LANGUAGE_STORAGE_KEY).toBe("ai-switch-language");
    expect(isLanguage("zh-CN")).toBe(true);
    expect(isLanguage("en-US")).toBe(true);
    expect(isLanguage("ja-JP")).toBe(false);
  });

  it("translates common UI labels in Chinese and English", () => {
    const zh = createTranslator("zh-CN");
    const en = createTranslator("en-US");

    expect(zh("createConfig")).toBe("新增配置");
    expect(en("createConfig")).toBe("New Config");
    expect(zh("alreadyLatest")).toBe("已是最新版本");
    expect(en("alreadyLatest")).toBe("Already up to date");
    expect(zh("apiKeyMissingToast")).toBe("请先填写 API Key 后再应用");
    expect(en("apiKeyMissingToast")).toBe("Add an API key before applying");
    expect(zh("resetTooltip")).toBe("初始化 ChatGPT 账号配置");
    expect(en("resetTooltip")).toBe("Initialize ChatGPT account config");
    expect(zh("resetTitle")).toBe("初始化 ChatGPT 账号配置？");
    expect(en("resetTitle")).toBe("Initialize ChatGPT account config?");
    expect(zh("resetContent")).toBe("初始化 ChatGPT 账号配置，可自行登陆官方账号。已保存的配置不会删除。");
    expect(en("resetContent")).toBe("Initialize the ChatGPT account config so you can sign in with the official account. Saved configs will not be deleted.");
    expect(zh("resetConfirm")).toBe("确认初始化");
    expect(en("resetConfirm")).toBe("Initialize");
    expect(zh("syncSuccess", { count: 18 })).toBe("同步成功，更新 18 条配置");
    expect(en("syncSuccess", { count: 18 })).toBe("Sync complete, updated 18 items");
  });

  it("localizes profile cards and update reminders", () => {
    expect(cardTextForProfile(profile({ isActive: true }), "en-US")).toMatchObject({
      remark: "Official config · Fixture Pro",
      statusLabel: "Applied",
      primaryAction: "Apply",
      secondaryAction: "Edit",
    });
    expect(cardTextForProfile(profile({ source: "custom", locked: false }), "en-US").remark).toBe(
      "Custom config · Fixture Pro",
    );
    expect(syncSuccessMessage(syncSummary(), "en-US")).toBe("Sync complete, updated 18 items");
    expect(updateNoticeForVersions("0.1.0", "0.1.1", "en-US")?.label).toBe(
      "Update available v0.1.1",
    );
  });

  it("localizes known sync progress phases from the main process", () => {
    expect(syncProgressMessage({ runId: "run-1", phase: "scan", processed: 0, message: "扫描 ChatGPT 线程数据库" }, "en-US")).toBe(
      "Scanning ChatGPT thread database",
    );
    expect(syncProgressMessage({ runId: "run-1", phase: "rollout", processed: 1, message: "同步消息文件元数据" }, "en-US")).toBe(
      "Syncing message file metadata",
    );
  });
});
