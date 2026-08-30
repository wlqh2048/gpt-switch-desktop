import { describe, expect, it } from "vitest";
import { renderCodexFiles } from "../renderConfig";
import { testCatalog } from "./fixtures/catalog";

describe("renderCodexFiles", () => {
  it("renders official fallback responses config with model catalog and bearer token", () => {
    const provider = testCatalog.providers[0];
    const rendered = renderCodexFiles({
      profile: {
        id: provider.id,
        source: "official",
        configMode: "official",
        title: provider.title,
        providerId: provider.provider_id,
        baseUrl: provider.base_url,
        wireApi: provider.wire_api,
        model: "fixture-fast",
        apiKey: "test-api-key",
        auth: provider.auth,
        models: provider.models,
        ownedFiles: ["config.toml", "models.json"],
      },
      codexDir: "/Users/test/.codex",
    });

    expect(rendered.configToml).toContain('model = "fixture-fast"');
    expect(rendered.configToml).toContain('model_provider = "fixture-provider"');
    expect(rendered.configToml).toContain('model_catalog_json = "/Users/test/.codex/models.json"');
    expect(rendered.configToml).toContain('wire_api = "responses"');
    expect(rendered.configToml).toContain('experimental_bearer_token = "test-api-key"');
    expect(rendered.authJson).toBeNull();
    expect(JSON.parse(rendered.modelsJson!).models.map((model: { slug: string }) => model.slug)).toContain(
      "fixture-fast",
    );
  });

  it("does not append compatibility provider aliases to server templates", () => {
    const provider = testCatalog.providers[0];
    const rendered = renderCodexFiles({
      profile: {
        id: provider.id,
        source: "official",
        configMode: "official",
        title: provider.title,
        providerId: provider.provider_id,
        baseUrl: provider.base_url,
        wireApi: provider.wire_api,
        model: "fixture-fast",
        apiKey: "test-api-key",
        auth: provider.auth,
        models: provider.models,
        ownedFiles: ["config.toml", "models.json"],
      },
      codexDir: "/Users/test/.codex",
    });

    expect(rendered.configToml).toContain("[model_providers.fixture-provider]");
    expect(rendered.configToml).not.toContain("[model_providers.openai-custom]");
  });

  it("uses server-delivered config and models templates for official profiles", () => {
    const provider = testCatalog.providers[0];
    const rendered = renderCodexFiles({
      profile: {
        id: provider.id,
        source: "official",
        configMode: "official",
        title: provider.title,
        providerId: provider.provider_id,
        baseUrl: provider.base_url,
        wireApi: provider.wire_api,
        model: "fixture-fast",
        apiKey: "api-key-from-localstorage",
        auth: provider.auth,
        models: provider.models,
        configTemplate: {
          config_toml: [
            "template.model={{model}}",
            "template.provider={{providerId}}",
            "template.base={{baseUrl}}",
            "template.secret={{apiKey}}",
          ].join("\n"),
          models_json: {
            models: [
              {
                slug: "fixture-fast",
                display_name: "Fixture-Fast",
                model_messages: { base_instructions: "from-server" },
              },
            ],
          },
        },
        ownedFiles: ["config.toml", "models.json"],
      },
      codexDir: "/Users/test/.codex",
    });

    expect(rendered.configToml).toContain("template.model=fixture-fast");
    expect(rendered.configToml).toContain("template.provider=fixture-provider");
    expect(rendered.configToml).toContain("template.base=https://provider.invalid/");
    expect(rendered.configToml).toContain("template.secret=api-key-from-localstorage");
    expect(rendered.configToml).not.toContain("[model_providers.openai-custom]");
    expect(JSON.parse(rendered.modelsJson!).models[0].model_messages.base_instructions).toBe("from-server");
  });

  it("renders server templates exactly apart from placeholder substitution", () => {
    const provider = testCatalog.providers[0];
    const configTemplate = {
      config_toml: [
        "template.model={{model}}",
        "template.provider={{providerId}}",
        "template.base={{baseUrl}}",
        "template.secret={{apiKey}}",
      ].join("\n"),
      models_json: {
        models: [{ slug: "fixture-fast", display_name: "Fixture Fast" }],
      },
    };
    const rendered = renderCodexFiles({
      profile: {
        id: provider.id,
        source: "official",
        configMode: "official",
        title: provider.title,
        providerId: provider.provider_id,
        baseUrl: provider.base_url,
        wireApi: provider.wire_api,
        model: "fixture-fast",
        apiKey: "exact-api-key",
        auth: provider.auth,
        models: provider.models,
        configTemplate,
        ownedFiles: ["config.toml", "models.json"],
      },
      codexDir: "/Users/test/.codex",
      providerAliases: ["openai-custom", "local-v2"],
      existingConfigToml: [
        "[model_providers.openai-custom]",
        'name = "Custom"',
        'base_url = "https://old.example.com/v1"',
        'wire_api = "responses"',
      ].join("\n"),
    });

    expect(rendered.configToml.trim()).toBe(
      configTemplate.config_toml
        .replaceAll("{{model}}", "fixture-fast")
        .replaceAll("{{apiKey}}", "exact-api-key")
        .replaceAll("{{providerId}}", "fixture-provider")
        .replaceAll("{{baseUrl}}", "https://provider.invalid/")
        .trim(),
    );
  });

  it("renders custom responses config from form fields", () => {
    const rendered = renderCodexFiles({
      profile: {
        id: "custom-1",
        source: "custom",
        configMode: "custom",
        title: "Local One",
        providerId: "local-one",
        baseUrl: "https://models.example.com/v1",
        wireApi: "responses",
        model: "local-model",
        apiKey: "local-api-key",
        auth: { type: "bearer_token", config_key: "experimental_bearer_token" },
        models: [{ slug: "local-model", display_name: "Local Model" }],
        ownedFiles: ["config.toml", "models.json"],
      },
      codexDir: "C:/Users/test/.codex",
    });

    expect(rendered.configToml).toContain('model_provider = "local-one"');
    expect(rendered.configToml).toContain('base_url = "https://models.example.com/v1"');
    expect(rendered.configToml).toContain('model_catalog_json = "C:/Users/test/.codex/models.json"');
    expect(rendered.modelsJson).toContain("local-model");
  });

  it("does not carry old provider blocks into custom profile output", () => {
    const rendered = renderCodexFiles({
      profile: {
        id: "custom-1",
        source: "custom",
        configMode: "custom",
        title: "Local One",
        providerId: "local-one",
        baseUrl: "https://models.example.com/v1",
        wireApi: "responses",
        model: "local-model",
        apiKey: "local-api-key",
        auth: { type: "bearer_token", config_key: "experimental_bearer_token" },
        models: [{ slug: "local-model", display_name: "Local Model" }],
        ownedFiles: ["config.toml", "models.json"],
      },
      codexDir: "/Users/test/.codex",
      providerAliases: ["openai-custom"],
      existingConfigToml: [
        "[model_providers.openai-custom]",
        'name = "Old Custom"',
        'base_url = "https://old.example.com/v1"',
        'wire_api = "responses"',
      ].join("\n"),
    });

    expect(rendered.configToml).toContain("[model_providers.local-one]");
    expect(rendered.configToml).not.toContain("[model_providers.openai-custom]");
    expect(rendered.configToml).not.toContain("https://old.example.com/v1");
    expect(rendered.ownedFiles).toEqual(["config.toml", "models.json"]);
  });

  it("renders ChatGPT raw config without a models catalog", () => {
    const rendered = renderCodexFiles({
      profile: {
        id: "chatgpt-raw",
        source: "custom",
        configMode: "chatgpt",
        title: "ChatGPT 账号",
        providerId: "chatgpt",
        baseUrl: "",
        wireApi: "responses",
        model: "chatgpt",
        apiKey: "",
        auth: { type: "bearer_token", config_key: "experimental_bearer_token" },
        models: [],
        rawConfig: {
          configToml: 'model = "gpt-5"\nmodel_provider = "openai"\n',
          authJson: '{"auth_mode":"chatgpt"}',
        },
        ownedFiles: ["config.toml", "auth.json"],
      },
      codexDir: "/Users/test/.codex",
    });

    expect(rendered.configToml).toBe('model = "gpt-5"\nmodel_provider = "openai"\n');
    expect(rendered.authJson).toBe('{"auth_mode":"chatgpt"}\n');
    expect(rendered.modelsJson).toBeNull();
    expect(rendered.ownedFiles).toEqual(["config.toml", "auth.json"]);
  });
});
