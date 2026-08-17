Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Governor conventions

- **Logging**: use the shared logger (`src/cli/lib/logger.ts`, wraps `consola`) — never `console.*`. Use `.log()` only for script-parseable output (`--version`, help text); use `.info`/`.success`/`.error` for status and result messages.
- **CLI parsing**: parse subcommand args with `parseFlags()` from `src/cli/lib/flags.ts` (`--flag value` / bare `--flag` boolean style, returns `{ args, flags }`). New subcommands live in `src/cli/commands/<name>.ts` and are wired into the switch in `src/cli/index.ts`. Commands must set `process.exitCode = 1` on any failure, including "not implemented yet" — never exit 0 without having done the thing.
- **Secrets**: never write plaintext credential files, and never commit them. Local persistence goes through `src/cli/lib/vault.ts` — a password-encrypted vault (AES-256-GCM, scrypt-derived key) at `.governor/vault.enc`, created by `governor init` and unlocked with a master password (prompted via `src/cli/lib/prompt.ts`, backed by `prompts`). We deliberately moved off OS keychains (macOS Keychain/Linux Secret Service/Windows DPAPI): all three gate access by OS _user_, not by calling _process_, so we verified empirically that a shell an agent controls can read them exactly as easily as governor can. The vault's guarantee instead rests on the master password never being written anywhere — typed fresh into governor's own prompt, never handed to an agent. In non-interactive contexts (no TTY — e.g. CI), `governor serve` reads the password from `GOVERNOR_MASTER_PASSWORD` instead of prompting. If no vault exists at all, fall back to reading credentials straight from environment variables using the provider's standard names (e.g. `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`). Credentials are decrypted once per `governor serve` process and held only in its memory — agents call its HTTP endpoints and get results back, never raw key material.
- **Runtimes**: vault operations must fail with a clear message (wrong password, missing vault, missing `GOVERNOR_MASTER_PASSWORD` in non-interactive contexts) rather than silently returning something empty. `governor serve` only falls back to plain env vars when no vault exists at all — never silently ignores a vault that failed to unlock. When testing prompt-driven commands non-interactively, pipe input through a real pty (e.g. `script -q /dev/null`) with small delays between answers — `prompts` can hang or abort on a plain unpaced pipe, which is a testing artifact, not a bug in the command.
- **Vault crypto: single derived key, not envelope encryption.** `vault.ts` derives one scrypt key straight from the master password (`kdf` field, self-describing per vault so params can be strengthened later without breaking old vaults) and uses it to encrypt every entry directly. It deliberately does not split into a KMS-style data-encryption-key/key-encryption-key pair, which is what the [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) recommends. That pattern pays for itself when many keys need centralized rotation/revocation through a KMS; for a single local file holding one operator's credentials, it's added moving parts without a matching benefit. Explicitly rejected — don't add it without a concrete reason (e.g., a multi-tenant vault) to revisit. `governor rotate-password` covers the actual risk this guards against (a compromised master password): it re-derives a fresh key under a new password, re-encrypts every entry in place, and upgrades the vault's `kdf` params to current as a side effect.
- **Docs stay in sync with code, every change.** Every MCP tool is documented in `docs/tools/<service>.md` (params, example call/response, error shapes) and indexed from `docs/README.md`; the top-level `README.md`'s CLI reference and tool table are the other user-facing summaries. Any change to a tool's parameters, behavior, auth requirements, or response shape — and any new tool or CLI command — must update the matching doc(s) in the same change, not as a follow-up. Verify examples against the actual Zod schema/return type instead of guessing.
- **Never run governor as a separate OS service/service-account for credential isolation.** We considered this deliberately: OS credential stores (macOS Keychain, Linux Secret Service/D-Bus, Windows Credential Manager/DPAPI) only protect against a different user or offline disk theft — none of them isolate one process from another process running as the _same_ user, so a real agent-vs-governor boundary would require running governor under its own service account (launchd/systemd/Windows service) with the agent talking to it over a socket. That's a real, kernel-enforced guarantee, but it turns `governor serve` from "a command you run" into "infrastructure you install," differently on every OS. Explicitly rejected as too heavy — do not propose or implement it. The vault above is the answer we went with instead: it gets an equivalent guarantee from a password the agent never sees, with no service-account install step.
