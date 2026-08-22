import { DEFAULT_PROFILE } from "../providers/credentials";
import { logger } from "../cli/lib/logger";
import { promptPassword, promptText } from "../cli/lib/prompt";
import { profileKey, Vault, vaultExists } from "../cli/lib/vault";
import type { SecretPlugin } from "./plugin";

const BOT_TOKEN_PATTERN = /^xoxb-/;
const APP_TOKEN_PATTERN = /^xapp-/;

export const slackCredentialSecret: SecretPlugin = {
  id: "slack-credential",
  usage:
    "--channel value [--profile name] [--bot-token value] [--app-token value]",

  async store(_args, flags) {
    const profileFlag = flags.profile;
    if (profileFlag !== undefined && typeof profileFlag !== "string") {
      logger.error("--profile requires a value.");
      process.exitCode = 1;
      return;
    }
    const profile = profileFlag ?? DEFAULT_PROFILE;

    const botTokenFlag = flags["bot-token"];
    if (botTokenFlag !== undefined && typeof botTokenFlag !== "string") {
      logger.error("--bot-token requires a value.");
      process.exitCode = 1;
      return;
    }

    const appTokenFlag = flags["app-token"];
    if (appTokenFlag !== undefined && typeof appTokenFlag !== "string") {
      logger.error("--app-token requires a value.");
      process.exitCode = 1;
      return;
    }

    const channelFlag = flags.channel;
    if (channelFlag !== undefined && typeof channelFlag !== "string") {
      logger.error("--channel requires a value.");
      process.exitCode = 1;
      return;
    }

    if (!(await vaultExists())) {
      logger.error("No vault found. Run `governor init` first.");
      process.exitCode = 1;
      return;
    }

    try {
      const botToken =
        botTokenFlag ??
        (await promptPassword(
          'Slack bot token (the "Bot User OAuth Token" from OAuth & Permissions, starts with xoxb-):',
        ));
      if (!BOT_TOKEN_PATTERN.test(botToken)) {
        logger.error(
          'Not a Slack bot token — expected it to start with "xoxb-".',
        );
        process.exitCode = 1;
        return;
      }

      const appToken =
        appTokenFlag ??
        (await promptPassword(
          "Slack app-level token (Basic Information -> App-Level Tokens, scope connections:write, starts with xapp-):",
        ));
      if (!APP_TOKEN_PATTERN.test(appToken)) {
        logger.error(
          'Not a Slack app-level token — expected it to start with "xapp-".',
        );
        process.exitCode = 1;
        return;
      }

      // Not sensitive (it's a public channel identifier, not a credential)
      // so a plain prompt, not a masked one — the channel governor posts
      // approval requests to, chosen by the operator, never by a caller.
      const channel =
        channelFlag ??
        (await promptText(
          'Slack channel ID to post approval requests to (e.g. "C0123456789"):',
        ));

      const masterPassword = await promptPassword("Master password:");
      const vault = await Vault.open(masterPassword);

      vault.set(profileKey("slack", profile), {
        botToken,
        appToken,
        channel,
      });
      await vault.save();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    logger.success(`Stored Slack credentials (profile "${profile}").`);
    logger.info(
      "Used by governor's approval gate (`governor serve --require-approval <tool>,...`) — restart `governor serve` to pick it up.",
    );
  },
};
