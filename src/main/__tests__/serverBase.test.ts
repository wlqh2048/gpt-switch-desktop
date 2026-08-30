import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveServerBase } from "../serverBase";

describe("resolveServerBase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not fall back to a hardcoded server when env is empty", () => {
    vi.stubEnv("SERVER_BASE", "");
    vi.stubEnv("GPT_SWITCH_SERVER_BASE", "");

    expect(resolveServerBase()).toBe("");
    expect(resolveServerBase("")).toBe("");
  });

  it("allows production deployments to override the catalog service", () => {
    expect(resolveServerBase("https://catalog.example.com/")).toBe(
      "https://catalog.example.com",
    );
  });

  it("uses the packaged build config when runtime env is empty", () => {
    expect(resolveServerBase("", "https://catalog.example.com/")).toBe(
      "https://catalog.example.com",
    );
  });

  it("prefers runtime env over the packaged build config", () => {
    expect(
      resolveServerBase(
        "https://runtime.example.com/",
        "https://packaged.example.com/",
      ),
    ).toBe("https://runtime.example.com");
  });

  it("uses the single public GPT Switch server env var", () => {
    vi.stubEnv("SERVER_BASE", "https://legacy.example.com");
    vi.stubEnv("GPT_SWITCH_SERVER_BASE", "https://catalog.example.com/");

    expect(resolveServerBase()).toBe("https://catalog.example.com");
  });

  it("does not read the legacy generic server base name", () => {
    vi.stubEnv("SERVER_BASE", "https://legacy.example.com");
    vi.stubEnv("GPT_SWITCH_SERVER_BASE", "");

    expect(resolveServerBase()).toBe("");
  });
});
