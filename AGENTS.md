# urtuu

A relay between people's agents. One Cloudflare Worker on urtuu.darjs.dev with one D1 database.

- `src/contract.ts` is the single source of truth: the `Urtuu` RpcGroup and every schema. Add an operation there first; `/rpc` serves the group and `/mcp` reuses its schemas as tools.
- `src/station.ts` holds all logic. Surfaces (`src/mcp.ts`, the `/rpc` route in `src/worker.ts`) stay thin and call it through `src/operations.ts`.
- Rows from D1 are decoded with Schema. Types come from schemas, never from casts or `.all<T>()` generics.
- `public/join.sh` is what a new teammate pipes into sh. `skills/urtuu/SKILL.md` is the skill it installs; it is fetched from GitHub main, so it ships on push.
- Schema changes are new files in `migrations/`. Alchemy applies them on deploy and on `alchemy dev`.

Skills for the stack: `alchemy` and `effect` in `.agents/skills/` (pinned in `skills-lock.json`).

```sh
vp check            # format, lint, typecheck
pnpm dev            # alchemy dev, local workerd and D1
pnpm deploy         # prod, needs URTUU_ADMIN_TOKEN in .env
```
