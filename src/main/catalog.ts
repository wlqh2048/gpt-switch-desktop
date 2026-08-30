import {
  CatalogConfigTemplate,
  CatalogModel,
  CatalogProvider,
  DownloadPlatform,
  ProviderCatalog,
  ServerDownloadInfo,
} from "../shared/types";

type FetchJsonOptions = {
  serverBase: string;
  fetchImpl?: typeof fetch;
};

type FetchProviderCatalogOptions = FetchJsonOptions & {
  storeDir?: string;
};

type FetchLatestDownloadOptions = FetchJsonOptions & {
  platform: DownloadPlatform;
};

export type ServerVersionInfo = {
  version: string;
};

export function emptyProviderCatalog(): ProviderCatalog {
  return {
    version: 1,
    updated_at: new Date(0).toISOString(),
    providers: [],
  };
}

function normalizeServerBase(serverBase: string) {
  return String(serverBase || "").trim().replace(/\/+$/, "");
}

function assertString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function assertHttpUrl(value: unknown, field: string) {
  const raw = assertString(value, field);
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must be http or https`);
  }
  return raw;
}

function normalizeModel(rawModel: unknown, providerId: string): CatalogModel {
  if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
    throw new Error(`${providerId}.model must be an object`);
  }
  const model = rawModel as Record<string, unknown>;
  const slug = assertString(model.slug, `${providerId}.models.slug`);
  return {
    ...model,
    slug,
    display_name: String(model.display_name || slug).trim(),
  } as CatalogModel;
}

function normalizeConfigTemplate(
  rawTemplate: unknown,
  providerId: string,
): CatalogConfigTemplate | undefined {
  if (!rawTemplate) return undefined;
  if (typeof rawTemplate !== "object" || Array.isArray(rawTemplate)) {
    throw new Error(`${providerId}.config_template must be an object`);
  }
  const template = rawTemplate as Record<string, unknown>;
  const configToml = assertString(
    template.config_toml,
    `${providerId}.config_template.config_toml`,
  );
  const modelsJson = template.models_json;
  if (
    !modelsJson ||
    typeof modelsJson !== "object" ||
    Array.isArray(modelsJson)
  ) {
    throw new Error(
      `${providerId}.config_template.models_json must be an object`,
    );
  }
  const models = (modelsJson as Record<string, unknown>).models;
  if (!Array.isArray(models) || !models.length) {
    throw new Error(
      `${providerId}.config_template.models_json.models must not be empty`,
    );
  }
  return {
    config_toml: configToml,
    models_json: {
      ...(modelsJson as Record<string, unknown>),
      models: models.map((model) => normalizeModel(model, providerId)),
    },
  };
}

function normalizeProvider(rawProvider: unknown): CatalogProvider {
  if (
    !rawProvider ||
    typeof rawProvider !== "object" ||
    Array.isArray(rawProvider)
  ) {
    throw new Error("provider must be an object");
  }
  const provider = rawProvider as Record<string, unknown>;
  const id = assertString(provider.id, "provider.id");
  const configTemplate = normalizeConfigTemplate(provider.config_template, id);
  const locked = Boolean(provider.locked);
  if (locked && !configTemplate) {
    throw new Error("locked provider must include config_template");
  }
  const modelSource = Array.isArray(provider.models)
    ? provider.models
    : configTemplate?.models_json.models;
  const models = Array.isArray(modelSource)
    ? modelSource.map((model) => normalizeModel(model, id))
    : [];
  if (!models.length) throw new Error(`${id}.models must not be empty`);
  const defaultModel = assertString(
    provider.default_model,
    `${id}.default_model`,
  );
  if (!models.some((model) => model.slug === defaultModel)) {
    throw new Error(`${id}.default_model must exist in models`);
  }
  const editableFields = Array.isArray(provider.editable_fields)
    ? provider.editable_fields
        .map((field) => String(field || "").trim())
        .filter(Boolean)
    : [];
  if (
    provider.locked &&
    editableFields.some((field) => !["apiKey", "model"].includes(field))
  ) {
    throw new Error("locked provider can only expose apiKey and model");
  }
  const auth = provider.auth as Record<string, unknown>;
  if (
    auth?.type !== "bearer_token" ||
    auth?.config_key !== "experimental_bearer_token"
  ) {
    throw new Error(`${id}.auth must use experimental_bearer_token`);
  }
  return {
    id,
    title: assertString(provider.title, `${id}.title`),
    description: String(provider.description || ""),
    locked,
    provider_id: assertString(provider.provider_id, `${id}.provider_id`),
    provider_name: String(provider.provider_name || provider.title || id),
    base_url: assertHttpUrl(provider.base_url, `${id}.base_url`),
    wire_api: "responses",
    auth: {
      type: "bearer_token",
      config_key: "experimental_bearer_token",
    },
    default_model: defaultModel,
    models,
    config_template: configTemplate,
    key_url: provider.key_url
      ? assertHttpUrl(provider.key_url, `${id}.key_url`)
      : "",
    editable_fields: editableFields,
  };
}

export function validateProviderCatalog(rawCatalog: unknown): ProviderCatalog {
  if (
    !rawCatalog ||
    typeof rawCatalog !== "object" ||
    Array.isArray(rawCatalog)
  ) {
    throw new Error("catalog must be an object");
  }
  const catalog = rawCatalog as Record<string, unknown>;
  const version = Number(catalog.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("catalog.version must be a positive integer");
  }
  if (!Array.isArray(catalog.providers) || !catalog.providers.length) {
    throw new Error("catalog.providers must not be empty");
  }
  const providers = catalog.providers.map(normalizeProvider);
  return {
    version,
    updated_at: String(catalog.updated_at || new Date(0).toISOString()),
    providers,
  };
}

export async function fetchProviderCatalog({
  serverBase,
  fetchImpl = fetch,
}: FetchProviderCatalogOptions): Promise<ProviderCatalog> {
  const normalizedServerBase = normalizeServerBase(serverBase);
  if (!normalizedServerBase) return emptyProviderCatalog();
  const endpoint = new URL("/api/catalog/v1/providers", normalizedServerBase);
  try {
    const response = await fetchImpl(endpoint);
    if (!response.ok) {
      throw new Error(`catalog http ${response.status}`);
    }
    const body = (await response.json()) as { catalog?: unknown };
    return validateProviderCatalog(body.catalog);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`服务器异常：（${detail}）`);
  }
}

export async function fetchServerVersion({
  serverBase,
  fetchImpl = fetch,
}: FetchJsonOptions): Promise<ServerVersionInfo> {
  const normalizedServerBase = normalizeServerBase(serverBase);
  if (!normalizedServerBase) return { version: "" };
  const endpoint = new URL("/api/catalog/v1/version", normalizedServerBase);
  try {
    const response = await fetchImpl(endpoint);
    if (!response.ok) {
      throw new Error(`version http ${response.status}`);
    }
    const body = (await response.json()) as { version?: unknown };
    return {
      version: assertString(body.version, "server.version"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`服务器异常：（${detail}）`);
  }
}

function assertDownloadPlatform(value: unknown, field: string): DownloadPlatform {
  const platform = assertString(value, field);
  if (platform !== "windows" && platform !== "macos") {
    throw new Error(`${field} must be windows or macos`);
  }
  return platform;
}

function assertPositiveInteger(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return number;
}

export async function fetchLatestDownload({
  serverBase,
  platform,
  fetchImpl = fetch,
}: FetchLatestDownloadOptions): Promise<ServerDownloadInfo> {
  const normalizedServerBase = normalizeServerBase(serverBase);
  if (!normalizedServerBase) {
    throw new Error("download service is not configured");
  }
  const endpoint = new URL("/api/downloads/v1/latest", normalizedServerBase);
  endpoint.searchParams.set("platform", platform);
  try {
    const response = await fetchImpl(endpoint);
    if (!response.ok) {
      throw new Error(`download http ${response.status}`);
    }
    const body = (await response.json()) as {
      success?: boolean;
      platform?: unknown;
      version?: unknown;
      name?: unknown;
      url?: unknown;
      expires_in?: unknown;
      expiresIn?: unknown;
      error?: { message?: string };
    };
    if (body.success === false) {
      throw new Error(body.error?.message || "download failed");
    }
    return {
      platform: assertDownloadPlatform(body.platform, "download.platform"),
      version: assertString(body.version, "download.version"),
      name: assertString(body.name, "download.name"),
      url: assertHttpUrl(body.url, "download.url"),
      expiresIn: assertPositiveInteger(body.expires_in ?? body.expiresIn, "download.expires_in"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`服务器异常：（${detail}）`);
  }
}

export async function loadProviderCatalogForDisplay(
  options: FetchProviderCatalogOptions,
): Promise<{ catalog: ProviderCatalog; catalogError?: string }> {
  try {
    return { catalog: await fetchProviderCatalog(options) };
  } catch (error) {
    return {
      catalog: emptyProviderCatalog(),
      catalogError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadServerVersionForDisplay(
  options: FetchJsonOptions,
): Promise<{
  serverVersion: string;
  serverVersionError?: string;
}> {
  try {
    const result = await fetchServerVersion(options);
    return {
      serverVersion: result.version,
    };
  } catch (error) {
    return {
      serverVersion: "",
      serverVersionError: error instanceof Error ? error.message : String(error),
    };
  }
}
