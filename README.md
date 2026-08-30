# GPT Switch Desktop

GPT Switch Desktop is an open-source Electron client for switching Codex/ChatGPT provider configurations and keeping local Codex conversation metadata usable across providers.

## Features

- Switch between official and custom model providers.
- Write Codex-compatible `config.toml`, `auth.json`, and model catalog files.
- Sync Codex thread visibility and rollout metadata after provider changes.
- Repair known legacy thread-history projection gaps when they are safe to fix.
- Check for app updates and open the platform-specific download link returned by a catalog service.
- Optionally send anonymous product analytics when analytics environment variables are configured.

## What Is Not Included

This repository only contains the desktop client. It does not include the private catalog service, signing keys, release infrastructure, official download acceleration, or production deployment secrets.

Official builds may use a hosted catalog service for provider lists, version checks, download links, and anonymous online statistics. Self-built clients can point at another compatible service.

## Development

Requirements:

- Node.js 20+
- pnpm 10+

Install dependencies:

```bash
pnpm install
```

Run the desktop app in development:

```bash
pnpm dev
```

Run tests:

```bash
pnpm test
```

Installer builds load `.env` and `.env.local`, then write the selected `GPT_SWITCH_SERVER_BASE` into `dist/main/build-config.json` so packaged app launches can reach the configured catalog service without a shell environment.

Build renderer and main-process code:

```bash
pnpm run build
```

Build installers:

```bash
pnpm run build:mac
pnpm run build:win
```

Unsigned local builds are useful for development. Production distribution should use proper macOS notarization and Windows code signing.

## Catalog Service

No hosted catalog service is hardcoded in source. Without a configured catalog service, the app still starts and shows an empty official catalog/version state, while custom local profiles remain usable.

For local development, put real values in the ignored `.env.local` file:

```text
GPT_SWITCH_SERVER_BASE=
```

You can also override it when launching Electron:

```bash
GPT_SWITCH_SERVER_BASE=https://catalog.example.com pnpm dev
```

The client expects compatible endpoints for provider catalog data, version checks, and dynamic platform downloads:

- `GET /api/catalog/v1/providers`
- `GET /api/catalog/v1/version` returns `{ "success": true, "version": "x.y.z" }`.
- `GET /api/downloads/v1/latest?platform=windows|macos` returns the current platform package URL.

## Privacy

The client stores provider configuration locally and writes Codex configuration files on the user's machine. API keys should never be committed to this repository.

Anonymous analytics are disabled unless both values are provided at build/dev time:

```text
VITE_ANALYTICS_SCRIPT_URL=
VITE_ANALYTICS_WEBSITE_ID=
```

Vite embeds `VITE_*` values into the built client, so keep real values in `.env.local` or CI/release secrets, not in source files.

## License

MIT
