import { listProfiles, profileKey, type Vault } from "../../cli/lib/vault";
import { DEFAULT_PROFILE } from "../credentials";

export interface SlackCredential {
  botToken: string;
  /** App-level token (xapp-...) used to open a Socket Mode connection. */
  appToken: string;
  /** Channel approval requests are posted to — operator-configured, never chosen per-call. */
  channel: string;
}

/**
 * Resolves Slack credentials the same way `loadAccessKeyCredentials` does
 * for AWS: every profile out of an already-unlocked vault, or a single
 * "default" profile from env vars when no vault exists at all. Kept
 * Slack-specific (rather than folded into the AWS helper) since the shape
 * — bot token + app token + a default channel — isn't an access-key pair.
 */
export async function loadSlackCredentials(
  vault: Vault | undefined,
): Promise<Map<string, SlackCredential>> {
  const credentials = new Map<string, SlackCredential>();

  if (vault) {
    for (const profile of await listProfiles("slack")) {
      const credential = vault.get<SlackCredential>(
        profileKey("slack", profile),
      );
      if (credential) credentials.set(profile, credential);
    }
    return credentials;
  }

  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const channel = process.env.SLACK_APPROVAL_CHANNEL;
  if (botToken && appToken && channel) {
    credentials.set(DEFAULT_PROFILE, { botToken, appToken, channel });
  }
  return credentials;
}
