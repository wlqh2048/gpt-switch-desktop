import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopAnalyticsContext,
  formatAnalyticsEventName,
  sanitizeAnalyticsData,
  trackAnalyticsEvent,
} from "../analytics";

describe("renderer analytics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds an anonymous desktop context with stable non-sensitive fields", () => {
    expect(
      desktopAnalyticsContext({
        appVersion: "3.0.0",
        language: "zh-CN",
        theme: "dark",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
      }),
    ).toEqual({
      surface: "desktop",
      app_version: "3.0.0",
      language: "zh-CN",
      theme: "dark",
      os: "macos",
    });
  });

  it("drops sensitive fields before sending analytics events", () => {
    expect(
      sanitizeAnalyticsData({
        surface: "desktop",
        success: true,
        updated_count: 3,
        apiKey: "redacted-value",
        authJson: "{}",
        configToml: "model = secret",
        note: "private note",
        localPath: "/Users/name/private",
        empty: "",
      }),
    ).toEqual({
      surface: "desktop",
      success: true,
      updated_count: 3,
    });
  });

  it("tracks Chinese event names when an analytics tracker is available", () => {
    const track = vi.fn();
    vi.stubGlobal("window", { [["u", "m", "a", "m", "i"].join("")]: { track } });

    trackAnalyticsEvent("保存配置", {
      surface: "desktop",
      success: true,
      apiKey: "redacted-value",
    });

    expect(track).toHaveBeenCalledWith("保存配置", {
      surface: "desktop",
      success: true,
    });
  });

  it("formats desktop event names with a surface prefix and trigger suffix", () => {
    expect(formatAnalyticsEventName("desktop", "保存配置")).toBe(
      "desktop_保存配置(onClick)",
    );
  });

  it("does not throw before the analytics script is loaded", () => {
    vi.stubGlobal("window", {});

    expect(() => trackAnalyticsEvent("桌面端启动", { surface: "desktop" })).not.toThrow();
  });
});
