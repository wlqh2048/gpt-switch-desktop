import path from "node:path";
import { CatalogModel, ResolvedProfile } from "../shared/types";
import { toTomlPath } from "./fsUtils";

function tomlString(value: string) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeBaseUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function withTrailingNewline(value: string) {
  const text = String(value || "");
  return text.endsWith("\n") ? text : `${text}\n`;
}

export const LEGACY_CUSTOM_PROVIDER_ID = "openai-custom";

function parseProviderIdFromHeader(line: string) {
  const match = line
    .trim()
    .match(/^\[model_providers\.((?:"(?:\\.|[^"\\])*")|[A-Za-z0-9_.-]+)\]\s*$/);
  if (!match) return "";
  const raw = match[1];
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return "";
    }
  }
  return raw;
}

function uniqueProviderIds(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const providerId = String(value || "").trim();
    if (!providerId || seen.has(providerId)) continue;
    seen.add(providerId);
    out.push(providerId);
  }
  return out;
}

function renderProviderBlock({
  providerId,
  providerName,
  baseUrl,
  apiKey,
}: {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
}) {
  return [
    `[model_providers.${providerId}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(normalizeBaseUrl(baseUrl))}`,
    'wire_api = "responses"',
    `experimental_bearer_token = ${tomlString(apiKey)}`,
  ].join("\n");
}

function renderTemplate(template: string, values: Record<string, string>) {
  return String(template || "").replace(/\{\{\s*(model|apiKey|providerId|baseUrl)\s*\}\}/g, (_match, key: string) => {
    return values[key] || "";
  });
}

function extractProviderIds(configToml: string) {
  const ids: string[] = [];
  for (const line of String(configToml || "").split(/\r?\n/)) {
    const providerId = parseProviderIdFromHeader(line);
    if (providerId) ids.push(providerId);
  }
  return ids;
}

export function extractHistoricalProviderBlocks(configToml: string, renderedProviderIds: string | string[]) {
  const lines = String(configToml || "").split(/\r?\n/);
  const blocks: string[] = [];
  const skipped = Array.isArray(renderedProviderIds) ? renderedProviderIds : [renderedProviderIds];
  const seen = new Set(skipped.map((value) => String(value || "").trim()).filter(Boolean));
  let index = 0;
  while (index < lines.length) {
    const providerId = parseProviderIdFromHeader(lines[index]);
    if (!providerId) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < lines.length && !lines[index].trim().startsWith("[")) {
      index += 1;
    }
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    const block = lines.slice(start, index).join("\n").trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

function renderModelCatalog(models: CatalogModel[]) {
  return {
    models: models.map((model, index) => ({
      prefer_websockets: false,
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      input_modalities: model.input_modalities || ["text"],
      supports_image_detail_original: false,
      truncation_policy: {
        mode: "tokens",
        limit: 10000,
      },
      supports_parallel_tool_calls: true,
      tool_mode: null,
      multi_agent_version: "v2",
      use_responses_lite: false,
      include_skills_usage_instructions: false,
      context_window: model.context_window || 1048576,
      max_context_window: model.context_window || 1048576,
      effective_context_window_percent: 95,
      reasoning_summary_format: "experimental",
      default_reasoning_summary: "none",
      description: model.description || "Responses-compatible coding model.",
      default_reasoning_level: model.default_reasoning_level || "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "high", description: "Extra reasoning depth for complex tasks" },
        { effort: "max", description: "Maximum reasoning depth" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      availability_nux: null,
      upgrade: null,
      priority: index + 1,
      ...model,
    })),
  };
}

export function renderCodexFiles({
  profile,
  codexDir,
}: {
  profile: ResolvedProfile;
  codexDir: string;
  existingConfigToml?: string;
  providerAliases?: string[];
}) {
  if (profile.configMode === "chatgpt") {
    return {
      configToml: withTrailingNewline(profile.rawConfig?.configToml || ""),
      modelsJson: null as string | null,
      authJson: withTrailingNewline(profile.rawConfig?.authJson || ""),
      ownedFiles: profile.ownedFiles,
    };
  }

  const modelsPath = toTomlPath(path.join(codexDir, "models.json"));
  const providerName = profile.providerName || profile.title;
  const providerId = profile.providerId;
  const templateConfigToml = profile.configTemplate?.config_toml
    ? renderTemplate(profile.configTemplate.config_toml, {
        model: profile.model,
        apiKey: profile.apiKey,
        providerId: profile.providerId,
        baseUrl: profile.baseUrl,
      }).trim()
    : "";
  const primaryConfigToml =
    templateConfigToml ||
    [
      `model = ${tomlString(profile.model)}`,
      `model_provider = ${tomlString(providerId)}`,
      'preferred_auth_method = "apikey"',
      'forced_login_method = "api"',
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${tomlString(modelsPath)}`,
      "disable_response_storage = false",
      "",
      "[history]",
      "persistence = \"save-all\"",
      "",
      renderProviderBlock({
        providerId,
        providerName,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
      }),
    ].join("\n");

  return {
    configToml: withTrailingNewline(primaryConfigToml),
    modelsJson: `${JSON.stringify(profile.configTemplate?.models_json || renderModelCatalog(profile.models), null, 2)}\n`,
    authJson: null as string | null,
    ownedFiles: profile.ownedFiles,
  };
}
