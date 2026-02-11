# sockudo-js-next

Top-level full port of the legacy Sockudo/Pusher-compatible client onto a modern stack.
This package is browser-first.

## Stack

- Runtime: Bun-first workflow, Node.js supported
- Bundler: Vite API with Rolldown backend (`rolldown-vite`)
- Lint/format: `oxlint` + `oxfmt`
- Transport runtime: native `WebSocket` + fetch-first auth/timeline (no `faye-websocket`)
- Connection strategy: WebSocket-first (`ws/wss`) without legacy SockJS/XHR/XDR fallback chain
- Packaging: ESM-only outputs (no CommonJS)

## Install

```bash
bun install
```

## Commands

```bash
bun run check
bun run typecheck
bun run lint
bun test
bun run build
bun run build:all
```

## Notes

- This project is the **new repo at the current directory**.
- The nested `./sockudo-js` repo is treated as source reference and is not modified in this step.
