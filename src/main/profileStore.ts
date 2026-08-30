import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ActiveProfileState,
  ApiKeyState,
  CatalogProvider,
  CodexConfigFile,
  CustomProfileInput,
  DisplayProfile,
  ProviderCatalog,
  ResolvedProfile,
} from "../shared/types";
import { ensureDir, readJsonFile, writeJsonFile } from "./fsUtils";

type StoredCustomConfigMode = "custom" | "chatgpt";

interface StoredCustomProfile {
  id: string;
  source: "custom";
  configMode: StoredCustomConfigMode;
  title: string;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  note?: string;
  configToml?: string;
  authJson?: string;
  wireApi: "responses";
  createdAt: string;
  updatedAt: string;
}

const OFFICIAL_OWNED_FILES: CodexConfigFile[] = ["config.toml", "models.json"];
const CUSTOM_OWNED_FILES: CodexConfigFile[] = ["config.toml", "models.json"];
const CHATGPT_OWNED_FILES: CodexConfigFile[] = ["config.toml", "auth.json"];

interface OfficialOverride {
  providerId: string;
  apiKey?: string;
  model: string;
  catalogFingerprint?: string;
  updatedAt: string;
}

function cleanSegment(value: string) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function requireText(value: unknown, label: string) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requireHttpUrl(value: unknown, label: string) {
  const text = requireText(value, label).replace(/\/+$/, "");
  const parsed = new URL(text);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be http or https`);
  }
  return text;
}

function maskState(apiKey: string | undefined): ApiKeyState {
  return String(apiKey || "").trim() ? "saved" : "missing";
}

function optionalText(value: string | undefined) {
  return String(value || "").trim();
}

function configModeOf(profile: { configMode?: StoredCustomConfigMode }): StoredCustomConfigMode {
  return profile.configMode === "chatgpt" ? "chatgpt" : "custom";
}

function requireJsonText(value: unknown, label: string) {
  const text = requireText(value, label);
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return text;
}

function ownedFilesForCustomMode(mode: StoredCustomConfigMode): CodexConfigFile[] {
  return mode === "chatgpt" ? [...CHATGPT_OWNED_FILES] : [...CUSTOM_OWNED_FILES];
}

function readTomlStringField(configToml: string | undefined, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(configToml || "").match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+?)\\s*$`, "m"));
  if (!match) return "";
  const rawValue = match[1].trim().replace(/\s+#.*$/, "");
  if (rawValue.startsWith('"')) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return "";
    }
  }
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }
  return rawValue.split(/\s+/)[0] || "";
}

function rawChatGptIdentity(configToml: string | undefined) {
  return {
    providerId: readTomlStringField(configToml, "model_provider") || "openai",
    model: readTomlStringField(configToml, "model") || "chatgpt",
  };
}

function officialProviderFingerprint(provider: CatalogProvider) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        provider_id: provider.provider_id,
        base_url: provider.base_url,
        wire_api: provider.wire_api,
        default_model: provider.default_model,
        model_slugs: provider.models.map((model) => model.slug),
        config_template: provider.config_template,
      }),
    )
    .digest("hex");
}

function currentOfficialOverride(provider: CatalogProvider, override: OfficialOverride | null) {
  if (!override) return null;
  return override.catalogFingerprint === officialProviderFingerprint(provider) ? override : null;
}

export class ProfileStore {
  private storeDir: string;
  private now: () => Date;

  constructor({ storeDir, now = () => new Date() }: { storeDir: string; now?: () => Date }) {
    this.storeDir = storeDir;
    this.now = now;
  }

  getStoreDir() {
    return this.storeDir;
  }

  getProfilesDir() {
    return path.join(this.storeDir, "profiles");
  }

  getOfficialOverridesDir() {
    return path.join(this.storeDir, "official-overrides");
  }

  getSnapshotsDir() {
    return path.join(this.storeDir, "snapshots");
  }

  ensure() {
    ensureDir(this.getProfilesDir());
    ensureDir(this.getOfficialOverridesDir());
    ensureDir(this.getSnapshotsDir());
  }

  private activePath() {
    return path.join(this.storeDir, "active.json");
  }

  private customPath(id: string) {
    return path.join(this.getProfilesDir(), `${cleanSegment(id)}.json`);
  }

  private officialOverridePath(providerId: string) {
    return path.join(this.getOfficialOverridesDir(), `${cleanSegment(providerId)}.json`);
  }

  private readOfficialOverride(providerId: string): OfficialOverride | null {
    return readJsonFile<OfficialOverride>(this.officialOverridePath(providerId));
  }

  private findOfficial(catalog: ProviderCatalog, id: string): CatalogProvider | null {
    return catalog.providers.find((provider) => provider.id === id) || null;
  }

  private readCustomProfiles(): StoredCustomProfile[] {
    this.ensure();
    return fs
      .readdirSync(this.getProfilesDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJsonFile<StoredCustomProfile>(path.join(this.getProfilesDir(), entry.name)))
      .filter((profile): profile is StoredCustomProfile => Boolean(profile?.id));
  }

  listProfiles(catalog: ProviderCatalog): DisplayProfile[] {
    this.ensure();
    const active = this.readActive();
    const officialProfiles = catalog.providers.map((provider) => {
      const storedOverride = this.readOfficialOverride(provider.id);
      const override = currentOfficialOverride(provider, storedOverride);
      const model = override?.model || provider.default_model;
      return {
        id: provider.id,
        source: "official" as const,
        configMode: "official" as const,
        title: provider.title,
        description: provider.description || "官方配置",
        locked: Boolean(provider.locked),
        providerId: provider.provider_id,
        providerName: provider.provider_name || provider.title,
        baseUrl: provider.base_url,
        wireApi: provider.wire_api,
        model,
        models: provider.models,
        keyUrl: provider.key_url,
        apiKeyState: maskState(override?.apiKey),
        isActive: active?.id === provider.id,
        updatedAt: override?.updatedAt || catalog.updated_at,
        ownedFiles: [...OFFICIAL_OWNED_FILES],
      };
    });
    const customProfiles = this.readCustomProfiles()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((profile) => {
        const configMode: StoredCustomConfigMode = configModeOf(profile);
        const isChatGpt = configMode === "chatgpt";
        const rawIdentity = isChatGpt ? rawChatGptIdentity(profile.configToml) : null;
        const model = rawIdentity?.model || profile.model;
        const providerId = rawIdentity?.providerId || profile.providerId;
        return {
          id: profile.id,
          source: "custom" as const,
          configMode,
          title: profile.title,
          description: optionalText(profile.note) || (isChatGpt ? "ChatGPT 配置" : `${profile.baseUrl} · ${profile.model}`),
          locked: false,
          providerId,
          providerName: isChatGpt ? "ChatGPT" : providerId,
          baseUrl: isChatGpt ? "" : profile.baseUrl,
          wireApi: profile.wireApi,
          model,
          models: [{ slug: model, display_name: isChatGpt ? "ChatGPT 配置" : model }],
          keyUrl: "",
          apiKeyState: isChatGpt ? "saved" as const : maskState(profile.apiKey),
          isActive: active?.id === profile.id,
          updatedAt: profile.updatedAt,
          ownedFiles: ownedFilesForCustomMode(configMode),
          rawConfig: isChatGpt
            ? {
                configToml: profile.configToml || "",
                authJson: profile.authJson || "",
              }
            : undefined,
        };
      });
    return [...officialProfiles, ...customProfiles];
  }

  saveOfficialOverride(
    catalog: ProviderCatalog,
    payload: { providerId: string; apiKey?: string; model: string },
  ): OfficialOverride {
    this.ensure();
    const provider = this.findOfficial(catalog, payload.providerId);
    if (!provider) throw new Error("official provider not found");
    const model = requireText(payload.model || provider.default_model, "model");
    if (!provider.models.some((item) => item.slug === model)) {
      throw new Error("model is not allowed for this official provider");
    }
    const override = {
      providerId: provider.id,
      model,
      catalogFingerprint: officialProviderFingerprint(provider),
      updatedAt: this.now().toISOString(),
    };
    writeJsonFile(this.officialOverridePath(provider.id), override);
    return override;
  }

  createCustomProfile(payload: CustomProfileInput): StoredCustomProfile {
    this.ensure();
    const now = this.now().toISOString();
    const configMode: StoredCustomConfigMode = payload.configMode === "chatgpt" ? "chatgpt" : "custom";
    const title = requireText(payload.title, "title");
    const configToml = configMode === "chatgpt" ? requireText(payload.configToml, "configToml") : "";
    const rawIdentity = configMode === "chatgpt" ? rawChatGptIdentity(configToml) : null;
    const profile =
      configMode === "chatgpt"
        ? {
            id: `custom-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            source: "custom" as const,
            configMode,
            title,
            providerId: rawIdentity?.providerId || "chatgpt",
            baseUrl: "",
            model: rawIdentity?.model || "chatgpt",
            apiKey: "",
            configToml,
            authJson: requireJsonText(payload.authJson, "authJson"),
            note: optionalText(payload.note),
            wireApi: "responses" as const,
            createdAt: now,
            updatedAt: now,
          }
        : {
            id: `custom-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            source: "custom" as const,
            configMode,
            title,
            providerId: requireText(payload.providerId, "providerId"),
            baseUrl: requireHttpUrl(payload.baseUrl, "baseUrl"),
            model: requireText(payload.model, "model"),
            apiKey: requireText(payload.apiKey, "apiKey"),
            note: optionalText(payload.note),
            wireApi: "responses" as const,
            createdAt: now,
            updatedAt: now,
          };
    writeJsonFile(this.customPath(profile.id), profile);
    return profile;
  }

  updateCustomProfile(
    catalog: ProviderCatalog,
    id: string,
    payload: CustomProfileInput,
  ): StoredCustomProfile {
    this.ensure();
    if (this.findOfficial(catalog, id)) {
      throw new Error("official profile cannot be edited");
    }
    const existing = readJsonFile<StoredCustomProfile>(this.customPath(id));
    if (!existing) throw new Error("custom profile not found");
    const configMode: StoredCustomConfigMode = payload.configMode || configModeOf(existing);
    const title = requireText(payload.title, "title");
    const configToml = configMode === "chatgpt" ? requireText(payload.configToml, "configToml") : "";
    const rawIdentity = configMode === "chatgpt" ? rawChatGptIdentity(configToml) : null;
    const next =
      configMode === "chatgpt"
        ? {
            ...existing,
            configMode,
            title,
            providerId: rawIdentity?.providerId || "chatgpt",
            baseUrl: "",
            model: rawIdentity?.model || "chatgpt",
            apiKey: "",
            configToml,
            authJson: requireJsonText(payload.authJson, "authJson"),
            note: optionalText(payload.note),
            updatedAt: this.now().toISOString(),
          }
        : {
            ...existing,
            configMode,
            title,
            providerId: requireText(payload.providerId, "providerId"),
            baseUrl: requireHttpUrl(payload.baseUrl, "baseUrl"),
            model: requireText(payload.model, "model"),
            apiKey: String(payload.apiKey || "").trim() || (configModeOf(existing) === "custom" ? existing.apiKey : ""),
            note: optionalText(payload.note),
            configToml: undefined,
            authJson: undefined,
            updatedAt: this.now().toISOString(),
          };
    if (configMode === "custom" && !next.apiKey) {
      throw new Error("apiKey is required");
    }
    writeJsonFile(this.customPath(id), next);
    return next;
  }

  deleteProfile(catalog: ProviderCatalog, id: string) {
    this.ensure();
    if (this.findOfficial(catalog, id)) {
      throw new Error("official profile cannot be deleted");
    }
    const filePath = this.customPath(id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (this.readActive()?.id === id) {
      this.clearActiveProfile();
    }
  }

  resolveProfile(catalog: ProviderCatalog, id: string, apiKeyOverride = ""): ResolvedProfile {
    this.ensure();
    const official = this.findOfficial(catalog, id);
    if (official) {
      const override = currentOfficialOverride(official, this.readOfficialOverride(official.id));
      const model = override?.model || official.default_model;
      const apiKey = String(apiKeyOverride || "").trim() || String(override?.apiKey || "").trim();
      if (!apiKey) throw new Error("API Key is required");
      return {
        id: official.id,
        source: "official",
        configMode: "official",
        title: official.title,
        providerId: official.provider_id,
        providerName: official.provider_name,
        baseUrl: official.base_url,
        wireApi: official.wire_api,
        model,
        apiKey,
        auth: official.auth,
        models: official.models,
        configTemplate: official.config_template,
        ownedFiles: [...OFFICIAL_OWNED_FILES],
      };
    }
    const custom = readJsonFile<StoredCustomProfile>(this.customPath(id));
    if (!custom) throw new Error("profile not found");
    const configMode = configModeOf(custom);
    if (configMode === "chatgpt") {
      const rawIdentity = rawChatGptIdentity(custom.configToml);
      return {
        id: custom.id,
        source: "custom",
        configMode: "chatgpt",
        title: custom.title,
        providerId: rawIdentity.providerId,
        providerName: "ChatGPT",
        baseUrl: "",
        wireApi: "responses",
        model: rawIdentity.model,
        apiKey: "",
        auth: {
          type: "bearer_token",
          config_key: "experimental_bearer_token",
        },
        models: [],
        rawConfig: {
          configToml: requireText(custom.configToml, "configToml"),
          authJson: requireJsonText(custom.authJson, "authJson"),
        },
        ownedFiles: [...CHATGPT_OWNED_FILES],
      };
    }
    return {
      id: custom.id,
      source: "custom",
      configMode: "custom",
      title: custom.title,
      providerId: custom.providerId,
      providerName: custom.providerId,
      baseUrl: custom.baseUrl,
      wireApi: custom.wireApi,
      model: custom.model,
      apiKey: custom.apiKey,
      auth: {
        type: "bearer_token",
        config_key: "experimental_bearer_token",
      },
      models: [{ slug: custom.model, display_name: custom.model }],
      ownedFiles: [...CUSTOM_OWNED_FILES],
    };
  }

  ownedFilesForProfile(catalog: ProviderCatalog, id: string): CodexConfigFile[] {
    const official = this.findOfficial(catalog, id);
    if (official) return [...OFFICIAL_OWNED_FILES];
    const custom = readJsonFile<StoredCustomProfile>(this.customPath(id));
    if (!custom) return [];
    return ownedFilesForCustomMode(configModeOf(custom));
  }

  setActiveProfile(
    id: string,
    {
      model,
      sync,
      ownedFiles,
    }: { model: string; sync?: ActiveProfileState["sync"]; ownedFiles?: CodexConfigFile[] },
  ) {
    const active = {
      id,
      model,
      appliedAt: this.now().toISOString(),
      sync,
      ownedFiles,
    };
    writeJsonFile(this.activePath(), active);
    return active;
  }

  readActive(): ActiveProfileState | null {
    const active = readJsonFile<ActiveProfileState>(this.activePath());
    return active?.id ? active : null;
  }

  clearActiveProfile() {
    writeJsonFile(this.activePath(), {
      id: "",
      model: "",
      appliedAt: this.now().toISOString(),
    });
  }
}
