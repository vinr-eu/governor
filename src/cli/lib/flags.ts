export interface ParsedArgs {
  args: string[];
  flags: Record<string, string | boolean>;
}

/** Parses `--flag value` and `--flag` (boolean) pairs out of a subcommand's argv tail. */
export function parseFlags(argv: string[]): ParsedArgs {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { args, flags };
}
