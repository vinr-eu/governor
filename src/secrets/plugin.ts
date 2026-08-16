import type { ParsedArgs } from "../cli/lib/flags";

/**
 * The contract every secret implements to plug into `governor store`.
 * Mirrors `ProviderPlugin` (`providers/plugin.ts`) but for one-off values
 * scoped to a specific resource rather than a whole service's credentials —
 * store.ts only ever talks to secrets through this interface, so adding one
 * means implementing it and adding one entry to `SECRET_PLUGINS` in
 * `secrets/index.ts`, no other file changes. Store-only by design: there is
 * no `get`, values only ever flow into the vault, never back out through
 * the CLI.
 */
export interface SecretPlugin {
  id: string;
  /** Positional-args usage shown after `governor store <id>`, e.g. "<db-identifier> <db-user>". */
  usage: string;

  /** Prompt for/validate the value and write it into the vault. */
  store(args: string[], flags: ParsedArgs["flags"]): Promise<void>;
}
