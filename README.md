# @sockudo/client

Modernized `pusher-js`-compatible client for Sockudo.

This package keeps the familiar Pusher client API while shipping modern runtime targets:
- Web
- Node.js
- Web Worker
- React Native

## Install

```bash
npm install @sockudo/client
```

or

```bash
bun add @sockudo/client
```

## Runtime Imports

Use the entrypoint that matches your runtime:

```ts
// Browser / default
import Pusher from "@sockudo/client";

// Filter helper entrypoint
import { Filter } from "@sockudo/client/filter";

// With encryption
import PusherEncrypted from "@sockudo/client/with-encryption";

// Worker
import WorkerPusher from "@sockudo/client/worker";

// Worker with encryption
import WorkerEncrypted from "@sockudo/client/worker/with-encryption";

// React Native
import ReactNativePusher from "@sockudo/client/react-native";
```

The package also exposes runtime-aware fields in `package.json` (`main`, `browser`, `react-native`, `exports`) so bundlers can resolve correctly.

## Quick Start

```ts
import Pusher from "@sockudo/client";

const pusher = new Pusher("app-key", {
  wsHost: "your-sockudo-host",
  wsPort: 6001,
  wssPort: 6001,
  forceTLS: true,
  enabledTransports: ["ws", "wss"],
});

const channel = pusher.subscribe("public-updates");
channel.bind("message", (payload: unknown) => {
  console.log(payload);
});
```

## Features

- Pusher-compatible client surface
- WebSocket-first connection strategy
- Fetch-first auth/timeline integrations
- ESM-first package outputs
- Runtime-specific builds for web/node/worker/react-native

## React Native Notes

- React Native build output is `dist/react-native/pusher.js`
- Package exposes both:
  - root `react-native` resolution
  - explicit `@sockudo/client/react-native` subpath
- `@react-native-community/netinfo` is an optional peer dependency

## Development

### Requirements

- Bun `>=1.0.0`
- Node.js `>=22`

### Commands

```bash
# typecheck + lint + tests
bun run check

# typecheck only
bun run typecheck

# lint
bun run lint

# format
bun run format
bun run format:check

# tests
bun test
bun run test:watch

# builds
bun run build
bun run build:all
```

## Release Process

This repo uses GitHub Actions for CI/CD and changelogs.

### CI

- Workflow: `.github/workflows/ci.yml`
- Runs on push to `main` and pull requests
- Executes:
  - `bun run check`
  - `bun run build:all`

### Changelog + Versioning

- Workflow: `.github/workflows/release-please.yml`
- Uses Release Please to open/update a Release PR
- Generates and updates:
  - `CHANGELOG.md`
  - `package.json` version
  - git tag on release merge

### npm Publish

- Workflow: `.github/workflows/publish-npm.yml`
- Triggers on:
  - `release.published`
  - manual dispatch
- Publishes `@sockudo/client` with npm provenance

Required repo secret:
- `NPM_TOKEN`

## Repository

- GitHub: `https://github.com/sockudo/sockudo-js`
- npm: `https://www.npmjs.com/package/@sockudo/client`
