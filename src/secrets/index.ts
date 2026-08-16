import { rdsPasswordSecret } from "./rds-password";
import { sshBastionKeySecret } from "./ssh-bastion-key";
import type { SecretPlugin } from "./plugin";

/**
 * Every secret governor knows how to store. This is the one place a new
 * secret gets wired in — implement `SecretPlugin` in `secrets/<name>.ts`
 * and add it here; `cli/commands/store.ts` works generically off this list.
 */
export const SECRET_PLUGINS: SecretPlugin[] = [
  rdsPasswordSecret,
  sshBastionKeySecret,
];

export function findSecretPlugin(id: string): SecretPlugin | undefined {
  return SECRET_PLUGINS.find((s) => s.id === id);
}
