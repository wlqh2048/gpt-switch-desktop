import {
  AppstoreOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import {
  App as AntApp,
  Button,
  ConfigProvider,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  Tooltip,
  theme as antdTheme,
} from "antd";
import type { MenuProps } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BootstrapState,
  CatalogProvider,
  CustomProfileInput,
  DisplayProfile,
  DownloadPlatform,
  ProviderCatalog,
  SyncProgress,
} from "../shared/types";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  createTranslator,
  isLanguage,
} from "./i18n";
import type { Language, Translate } from "./i18n";
import {
  desktopAnalyticsContext,
  formatAnalyticsEventName,
  trackAnalyticsEvent,
} from "./analytics";
import type { AnalyticsData } from "./analytics";
import {
  ThemeMode,
  ViewMode,
  applyUpdateBlockForVersions,
  cardTextForProfile,
  clientDownloadPlatformForUserAgent,
  initialSyncProgress,
  nextSyncProgressPercent,
  profilesWithLocalOfficialKeys,
  readOfficialApiKey,
  shellClassNameForUserAgent,
  storeOfficialApiKey,
  SYNC_PROGRESS_DONE_HOLD_MS,
  syncProgressMessage,
  updateNoticeForVersions,
} from "./uiModel";

type SyncProgressView = {
  progress: SyncProgress;
  percent: number;
};

type ProfileModalState =
  | { mode: "official"; profile: DisplayProfile }
  | { mode: "custom-create"; profile?: undefined }
  | { mode: "custom-edit"; profile: DisplayProfile }
  | null;

type ProfileFormValues = CustomProfileInput & {
  note?: string;
};

type AiModelApi = Window["aiModel"];

const WINDOW_TITLEBAR_HEIGHT = 52;
const BROWSER_SERVER_BASE = String(
  import.meta.env.GPT_SWITCH_SERVER_BASE || "",
)
  .trim()
  .replace(/\/+$/, "");
const DESKTOP_DEVICE_STORAGE_KEY = "gpt-switch-desktop-device-id";

let fallbackDesktopDeviceId = "";

function currentUserAgent() {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

function isWindowsShell(userAgent: string) {
  return clientDownloadPlatformForUserAgent(userAgent) === "windows";
}

function titlebarMaskStyle() {
  return isWindowsShell(currentUserAgent())
    ? { top: WINDOW_TITLEBAR_HEIGHT }
    : undefined;
}

function createAnonymousDeviceId(prefix: string) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readOrCreateDesktopDeviceId() {
  if (typeof window === "undefined") return createAnonymousDeviceId("desktop");
  try {
    const saved = window.localStorage.getItem(DESKTOP_DEVICE_STORAGE_KEY);
    if (saved) return saved;
    const next = createAnonymousDeviceId("desktop");
    window.localStorage.setItem(DESKTOP_DEVICE_STORAGE_KEY, next);
    return next;
  } catch (_error) {
    if (!fallbackDesktopDeviceId) {
      fallbackDesktopDeviceId = createAnonymousDeviceId("desktop");
    }
    return fallbackDesktopDeviceId;
  }
}

function startDesktopHeartbeat(state: BootstrapState) {
  if (!state.serverBase || typeof window === "undefined") return () => {};
  const endpoint = new URL("/api/stats/desktop/heartbeat", state.serverBase);

  function sendDesktopHeartbeat() {
    try {
      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: readOrCreateDesktopDeviceId(),
          app_version: state.version,
          platform: clientDownloadPlatformForUserAgent(currentUserAgent()),
          language: navigator.language || "",
        }),
      }).catch(() => {});
    } catch (_error) {}
  }

  sendDesktopHeartbeat();
  const heartbeatTimer = window.setInterval(sendDesktopHeartbeat, 60 * 1000);
  return () => window.clearInterval(heartbeatTimer);
}

function bridgeUnavailable(t: Translate) {
  return new Error(t("browserLocalActionError"));
}

function emptyCatalog(): ProviderCatalog {
  return {
    version: 1,
    updated_at: new Date(0).toISOString(),
    providers: [],
  };
}

function profileFromProvider(
  provider: CatalogProvider,
  catalog: ProviderCatalog,
): DisplayProfile {
  return {
    id: provider.id,
    source: "official",
    configMode: "official",
    title: provider.title,
    description: provider.description || "",
    locked: provider.locked,
    providerId: provider.provider_id,
    providerName: provider.provider_name || provider.title,
    baseUrl: provider.base_url,
    wireApi: provider.wire_api,
    model: provider.default_model,
    models: provider.models,
    keyUrl: provider.key_url,
    apiKeyState: readOfficialApiKey(provider.id) ? "saved" : "missing",
    isActive: false,
    updatedAt: catalog.updated_at,
    ownedFiles: ["config.toml", "models.json"],
  };
}

function profilesFromCatalog(catalog: ProviderCatalog) {
  return catalog.providers.map((provider) => profileFromProvider(provider, catalog));
}

async function fetchBrowserJson<T>(path: string): Promise<T> {
  if (!BROWSER_SERVER_BASE) throw new Error("server base is not configured");
  const response = await fetch(`${BROWSER_SERVER_BASE}${path}`);
  if (!response.ok) throw new Error(`${path} http ${response.status}`);
  const body = (await response.json()) as T & {
    success?: boolean;
    error?: { message?: string };
  };
  if (body.success === false) {
    throw new Error(body.error?.message || "server error");
  }
  return body;
}

async function loadBrowserCatalogForDisplay() {
  if (!BROWSER_SERVER_BASE) {
    return { catalog: emptyCatalog(), profiles: [] };
  }
  try {
    const body = await fetchBrowserJson<{ catalog?: ProviderCatalog }>(
      "/api/catalog/v1/providers",
    );
    const catalog = body.catalog || emptyCatalog();
    return { catalog, profiles: profilesFromCatalog(catalog) };
  } catch (error) {
    return {
      catalog: emptyCatalog(),
      catalogError: error instanceof Error ? error.message : String(error),
      profiles: [],
    };
  }
}

async function loadBrowserVersionForDisplay() {
  if (!BROWSER_SERVER_BASE) return { serverVersion: "" };
  try {
    const body = await fetchBrowserJson<{
      version?: unknown;
    }>("/api/catalog/v1/version");
    return {
      serverVersion: String(body.version || ""),
    };
  } catch (error) {
    return {
      serverVersion: "",
      serverVersionError: error instanceof Error ? error.message : String(error),
    };
  }
}

function isDownloadPlatform(value: string): value is DownloadPlatform {
  return value === "windows" || value === "macos";
}

function assertLatestDownloadUrl(value: unknown) {
  const rawUrl = String(value || "").trim();
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("download.url must be http or https");
  }
  return rawUrl;
}

async function fetchLatestDownloadForState(
  state: BootstrapState,
  userAgent: string,
  unavailableMessage: string,
) {
  const platform = clientDownloadPlatformForUserAgent(userAgent);
  if (!isDownloadPlatform(platform)) {
    throw new Error(unavailableMessage);
  }
  const serverBase = String(state.serverBase || "").trim();
  if (!serverBase) throw new Error(unavailableMessage);
  const endpoint = new URL("/api/downloads/v1/latest", serverBase);
  endpoint.searchParams.set("platform", platform);
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`download http ${response.status}`);
  }
  const body = (await response.json()) as {
    success?: boolean;
    platform?: unknown;
    version?: unknown;
    name?: unknown;
    url?: unknown;
    error?: { message?: string };
  };
  if (body.success === false) {
    throw new Error(body.error?.message || unavailableMessage);
  }
  return {
    platform,
    version: String(body.version || ""),
    name: String(body.name || ""),
    url: assertLatestDownloadUrl(body.url),
  };
}

function createBrowserPreviewApi(t: Translate): AiModelApi {
  return {
    bootstrap: {
      get: async () => {
        const [
          { catalog, catalogError, profiles },
          { serverVersion, serverVersionError },
        ] = await Promise.all([
          loadBrowserCatalogForDisplay(),
          loadBrowserVersionForDisplay(),
        ]);
        return {
          version: "",
          serverVersion,
          serverVersionError,
          codexDir: "",
          storeDir: "",
          serverBase: BROWSER_SERVER_BASE,
          catalog,
          catalogError,
          profiles,
          active: null,
        };
      },
    },
    catalog: {
      refresh: async () => {
        if (!BROWSER_SERVER_BASE) {
          const catalog = emptyCatalog();
          return { success: true, catalog, profiles: [] };
        }
        const body = await fetchBrowserJson<{ catalog?: ProviderCatalog }>(
          "/api/catalog/v1/providers",
        );
        const catalog = body.catalog || emptyCatalog();
        return {
          success: true,
          catalog,
          profiles: profilesFromCatalog(catalog),
        };
      },
    },
    profiles: {
      list: async () => {
        const { catalog, catalogError, profiles } =
          await loadBrowserCatalogForDisplay();
        return {
          success: true,
          profiles,
          active: null,
          catalogError,
          catalog,
        };
      },
      saveOfficialKey: async () => {
        throw bridgeUnavailable(t);
      },
      create: async () => {
        throw bridgeUnavailable(t);
      },
      update: async () => {
        throw bridgeUnavailable(t);
      },
      delete: async () => {
        throw bridgeUnavailable(t);
      },
      apply: async () => {
        throw bridgeUnavailable(t);
      },
      reset: async () => {
        throw bridgeUnavailable(t);
      },
    },
    runtime: {
      restartChatGPT: async () => {
        throw bridgeUnavailable(t);
      },
      openExternal: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      openCodexDir: async () => {
        throw bridgeUnavailable(t);
      },
    },
    sync: {
      onProgress: () => () => {},
    },
    window: {
      minimize: async () => {},
      close: async () => {},
    },
  };
}

function getNativeAiModel() {
  if (typeof window === "undefined") return undefined;
  const aiModel = window.aiModel as AiModelApi | undefined;
  return aiModel;
}

function hasNativeAiModel() {
  return Boolean(getNativeAiModel());
}

function getAiModel(t: Translate = createTranslator(DEFAULT_LANGUAGE)) {
  const aiModel = getNativeAiModel();
  return aiModel || createBrowserPreviewApi(t);
}

function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === "dark" || value === "light";
}

function readInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const documentTheme = document.documentElement.dataset.theme;
  if (isThemeMode(documentTheme)) return documentTheme;
  const saved = window.localStorage.getItem("ai-switch-theme");
  if (isThemeMode(saved)) return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function antdTokens(themeMode: ThemeMode) {
  const dark = themeMode === "dark";
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: "#E32A4B",
      colorPrimaryHover: "#C21B38",
      colorLink: "#E32A4B",
      colorLinkHover: "#C21B38",
      colorSuccess: dark ? "#4ade80" : "#16a34a",
      colorError: "#E32A4B",
      colorBgLayout: dark ? "#000000" : "#ffffff",
      colorBgContainer: dark ? "#0A0A0A" : "#ffffff",
      colorBgElevated: dark ? "#0A0A0A" : "#ffffff",
      colorBorder: dark ? "#1F1F1F" : "#e5e7eb",
      colorText: dark ? "#ffffff" : "#111827",
      colorTextSecondary: dark ? "#d1d5db" : "#6b7280",
      colorTextDisabled: dark ? "#6b7280" : "#9ca3af",
      borderRadius: 8,
      controlHeight: 34,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    },
    components: {
      Button: {
        borderRadius: 8,
        controlHeight: 34,
      },
      Modal: {
        borderRadiusLG: 10,
        contentBg: dark ? "#0A0A0A" : "#ffffff",
        headerBg: dark ? "#0A0A0A" : "#ffffff",
        titleColor: dark ? "#ffffff" : "#111827",
      },
      Segmented: {
        itemSelectedBg: "#E32A4B",
        itemSelectedColor: "#ffffff",
        trackBg: dark ? "#0A0A0A" : "#ffffff",
      },
    },
  };
}

function editableNote(profile: DisplayProfile, t: Translate) {
  if (profile.source === "official") return profile.description || t("officialConfig");
  if (
    profile.configMode === "chatgpt" &&
    profile.description === "ChatGPT 配置"
  )
    return "";
  return profile.description.includes("://") ? "" : profile.description;
}

function withLocalKeys<T extends { profiles: DisplayProfile[] }>(value: T): T {
  return {
    ...value,
    profiles: profilesWithLocalOfficialKeys(value.profiles),
  };
}

function showCatalogError(
  error: string | undefined,
  messageApi: ReturnType<typeof AntApp.useApp>["message"],
) {
  if (error) messageApi.error(error, 3);
}

function profileAnalyticsData(profile: DisplayProfile): AnalyticsData {
  return {
    profile_source: profile.source,
    config_mode: profile.configMode,
    api_key_state: profile.apiKeyState,
    is_active: profile.isActive,
    locked: profile.locked,
  };
}

function modalAnalyticsData(state: ProfileModalState): AnalyticsData {
  return {
    mode: state?.mode || "unknown",
    profile_source: state?.profile?.source || "custom",
    config_mode: state?.profile?.configMode || "chatgpt",
  };
}

function ProfileCard({
  profile,
  applying,
  language,
  t,
  onApply,
  onEdit,
}: {
  profile: DisplayProfile;
  applying: boolean;
  language: Language;
  t: Translate;
  onApply: () => void;
  onEdit: () => void;
}) {
  const text = cardTextForProfile(profile, language);
  const needsKey = profile.apiKeyState !== "saved";
  const remark = needsKey ? `${text.remark} · ${t("needApiKey")}` : text.remark;
  return (
    <article className={`config-card ${profile.isActive ? "is-active" : ""}`}>
      <div className="config-card-content">
        <h3>{text.title}</h3>
        <p title={remark}>{remark}</p>
        <span className={`state-badge is-${text.statusTone}`}>
          {text.statusLabel}
        </span>
      </div>
      <div className="config-card-actions">
        <Button
          block
          loading={applying}
          onClick={onApply}
        >
          {text.primaryAction}
        </Button>
        <Button block onClick={onEdit}>
          {text.secondaryAction}
        </Button>
      </div>
    </article>
  );
}

function ProfileModal({
  state,
  t,
  trackDesktopEvent,
  onClose,
  onSaved,
  onDelete,
}: {
  state: ProfileModalState;
  t: Translate;
  trackDesktopEvent: (eventName: string, data?: AnalyticsData) => void;
  onClose: () => void;
  onSaved: (profiles: DisplayProfile[], catalogError?: string) => void;
  onDelete: (profile: DisplayProfile) => void;
}) {
  const [form] = Form.useForm<ProfileFormValues>();
  const [saving, setSaving] = useState(false);
  const profile = state?.profile;
  const isOfficial = state?.mode === "official";
  const isEditingCustom = state?.mode === "custom-edit";
  const hasLocalOfficialKey = Boolean(
    isOfficial && profile && readOfficialApiKey(profile.id),
  );

  useEffect(() => {
    if (!state) return;
    if (profile) {
      form.setFieldsValue({
        title: profile.title,
        model: profile.model,
        apiKey: "",
        configToml: profile.rawConfig?.configToml || "",
        authJson: profile.rawConfig?.authJson || "",
        note: editableNote(profile, t),
      });
      return;
    }
    form.setFieldsValue({
      title: "",
      model: "",
      apiKey: "",
      configToml: "",
      authJson: "",
      note: "",
    });
  }, [form, profile, state, t]);

  const modelOptions = useMemo(
    () =>
      profile?.models.map((item) => ({
        value: item.slug,
        label: item.display_name || item.slug,
      })) || [],
    [profile],
  );

  async function save() {
    const analyticsData = modalAnalyticsData(state);
    trackDesktopEvent("保存配置", analyticsData);
    setSaving(true);
    try {
      const values = await form.validateFields();
      const payload: CustomProfileInput = {
        configMode: "chatgpt",
        title: values.title,
        configToml: values.configToml,
        authJson: values.authJson,
        note: values.note,
      };
      const aiModel = getAiModel(t);
      const result =
        state?.mode === "official" && profile
          ? await aiModel.profiles.saveOfficialKey({
              providerId: profile.id,
              model: values.model || profile.model,
            })
          : state?.mode === "custom-edit" && profile
            ? await aiModel.profiles.update(profile.id, payload)
            : await aiModel.profiles.create(payload);
      if (!result.success) throw new Error(result.message || t("saveFailed"));
      if (state?.mode === "official" && profile && values.apiKey) {
        storeOfficialApiKey(profile.id, values.apiKey);
      }
      onSaved(
        profilesWithLocalOfficialKeys(result.profiles),
        result.catalogError,
      );
      trackDesktopEvent("保存配置成功", analyticsData);
      onClose();
    } catch (error) {
      trackDesktopEvent("保存配置失败", analyticsData);
      throw error;
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      centered
      className="profile-modal"
      destroyOnHidden
      maskStyle={titlebarMaskStyle()}
      footer={
        <div className="modal-footer">
          <div className="modal-footer-left">
            <Button
              className="open-config-dir-button"
              icon={<FolderOpenOutlined />}
              type="text"
              onClick={() => {
                trackDesktopEvent("打开配置目录", modalAnalyticsData(state));
                getAiModel(t).runtime.openCodexDir();
              }}
            >
              {t("openConfigDir")}
            </Button>
            {isEditingCustom && profile ? (
              <Button
                className="delete-link"
                danger
                type="link"
                onClick={() => {
                  trackDesktopEvent("删除配置", modalAnalyticsData(state));
                  onDelete(profile);
                }}
              >
                {t("deleteConfig")}
              </Button>
            ) : null}
          </div>
          <div className="modal-footer-actions">
            <Button
              onClick={() => {
                trackDesktopEvent("取消编辑", modalAnalyticsData(state));
                onClose();
              }}
            >
              {t("cancel")}
            </Button>
            <Button loading={saving} type="primary" onClick={save}>
              {t("save")}
            </Button>
          </div>
        </div>
      }
      open={Boolean(state)}
      title={state?.mode === "custom-create" ? t("createConfig") : t("editConfig")}
      width={420}
      onCancel={() => {
        trackDesktopEvent("取消编辑", modalAnalyticsData(state));
        onClose();
      }}
    >
      <Form form={form} layout="vertical" className="profile-form">
        <Form.Item
          label={t("configName")}
          name="title"
          rules={[{ required: true, message: t("configNameRequired") }]}
        >
          <Input disabled={isOfficial} placeholder={t("configNamePlaceholder")} />
        </Form.Item>

        {isOfficial ? (
          <>
            <Form.Item
              label={t("model")}
              name="model"
              rules={[{ required: true, message: t("modelRequired") }]}
            >
              <Select options={modelOptions} />
            </Form.Item>
            <Form.Item
              label={t("apiKey")}
              name="apiKey"
              rules={[
                { required: !hasLocalOfficialKey, message: t("apiKeyRequired") },
              ]}
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={
                  hasLocalOfficialKey ? t("keepExistingApiKey") : "sk-..."
                }
              />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item
              label="config.toml"
              name="configToml"
              rules={[{ required: true, message: t("configTomlRequired") }]}
            >
              <Input.TextArea
                className="config-textarea"
                placeholder={'model = "gpt-5"'}
                rows={7}
              />
            </Form.Item>
            <Form.Item
              label="auth.json"
              name="authJson"
              rules={[{ required: true, message: t("authJsonRequired") }]}
            >
              <Input.TextArea
                className="config-textarea"
                placeholder={'{"auth_mode":"chatgpt"}'}
                rows={5}
              />
            </Form.Item>
          </>
        )}

        <Form.Item label={t("note")} name="note">
          <Input.TextArea
            disabled={isOfficial}
            placeholder={t("notePlaceholder")}
            rows={3}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function StartupScreen() {
  return (
    <div className="startup-screen" aria-label="GPT Switch">
      <img className="startup-icon" src="./favicon.svg" alt="" />
    </div>
  );
}

function AppContent({
  themeMode,
  setThemeMode,
  language,
  setLanguage,
}: {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  language: Language;
  setLanguage: (language: Language) => void;
}) {
  const { message, modal } = AntApp.useApp();
  const t = useMemo(() => createTranslator(language), [language]);
  const [state, setState] = useState<BootstrapState | null>(null);
  const [modalState, setModalState] = useState<ProfileModalState>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [applyingId, setApplyingId] = useState("");
  const [resetting, setResetting] = useState(false);
  const [syncProgressView, setSyncProgressView] =
    useState<SyncProgressView | null>(null);
  const startupTrackedRef = useRef(false);
  const syncProgressClearTimerRef = useRef<number | null>(null);

  function clearSyncProgressTimer() {
    if (syncProgressClearTimerRef.current === null) return;
    window.clearTimeout(syncProgressClearTimerRef.current);
    syncProgressClearTimerRef.current = null;
  }

  function hideSyncProgressNow() {
    clearSyncProgressTimer();
    setSyncProgressView(null);
  }

  function showInitialSyncProgress(profileId: string) {
    clearSyncProgressTimer();
    const progress = initialSyncProgress(`apply-${profileId}-${Date.now()}`);
    const next = nextSyncProgressPercent(progress, null);
    setSyncProgressView({ progress, percent: next.percent });
  }

  function clearSyncProgressAfterDelay() {
    clearSyncProgressTimer();
    syncProgressClearTimerRef.current = window.setTimeout(() => {
      setSyncProgressView(null);
      syncProgressClearTimerRef.current = null;
    }, SYNC_PROGRESS_DONE_HOLD_MS);
  }

  function trackDesktopEvent(
    eventName: string,
    data: AnalyticsData = {},
    trigger = "onClick",
  ) {
    const userAgent = currentUserAgent();
    trackAnalyticsEvent(formatAnalyticsEventName("desktop", eventName, trigger), {
      ...desktopAnalyticsContext({
        appVersion: state?.version || "",
        language,
        theme: themeMode,
        userAgent,
      }),
      ...data,
    });
  }

  async function openLatestDownload(
    sourceState: BootstrapState,
    from: string,
    latestVersion = "",
  ) {
    const download = await fetchLatestDownloadForState(
      sourceState,
      currentUserAgent(),
      t("downloadLinkUnavailable"),
    );
    trackDesktopEvent("打开更新链接", {
      from,
      latest_version: latestVersion || download.version,
      platform: download.platform,
      file_name: download.name,
    });
    await getAiModel(t).runtime.openExternal(download.url);
  }

  function showApplyUpdateBlock(
    updateBlock: NonNullable<ReturnType<typeof applyUpdateBlockForVersions>>,
    sourceState: BootstrapState,
  ) {
    modal.confirm({
      centered: true,
      maskStyle: titlebarMaskStyle(),
      title: updateBlock.title,
      content: updateBlock.content,
      okText: updateBlock.okText,
      cancelText: updateBlock.cancelText,
      onOk: async () => {
        try {
          await openLatestDownload(
            sourceState,
            "apply_update_modal",
            updateBlock.latestVersion,
          );
        } catch (error) {
          message.warning(
            error instanceof Error ? error.message : t("downloadLinkUnavailable"),
            2,
          );
        }
      },
    });
  }

  async function refresh() {
    const next = await getAiModel(t).bootstrap.get();
    const nextState = withLocalKeys(next);
    setState(nextState);
    showCatalogError(next.catalogError, message);
    return nextState;
  }

  useEffect(() => {
    const aiModel = getAiModel(t);
    refresh()
      .then((nextState) => {
        if (startupTrackedRef.current) return;
        startupTrackedRef.current = true;
        trackDesktopEvent(
          "桌面端启动",
          {
            app_version: nextState.version || "",
          },
          "onLoad",
        );
      })
      .catch((error) => message.error(error.message || t("startupFailed")));
    return aiModel.sync.onProgress((progress) => {
      clearSyncProgressTimer();
      setSyncProgressView((previous) => {
        const next = nextSyncProgressPercent(
          progress,
          previous
            ? { runId: previous.progress.runId, percent: previous.percent }
            : null,
        );
        return { progress, percent: next.percent };
      });
    });
  }, [message, t]);

  useEffect(() => () => clearSyncProgressTimer(), []);

  useEffect(() => {
    if (!state || !hasNativeAiModel()) return;
    return startDesktopHeartbeat(state);
  }, [state?.serverBase, state?.version]);

  const userAgent = currentUserAgent();

  if (!state) {
    return (
      <main className={`${shellClassNameForUserAgent(userAgent)} is-starting`}>
        <StartupScreen />
      </main>
    );
  }

  async function apply(
    profile: DisplayProfile,
    successText: string | null = t("configApplied"),
    trackApplyResult = true,
  ) {
    const analyticsData = profileAnalyticsData(profile);
    const officialApiKey =
      profile.source === "official" ? readOfficialApiKey(profile.id) : "";
    if (profile.source === "official" && !officialApiKey) {
      if (trackApplyResult) {
        trackDesktopEvent("应用配置失败", {
          ...analyticsData,
          reason: "missing_api_key",
        });
      }
      message.warning(t("apiKeyMissingToast"), 2);
      return null;
    }

    const sourceState = state;
    if (!sourceState) return null;

    const cachedUpdateBlock = hasNativeAiModel()
      ? applyUpdateBlockForVersions(
          sourceState.version,
          sourceState.serverVersion,
          language,
        )
      : null;
    if (cachedUpdateBlock) {
      if (trackApplyResult) {
        trackDesktopEvent("应用配置失败", {
          ...analyticsData,
          reason: "update_required",
        });
      }
      showApplyUpdateBlock(cachedUpdateBlock, sourceState);
      return null;
    }

    setApplyingId(profile.id);
    showInitialSyncProgress(profile.id);
    let latestState = sourceState;
    let didApply = false;
    let failureReason = "";
    try {
      try {
        latestState = await refresh();
      } catch (error) {
        failureReason = "startup_refresh_failed";
        throw error;
      }
      const updateBlock = hasNativeAiModel() && latestState
        ? applyUpdateBlockForVersions(
            latestState.version,
            latestState.serverVersion,
            language,
          )
        : null;
      if (updateBlock) {
        if (trackApplyResult) {
          trackDesktopEvent("应用配置失败", {
            ...analyticsData,
            reason: "update_required",
          });
        }
        showApplyUpdateBlock(updateBlock, latestState);
        return null;
      }
      const apiKey = profile.source === "official" ? officialApiKey : undefined;
      const result = await getAiModel(t).profiles.apply(profile.id, { apiKey });
      if (!result.success) throw new Error(result.message || t("applyFailed"));
      if (result.profiles && state) {
        setState({
          ...state,
          profiles: profilesWithLocalOfficialKeys(result.profiles),
          active: result.active || state.active,
          catalogError: result.catalogError,
        });
      } else {
        await refresh();
      }
      showCatalogError(result.catalogError, message);
      if (successText) message.success(successText, 2);
      if (trackApplyResult) {
        trackDesktopEvent("应用配置成功", analyticsData);
      }
      didApply = true;
      return result;
    } catch (error) {
      if (trackApplyResult) {
        trackDesktopEvent(
          "应用配置失败",
          failureReason ? { ...analyticsData, reason: failureReason } : analyticsData,
        );
      }
      message.error(error instanceof Error ? error.message : t("applyFailed"), 2);
      return null;
    } finally {
      setApplyingId("");
      if (didApply) {
        clearSyncProgressAfterDelay();
      } else {
        hideSyncProgressNow();
      }
    }
  }

  async function remove(profile: DisplayProfile) {
    const analyticsData = profileAnalyticsData(profile);
    try {
      const result = await getAiModel(t).profiles.delete(profile.id);
      if (!result.success) {
        trackDesktopEvent("删除配置失败", analyticsData);
        message.error(result.message || t("deleteFailed"), 2);
        return;
      }
      if (state) {
        setState({
          ...state,
          profiles: profilesWithLocalOfficialKeys(result.profiles),
          active: state.active?.id === profile.id ? null : state.active,
          catalogError: result.catalogError,
        });
      }
      showCatalogError(result.catalogError, message);
      trackDesktopEvent("删除配置成功", analyticsData);
      message.success(t("configDeleted"), 2);
    } catch (error) {
      trackDesktopEvent("删除配置失败", analyticsData);
      message.error(error instanceof Error ? error.message : t("deleteFailed"), 2);
    }
  }

  function confirmRemove(profile: DisplayProfile) {
    modal.confirm({
      centered: true,
      maskStyle: titlebarMaskStyle(),
      title: t("deleteTitle"),
      content: t("deleteContent"),
      okText: t("confirmDelete"),
      okButtonProps: { danger: true },
      cancelText: t("cancel"),
      onOk: async () => {
        trackDesktopEvent("确认删除配置", profileAnalyticsData(profile));
        await remove(profile);
        setModalState(null);
      },
    });
  }

  function confirmReset() {
    trackDesktopEvent("重置配置");
    modal.confirm({
      centered: true,
      maskStyle: titlebarMaskStyle(),
      title: t("resetTitle"),
      content: t("resetContent"),
      okText: t("resetConfirm"),
      okButtonProps: { danger: true },
      cancelText: t("cancel"),
      onOk: async () => {
        setResetting(true);
        hideSyncProgressNow();
        try {
          const result = await getAiModel(t).profiles.reset();
          if (!result.success) throw new Error(result.message || t("resetFailed"));
          if (state) {
            setState({
              ...state,
              profiles: result.profiles
                ? profilesWithLocalOfficialKeys(result.profiles)
                : state.profiles.map((profile) => ({
                    ...profile,
                    isActive: false,
                  })),
              active: null,
              catalogError: result.catalogError,
            });
          } else {
            await refresh();
          }
          showCatalogError(result.catalogError, message);
          trackDesktopEvent("重置配置成功");
          message.success(result.message || t("resetSuccess"), 2);
        } catch (error) {
          trackDesktopEvent("重置配置失败");
          message.error(error instanceof Error ? error.message : t("resetFailed"), 2);
        } finally {
          setResetting(false);
        }
      },
    });
  }

  async function checkForUpdate(from: string) {
    trackDesktopEvent("检测更新", { from });
    try {
      const latestState = await refresh();
      if (latestState.serverVersionError) {
        throw new Error(latestState.serverVersionError);
      }
      const notice = updateNoticeForVersions(
        latestState.version,
        latestState.serverVersion,
        language,
      );
      if (!notice) {
        message.success(t("alreadyLatest"), 2);
        return;
      }
      await openLatestDownload(latestState, from, notice.latestVersion);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("startupFailed"), 2);
    }
  }

  const profiles = state?.profiles || [];
  const syncProgress = syncProgressView?.progress || null;
  const progressPercent = syncProgressView?.percent || 0;
  const updateNotice = state
    ? updateNoticeForVersions(
        state.version,
        state.serverVersion,
        language,
      )
    : null;
  const settingsMenu: MenuProps = {
    selectedKeys: [themeMode, language],
    items: [
      ...(state?.version
        ? [
            {
              key: "app-version",
              label: `v${state.version}`,
            },
            { type: "divider" as const },
          ]
        : []),
      { key: "dark", label: t("darkMode") },
      { key: "light", label: t("lightMode") },
      { type: "divider" },
      { key: "zh-CN", label: t("languageChinese") },
      { key: "en-US", label: t("languageEnglish") },
    ],
    onClick: ({ key }) => {
      if (key === "dark") {
        trackDesktopEvent("切换深色模式");
        setThemeMode("dark");
        return;
      }
      if (key === "light") {
        trackDesktopEvent("切换浅色模式");
        setThemeMode("light");
        return;
      }
      if (key === "zh-CN") {
        trackDesktopEvent("切换中文");
        setLanguage("zh-CN");
        return;
      }
      if (key === "en-US") {
        trackDesktopEvent("切换英文");
        setLanguage("en-US");
        return;
      }
      if (key === "app-version") {
        void checkForUpdate("settings_version");
        return;
      }
    },
  };

  return (
    <main className={shellClassNameForUserAgent(userAgent)}>
      <header className="topbar">
        <div className="titlebar-left">
          <AppstoreOutlined className="app-icon" />
        </div>
        <div className="titlebar-title">
          <span>GPT Switch</span>
          {updateNotice ? (
            <button
              className="update-badge"
              type="button"
              onClick={() => void checkForUpdate("badge")}
            >
              {updateNotice.label}
            </button>
          ) : null}
        </div>
        <div className="topbar-actions">
          <Tooltip title={t("resetTooltip")} placement="bottom">
            <Button
              className="reset-button"
              disabled={Boolean(applyingId)}
              icon={<ReloadOutlined spin={resetting} />}
              loading={resetting}
              type="text"
              onClick={confirmReset}
            >
              {t("resetGpt")}
            </Button>
          </Tooltip>
          <Dropdown menu={settingsMenu} trigger={["click"]}>
            <Button
              aria-label={t("openSettings")}
              className="settings-button"
              icon={<SettingOutlined />}
              onClick={() => trackDesktopEvent("打开设置")}
            />
          </Dropdown>
        </div>
      </header>

      <section className="action-bar">
        <Button
          className="create-button"
          icon={<PlusOutlined />}
          type="primary"
          onClick={() => {
            trackDesktopEvent("新增配置", { mode: "custom_create" });
            setModalState({ mode: "custom-create" });
          }}
        >
          {t("createConfig")}
        </Button>
        <div className="toolbar-tools">
          <Segmented
            className="view-segmented"
            value={viewMode}
            options={[
              {
                label: (
                  <span className="segmented-label">
                    <AppstoreOutlined />
                    {t("grid")}
                  </span>
                ),
                value: "grid",
              },
              {
                label: (
                  <span className="segmented-label">
                    <UnorderedListOutlined />
                    {t("list")}
                  </span>
                ),
                value: "list",
              },
            ]}
            onChange={(value) => {
              const nextViewMode = value as ViewMode;
              if (nextViewMode === "grid") {
                trackDesktopEvent("切换网格视图");
              } else {
                trackDesktopEvent("切换列表视图");
              }
              setViewMode(nextViewMode);
            }}
          />
        </div>
      </section>

      {syncProgress && (
        <div className="sync-line">
          <Progress percent={progressPercent} showInfo={false} size="small" />
          <span>{syncProgressMessage(syncProgress, language)}</span>
        </div>
      )}

      <section className="config-area">
        {profiles.length ? (
          <div className={`config-grid is-${viewMode}`}>
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                applying={applyingId === profile.id}
                language={language}
                t={t}
                onApply={() => {
                  trackDesktopEvent("应用配置", profileAnalyticsData(profile));
                  void apply(profile);
                }}
                onEdit={() => {
                  trackDesktopEvent("编辑配置", profileAnalyticsData(profile));
                  setModalState(
                    profile.source === "official"
                      ? { mode: "official", profile }
                      : { mode: "custom-edit", profile },
                  );
                }}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Empty
              description={t("emptyConfig")}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
            <Button
              type="link"
              onClick={() => {
                trackDesktopEvent("新增配置", { mode: "empty_state" });
                setModalState({ mode: "custom-create" });
              }}
            >
              {t("createConfig")}
            </Button>
          </div>
        )}
      </section>

      <ProfileModal
        state={modalState}
        t={t}
        trackDesktopEvent={trackDesktopEvent}
        onClose={() => setModalState(null)}
        onDelete={confirmRemove}
        onSaved={(profiles, catalogError) => {
          if (state) setState({ ...state, profiles, catalogError });
          showCatalogError(catalogError, message);
          message.success(t("configSaved"), 2);
        }}
      />
    </main>
  );
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === "undefined") return DEFAULT_LANGUAGE;
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(saved) ? saved : DEFAULT_LANGUAGE;
  });
  const antdLocale = language === "zh-CN" ? zhCN : enUS;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem("ai-switch-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.lang = language;
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  return (
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={antdLocale}
      theme={antdTokens(themeMode)}
    >
      <AntApp>
        <AppContent
          language={language}
          setLanguage={setLanguage}
          setThemeMode={setThemeMode}
          themeMode={themeMode}
        />
      </AntApp>
    </ConfigProvider>
  );
}
