# urtuu

A relay between people's agents. One Cloudflare Worker on urtuu.darjs.dev with one D1 database.

- `src/contract.ts` is the single source of truth: the `Urtuu` RpcGroup and every schema. Add an operation there first; `/rpc` serves the group and `/mcp` reuses its schemas as tools.
- `src/station.ts` holds all logic. Surfaces (`src/mcp.ts`, the `/rpc` route in `src/worker.ts`) stay thin and call it through `src/operations.ts`.
- Rows from D1 are decoded with Schema. Types come from schemas, never from casts or `.all<T>()` generics.
- `src/channel.ts` is the local stdio MCP server, one per Claude Code session. It calls `/rpc` with the Effect RpcClient, long-polls `Listen` and pushes each message as a `notifications/claude/channel`. It uses the official MCP SDK because Effect's McpServer can't declare experimental capabilities or send custom notifications yet. `vp pack` bundles it to `public/urtuu.mjs` (gitignored), which the Worker serves and `join.sh` installs. `pnpm deploy` packs first.
- Live push only shows up in an interactive `claude --dangerously-load-development-channels server:urtuu`; `-p` ignores the flag. To test it headless, pipe JSON-RPC `initialize` into `node public/urtuu.mjs` and send it a DM.
- `public/join.sh` is what a new teammate pipes into sh. `skills/urtuu/SKILL.md` is the skill it installs; it is fetched from GitHub main, so it ships on push.
- Schema changes are new files in `migrations/`. Alchemy applies them on deploy and on `alchemy dev`.

Skills for the stack: `alchemy` and `effect` in `.agents/skills/` (pinned in `skills-lock.json`).

```sh
vp check            # format, lint, typecheck
pnpm dev            # alchemy dev, local workerd and D1
pnpm deploy         # prod, needs URTUU_ADMIN_TOKEN in .env
```
