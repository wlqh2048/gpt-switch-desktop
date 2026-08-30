export type ProfileSource = "official" | "custom";
export type WireApi = "responses";
export type ApiKeyState = "missing" | "saved";
export type ProfileConfigMode = "official" | "custom" | "chatgpt";
export type CodexConfigFile = "config.toml" | "models.json" | "auth.json";

export interface CatalogAuth {
  type: "bearer_token";
  config_key: "experimental_bearer_token";
}

export interface CatalogModel {
  slug: string;
  display_name: string;
  description?: string;
  context_window?: number;
  default_reasoning_level?: string;
  input_modalities?: string[];
  [key: string]: unknown;
}

export interface CatalogProvider {
  id: string;
  title: string;
  description?: string;
  locked: boolean;
  provider_id: string;
  provider_name?: string;
  base_url: string;
  wire_api: WireApi;
  auth: CatalogAuth;
  default_model: string;
  models: CatalogModel[];
  config_template?: CatalogConfigTemplate;
  key_url?: string;
  editable_fields: string[];
}

export interface CatalogConfigTemplate {
  config_toml: string;
  models_json: {
    models: CatalogModel[];
    [key: string]: unknown;
  };
}

export interface ProviderCatalog {
  version: number;
  updated_at: string;
  providers: CatalogProvider[];
}

export type DownloadPlatform = "windows" | "macos";

export interface ServerDownloadInfo {
  platform: DownloadPlatform;
  version: string;
  name: string;
  url: string;
  expiresIn: number;
}

export interface DisplayProfile {
  id: string;
  source: ProfileSource;
  configMode: ProfileConfigMode;
  title: string;
  description: string;
  locked: boolean;
  providerId: string;
  providerName: string;
  baseUrl: string;
  wireApi: WireApi;
  model: string;
  models: CatalogModel[];
  keyUrl?: string;
  apiKeyState: ApiKeyState;
  isActive: boolean;
  updatedAt: string;
  ownedFiles: CodexConfigFile[];
  rawConfig?: {
    configToml: string;
    authJson: string;
  };
}

export interface CustomProfileInput {
  configMode?: "custom" | "chatgpt";
  title: string;
  providerId?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  configToml?: string;
  authJson?: string;
  note?: string;
}

export interface ResolvedProfile {
  id: string;
  source: ProfileSource;
  configMode: ProfileConfigMode;
  title: string;
  providerId: string;
  providerName?: string;
  baseUrl: string;
  wireApi: WireApi;
  model: string;
  apiKey: string;
  auth: CatalogAuth;
  models: CatalogModel[];
  configTemplate?: CatalogConfigTemplate;
  rawConfig?: {
    configToml: string;
    authJson: string;
  };
  ownedFiles: CodexConfigFile[];
}

export interface ActiveProfileState {
  id: string;
  model: string;
  appliedAt: string;
  sync?: SyncSummary;
  ownedFiles?: CodexConfigFile[];
}

export interface SyncProgress {
  runId: string;
  phase: string;
  processed: number;
  total?: number;
  currentPath?: string;
  rssMb?: number;
  message: string;
}

export interface SyncSummary {
  skipped: boolean;
  sqliteFiles: number;
  normalizedRows: number;
  dedupedRows: number;
  staleRowsRemoved: number;
  orphanStateRefsRemoved: number;
  rolloutPathsRepaired: number;
  rolloutMetaScanned: number;
  rolloutMetaUpdated: number;
  legacyRolloutsDetected: number;
  legacyReasoningRowsRestored: number;
  threadHistoryProjectionsReset: number;
  repairBackupsCreated: number;
  indexChanged: boolean;
  pinnedChanged: boolean;
  errors: string[];
}

export interface ApplyResult {
  success: boolean;
  message: string;
  active?: ActiveProfileState;
  sync?: SyncSummary;
  runtime?: {
    stop?: RuntimeActionResult;
    start?: RuntimeActionResult;
  };
}

export interface RuntimeActionResult {
  success: boolean;
  message: string;
}

export interface BootstrapState {
  version: string;
  serverVersion: string;
  serverVersionError?: string;
  codexDir: string;
  storeDir: string;
  serverBase: string;
  catalog: ProviderCatalog;
  catalogError?: string;
  profiles: DisplayProfile[];
  active: ActiveProfileState | null;
}
