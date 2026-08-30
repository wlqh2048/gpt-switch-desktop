import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function cssBlock(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\}`))?.[0] || "";
}

describe("app layout structure", () => {
  it("loads analytics from environment without hardcoding a website id", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../../../index.html"), "utf8");

    expect(html).toContain("window.gptSwitchAnalyticsBeforeSend");
    expect(html).toContain("import.meta.env.VITE_ANALYTICS_WEBSITE_ID");
    expect(html).toContain("import.meta.env.VITE_ANALYTICS_SCRIPT_URL");
    expect(html).toContain('script.setAttribute("data-website-id", analyticsWebsiteId)');
    expect(html).not.toMatch(/data-website-id="[0-9a-f-]{36}"/);
    expect(html).not.toMatch(new RegExp(`https://${["cloud", "um" + "ami", "is"].join("\\.")}/script\\.js`));
    expect(html).toContain('script.setAttribute("data-auto-pageview", "false")');
    expect(html).toContain('script.setAttribute("data-before-send", "gptSwitchAnalyticsBeforeSend")');
    expect(html).toContain('url: "/desktop"');
    expect(html).toContain('title: "GPT Switch Desktop"');
    expect(html).toContain('referrer: ""');
  });

  it("tracks desktop button clicks and results with prefixed Chinese event names", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");

    expect(appSource).toContain("formatAnalyticsEventName");
    expect(appSource).toContain('trackAnalyticsEvent(formatAnalyticsEventName("desktop", eventName, trigger), {');
    expect(appSource).toContain('"桌面端启动"');
    expect(appSource).toContain('trackDesktopEvent("应用配置"');
    expect(appSource).toContain('trackDesktopEvent("应用配置成功"');
    expect(appSource).toContain('trackDesktopEvent("应用配置失败"');
    expect(appSource).toContain('trackDesktopEvent("编辑配置"');
    expect(appSource).toContain('trackDesktopEvent("新增配置"');
    expect(appSource).toContain('trackDesktopEvent("保存配置"');
    expect(appSource).toContain('trackDesktopEvent("保存配置成功"');
    expect(appSource).toContain('trackDesktopEvent("保存配置失败"');
    expect(appSource).toContain('trackDesktopEvent("取消编辑"');
    expect(appSource).toContain('trackDesktopEvent("删除配置"');
    expect(appSource).toContain('trackDesktopEvent("确认删除配置"');
    expect(appSource).toContain('trackDesktopEvent("删除配置成功"');
    expect(appSource).toContain('trackDesktopEvent("删除配置失败"');
    expect(appSource).toContain('trackDesktopEvent("重置配置"');
    expect(appSource).toContain('trackDesktopEvent("重置配置成功"');
    expect(appSource).toContain('trackDesktopEvent("重置配置失败"');
    expect(appSource).toContain('trackDesktopEvent("打开设置"');
    expect(appSource).toContain('trackDesktopEvent("切换深色模式"');
    expect(appSource).toContain('trackDesktopEvent("切换浅色模式"');
    expect(appSource).toContain('trackDesktopEvent("切换中文"');
    expect(appSource).toContain('trackDesktopEvent("切换英文"');
    expect(appSource).toContain('trackDesktopEvent("打开配置目录"');
    expect(appSource).toContain('trackDesktopEvent("切换网格视图"');
    expect(appSource).toContain('trackDesktopEvent("切换列表视图"');
    expect(appSource).toContain('trackDesktopEvent("打开更新链接"');
  });

  it("sends anonymous desktop online heartbeats separately from web stats", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");

    expect(appSource).toContain('const DESKTOP_DEVICE_STORAGE_KEY = "gpt-switch-desktop-device-id"');
    expect(appSource).toContain("function readOrCreateDesktopDeviceId()");
    expect(appSource).toContain("function sendDesktopHeartbeat");
    expect(appSource).toContain('"/api/stats/desktop/heartbeat"');
    expect(appSource).toContain("device_id: readOrCreateDesktopDeviceId()");
    expect(appSource).toContain("setInterval(sendDesktopHeartbeat, 60 * 1000)");
    expect(appSource).toContain("hasNativeAiModel()");
  });

  it("uses one centered titlebar with global actions", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const topbar = appSource.match(/<header className="topbar">[\s\S]*?<\/header>/)?.[0] || "";

    expect(appSource).toContain("shellClassNameForUserAgent(userAgent)");
    expect(topbar).toContain('className="titlebar-title"');
    expect(topbar).toContain('className="topbar-actions"');
    expect(appSource).not.toContain('className="product-name"');
  });

  it("keeps the clickable client version in settings and uses the titlebar only for update reminders", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const topbar = appSource.match(/<header className="topbar">[\s\S]*?<\/header>/)?.[0] || "";
    const settingsMenu = appSource.match(/const settingsMenu: MenuProps = \{[\s\S]*?\n  \};/)?.[0] || "";
    const titlebar = cssBlock(cssSource, ".titlebar-title");
    const updateBadge = cssBlock(cssSource, ".update-badge");

    expect(mainSource).toContain("loadServerVersionForDisplay");
    expect(mainSource).toContain("serverVersion");
    expect(appSource).toContain("updateNoticeForVersions");
    expect(appSource).toContain("updateNotice");
    expect(appSource).not.toContain("state.serverVersionUpdateUrl");
    expect(appSource).not.toContain("state.serverVersionDownloads");
    expect(appSource).toContain('"/api/downloads/v1/latest"');
    expect(appSource).toContain("clientDownloadPlatformForUserAgent");
    expect(appSource).toContain("checkForUpdate");
    expect(appSource).toContain("runtime.openExternal");
    expect(settingsMenu).toContain('key: "app-version"');
    expect(settingsMenu).toContain("`v${state.version}`");
    expect(settingsMenu).not.toContain("disabled: true");
    expect(topbar).not.toContain("state?.version");
    expect(topbar).not.toContain('className="version-badge"');
    expect(topbar).toContain('className="update-badge"');
    expect(topbar).toContain('checkForUpdate("badge")');
    expect(topbar).not.toContain("v{state.serverVersion}");
    expect(titlebar).toContain("gap:");
    expect(cssSource).not.toContain(".version-badge");
    expect(updateBadge).toContain("color:");
  });

  it("configures Electron to overlay Windows controls inside the titlebar", () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");

    expect(mainSource).toMatch(/process\.platform === "win32"[\s\S]*\? "hidden"/);
    expect(mainSource).toContain("titleBarOverlay");
    expect(mainSource).toContain('height: 48');
  });

  it("uses the shared GPT Switch icon for the Electron window", () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");

    expect(mainSource).toContain("const appIconPath =");
    expect(mainSource).toContain('path.join(__dirname, "..", "..", "build", "icon.png")');
    expect(mainSource).toContain("icon: appIconPath");
  });

  it("avoids showing a blank startup window before the renderer is ready", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../../../index.html"), "utf8");
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const rendererMainSource = fs.readFileSync(path.resolve(__dirname, "../main.tsx"), "utf8");
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");

    expect(mainSource).toContain("show: false");
    expect(mainSource).toContain("paintWhenInitiallyHidden: true");
    expect(mainSource).toContain('mainWindow.once("ready-to-show"');
    expect(mainSource).toContain("mainWindow.show()");
    expect(html).toContain('id="boot-screen"');
    expect(html).toContain('class="boot-screen"');
    expect(html).toContain('class="boot-icon"');
    expect(html).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(html).toContain("document.documentElement.dataset.theme = theme");
    expect(html).toContain('html[data-theme="dark"]');
    expect(html).toContain("@keyframes boot-pulse");
    expect(rendererMainSource).toContain('document.getElementById("boot-screen")?.remove()');
    expect(mainSource).toContain("function nativeWindowThemeColors");
    expect(mainSource).toContain("nativeTheme.shouldUseDarkColors");
    expect(mainSource).toContain("backgroundColor: windowThemeColors.backgroundColor");
    expect(appSource).toContain("useLayoutEffect");
    expect(appSource).toContain("useLayoutEffect(() => {");
    expect(appSource).toContain("function readInitialThemeMode");
    expect(appSource).toContain('window.matchMedia?.("(prefers-color-scheme: dark)")');
    expect(appSource).toContain("function StartupScreen");
    expect(appSource).toContain("<StartupScreen />");
    expect(cssBlock(cssSource, "html")).toContain("background: var(--page-bg)");
    expect(cssBlock(cssSource, "#root")).toContain("background: var(--page-bg)");
    expect(cssSource).toContain(".startup-screen");
    expect(cssBlock(cssSource, ".startup-screen")).toContain("position: fixed");
    expect(cssBlock(cssSource, ".startup-screen")).toContain("inset: 0");
    expect(cssBlock(cssSource, ".startup-screen")).toContain("min-height: 100vh");
    expect(cssBlock(cssSource, ".startup-screen")).toContain("z-index: 1");
    expect(cssSource).toContain("animation: boot-pulse");
  });

  it("centers macOS traffic lights inside the custom titlebar", () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");

    expect(mainSource).toContain("trafficLightPosition");
    expect(mainSource).toMatch(/process\.platform === "darwin"[\s\S]*\{ x: 18, y: 18 \}/);
  });

  it("reserves right-side titlebar space for Windows window controls", () => {
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const topbar = cssBlock(cssSource, ".topbar");
    const windowsTopbar = cssBlock(cssSource, ".app-shell.is-windows .topbar");
    const topbarActions = cssBlock(cssSource, ".topbar-actions");

    expect(topbar).toContain("height: 48px");
    expect(windowsTopbar).toContain("padding-right: var(--window-control-space)");
    expect(topbarActions).toContain("grid-column: 3");
  });

  it("replaces titlebar sync and restart actions with reset confirmation", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const topbar = appSource.match(/<header className="topbar">[\s\S]*?<\/header>/)?.[0] || "";
    const settingsMenu = appSource.match(/const settingsMenu: MenuProps = \{[\s\S]*?\n  \};/)?.[0] || "";
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const preloadSource = fs.readFileSync(path.resolve(__dirname, "../../main/preload.ts"), "utf8");
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");
    const globalTypes = fs.readFileSync(path.resolve(__dirname, "../global.d.ts"), "utf8");
    const resetButton = cssBlock(cssSource, ".reset-button.ant-btn-text");

    expect(appSource).toContain("ReloadOutlined");
    expect(appSource).toContain("Tooltip");
    expect(appSource).toContain("function confirmReset");
    expect(appSource).toContain('title={t("resetTooltip")}');
    expect(appSource).toContain('className="reset-button"');
    expect(appSource).toContain("onClick={confirmReset}");
    expect(appSource).toContain('title: t("resetTitle")');
    expect(appSource).toContain('content: t("resetContent")');
    expect(appSource).toContain('okText: t("resetConfirm")');
    expect(appSource).toContain("getAiModel(t).profiles.reset()");
    expect(topbar).not.toContain('className="sync-button"');
    expect(topbar).not.toContain('className="restart-button"');
    expect(resetButton).toContain("height: 32px");
    expect(settingsMenu).not.toContain('key: "restart"');
    expect(settingsMenu).not.toContain('key: "sync"');
    expect(preloadSource).toContain('reset: () => ipcRenderer.invoke("profiles:reset")');
    expect(mainSource).toContain('ipcMain.handle("profiles:reset"');
    expect(mainSource).toContain("resetCodexConfiguration");
    expect(globalTypes).toContain("reset(): Promise");
  });

  it("shows the config folder action in the profile modal instead of settings", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const profileModal = appSource.match(/function ProfileModal[\s\S]*?function AppContent/)?.[0] || "";
    const settingsMenu = appSource.match(/const settingsMenu: MenuProps = \{[\s\S]*?\n  \};/)?.[0] || "";

    expect(appSource).toContain("FolderOpenOutlined");
    expect(profileModal).toContain('className="modal-footer-left"');
    expect(profileModal).toContain('className="open-config-dir-button"');
    expect(profileModal).toContain("getAiModel(t).runtime.openCodexDir()");
    expect(profileModal).toContain('trackDesktopEvent("打开配置目录"');
    expect(settingsMenu).not.toContain('key: "open-dir"');
    expect(cssSource).toContain(".modal-footer-left");
    expect(cssBlock(cssSource, ".open-config-dir-button.ant-btn-text")).toContain("height: 32px");
  });

  it("adds a persisted Chinese and English language switch in settings", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");

    expect(appSource).toContain("LANGUAGE_STORAGE_KEY");
    expect(appSource).toContain("setLanguage");
    expect(appSource).toContain('key: "zh-CN"');
    expect(appSource).toContain('key: "en-US"');
    expect(appSource).toContain("locale={antdLocale}");
  });

  it("keeps only view controls in the main toolbar", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const toolbarTools = cssBlock(cssSource, ".toolbar-tools");
    const createButton = cssBlock(cssSource, ".create-button.ant-btn");
    const segmented = cssBlock(cssSource, ".view-segmented.ant-segmented");
    const segmentedLabel = cssBlock(cssSource, ".view-segmented .ant-segmented-item-label");

    expect(appSource).toContain('className="toolbar-tools"');
    expect(appSource).not.toContain('placeholder="搜索配置..."');
    expect(appSource).not.toContain("SearchOutlined");
    expect(toolbarTools).toContain("display: flex");
    expect(createButton).toContain("height: 40px");
    expect(createButton).toContain("font-size: 14px");
    expect(segmented).toContain("padding: 3px");
    expect(segmentedLabel).toContain("min-height: 30px");
  });

  it("aligns renderer theme colors with the website palette without changing layout", () => {
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const lightTokens = cssBlock(cssSource, ":root");
    const darkTokens = cssBlock(cssSource, ':root[data-theme="dark"]');
    const topbar = cssBlock(cssSource, ".topbar");
    const primaryButtons = cssBlock(
      cssSource,
      ".action-bar .ant-btn-primary,\n.config-card-actions .ant-btn-primary,\n.modal-footer-actions .ant-btn-primary",
    );
    const segmentedSelected = cssBlock(cssSource, ".view-segmented .ant-segmented-item-selected");

    expect(lightTokens).toContain("--window-bg: #ffffff");
    expect(lightTokens).toContain("--page-bg: #ffffff");
    expect(lightTokens).toContain("--primary: #E32A4B");
    expect(lightTokens).toContain("--primary-hover: #C21B38");
    expect(darkTokens).toContain("--window-bg: #000000");
    expect(darkTokens).toContain("--page-bg: #000000");
    expect(darkTokens).toContain("--card-bg: #0A0A0A");
    expect(darkTokens).toContain("--field-bg: #0A0A0A");
    expect(darkTokens).toContain("--primary: #E32A4B");
    expect(darkTokens).toContain("--primary-hover: #C21B38");
    expect(topbar).toContain("background: var(--window-bg)");
    expect(primaryButtons).toContain("background: var(--primary)");
    expect(primaryButtons).toContain("border-color: var(--primary)");
    expect(segmentedSelected).toContain("background: var(--primary)");
    expect(cssSource).not.toContain("#5c89fa");
    expect(cssSource).not.toContain("#6d96f7");
    expect(cssSource).not.toContain("#4a71dd");
    expect(cssSource).not.toContain("#7aa2ff");
  });

  it("aligns Ant Design and Electron shell colors with the website palette", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");
    const antdTokensSource = appSource.match(/function antdTokens[\s\S]*?function editableNote/)?.[0] || "";

    expect(antdTokensSource).toContain('colorPrimary: "#E32A4B"');
    expect(antdTokensSource).toContain('colorPrimaryHover: "#C21B38"');
    expect(antdTokensSource).toContain('colorBgLayout: dark ? "#000000" : "#ffffff"');
    expect(antdTokensSource).toContain('colorBgContainer: dark ? "#0A0A0A" : "#ffffff"');
    expect(antdTokensSource).toContain('colorBgElevated: dark ? "#0A0A0A" : "#ffffff"');
    expect(antdTokensSource).toContain('colorBorder: dark ? "#1F1F1F" : "#e5e7eb"');
    expect(antdTokensSource).toContain('itemSelectedBg: "#E32A4B"');
    expect(antdTokensSource).toContain('trackBg: dark ? "#0A0A0A" : "#ffffff"');
    expect(mainSource).toContain('backgroundColor: "#ffffff"');
    expect(appSource).not.toContain("#5c89fa");
    expect(appSource).not.toContain("#6d96f7");
    expect(appSource).not.toContain("#4a71dd");
    expect(appSource).not.toContain("#7aa2ff");
  });

  it("keeps the original compact three-column profile grid", () => {
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const grid = cssBlock(cssSource, ".config-grid.is-grid");
    const actions = cssBlock(cssSource, ".config-card-actions");

    expect(grid).toContain("repeat(3, minmax(0, 1fr))");
    expect(grid).not.toContain("auto-fill");
    expect(grid).not.toContain("auto-fit");
    expect(actions).toContain("grid-template-columns: 1fr 1fr");
  });

  it("keeps apply and edit as the two card actions for every profile state", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const profileCard = appSource.match(/function ProfileCard[\s\S]*?function ProfileModal/)?.[0] || "";

    expect(profileCard).toContain('className={`state-badge is-${text.statusTone}`}');
    expect(profileCard).toMatch(/<Button[\s\S]*?block[\s\S]*?onClick=\{onApply\}/);
    expect(profileCard).not.toContain("disabled={!text.canApply}");
    expect(profileCard).not.toContain("!profile.isActive &&");
    expect(profileCard).not.toContain("profileDetailRows");
  });

  it("shows a toast instead of applying when an official profile is missing its key", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const applyFunction = appSource.match(/async function apply[\s\S]*?async function remove/)?.[0] || "";

    expect(applyFunction).toContain('message.warning(t("apiKeyMissingToast"), 2)');
    expect(applyFunction).toContain('reason: "missing_api_key"');
    expect(applyFunction.indexOf("readOfficialApiKey(profile.id)")).toBeLessThan(
      applyFunction.indexOf("latestState = await refresh()"),
    );
    expect(applyFunction.indexOf('message.warning(t("apiKeyMissingToast"), 2)')).toBeLessThan(
      applyFunction.indexOf("profiles.apply"),
    );
  });

  it("blocks profile apply when an update is required", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const applyFunction = appSource.match(/async function apply[\s\S]*?async function remove/)?.[0] || "";

    expect(appSource).toContain("applyUpdateBlockForVersions");
    expect(appSource).toContain("showApplyUpdateBlock");
    expect(applyFunction).toContain("const cachedUpdateBlock = hasNativeAiModel()");
    expect(applyFunction).toContain("sourceState.version");
    expect(applyFunction).toContain("sourceState.serverVersion");
    expect(applyFunction).toContain("if (cachedUpdateBlock)");
    expect(applyFunction).toContain("latestState = await refresh()");
    expect(applyFunction).toContain("const updateBlock = hasNativeAiModel() && latestState");
    expect(applyFunction).toContain("applyUpdateBlockForVersions(");
    expect(applyFunction).toContain("if (updateBlock)");
    expect(applyFunction).toContain("return null");
    expect(applyFunction.indexOf("cachedUpdateBlock")).toBeLessThan(
      applyFunction.indexOf("setApplyingId(profile.id)"),
    );
    expect(applyFunction.indexOf("latestState = await refresh()")).toBeLessThan(
      applyFunction.lastIndexOf("applyUpdateBlockForVersions"),
    );
    expect(applyFunction.lastIndexOf("applyUpdateBlockForVersions")).toBeLessThan(
      applyFunction.indexOf("profiles.apply"),
    );
  });

  it("does not pre-validate external update links in the app shell", () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, "../../main/main.ts"), "utf8");
    const openExternalFunction =
      mainSource.match(/function openExternal[\s\S]*?function asErrorResult/)?.[0] || "";

    expect(openExternalFunction).not.toContain("new URL");
    expect(openExternalFunction).not.toContain("unsupported external url");
    expect(openExternalFunction).toContain("shell.openExternal(rawUrl)");
  });

  it("keeps the profile modal focused on GPT account raw files without advanced preview", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const cssSource = fs.readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
    const profileForm = cssBlock(cssSource, ".profile-form");
    const profileInputs = cssBlock(cssSource, ".profile-form :is(.ant-input, .ant-input-password, .ant-select-selector)");

    expect(appSource).toContain('configMode: "chatgpt"');
    expect(appSource).toContain('name="configToml"');
    expect(appSource).toContain('name="authJson"');
    expect(appSource).not.toContain('name="configMode"');
    expect(appSource).not.toContain('className="mode-segmented"');
    expect(cssSource).not.toContain(".mode-segmented");
    expect(appSource).not.toContain('label={t("endpointUrl")}');
    expect(appSource).not.toContain('label={t("modelName")}');
    expect(appSource).not.toContain('name="baseUrl"');
    expect(appSource).not.toContain('name="providerId"');
    expect(appSource).not.toContain("autoProviderId");
    expect(appSource).not.toContain("Collapse");
    expect(appSource).not.toContain("previewConfig");
    expect(cssSource).not.toContain(".advanced-preview");
    expect(cssSource).not.toContain(".config-preview");
    expect(profileForm).toContain("font-size: 13px");
    expect(profileInputs).toContain("font-size: 13px");
  });

  it("uses monotonic sync progress instead of modulo-based progress", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");

    expect(appSource).toContain("nextSyncProgressPercent");
    expect(appSource).not.toContain("processed %");
  });

  it("shows apply sync progress immediately and keeps the done state visible briefly", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    const applyFunction = appSource.match(/async function apply[\s\S]*?async function remove/)?.[0] || "";
    const syncLine = appSource.match(/\{syncProgress[\s\S]*?<section className="config-area">/)?.[0] || "";

    expect(appSource).toContain("initialSyncProgress");
    expect(appSource).toContain("SYNC_PROGRESS_DONE_HOLD_MS");
    expect(applyFunction).toContain("showInitialSyncProgress(profile.id)");
    expect(applyFunction.indexOf("setApplyingId(profile.id)")).toBeLessThan(
      applyFunction.indexOf("latestState = await refresh()"),
    );
    expect(applyFunction.indexOf("showInitialSyncProgress(profile.id)")).toBeLessThan(
      applyFunction.indexOf("latestState = await refresh()"),
    );
    expect(applyFunction).toContain("clearSyncProgressAfterDelay()");
    expect(applyFunction).not.toContain("setSyncProgressView(null);\n    }");
    expect(syncLine).not.toContain('syncProgress.phase !== "done"');
  });
});
