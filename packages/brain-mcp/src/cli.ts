#!/usr/bin/env node
import { getBrainRoot, lintBrain, type BrainLintIssueKind } from "./brain.js";

type CliArgs = Readonly<{
  paths: string[];
  kinds: BrainLintIssueKind[];
  strict: boolean;
  includeArchived: boolean;
  help: boolean;
}>;

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const paths: string[] = [];
  const kinds: BrainLintIssueKind[] = [];
  let strict = false;
  let includeArchived = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--include-archived") {
      includeArchived = true;
    } else if (arg === "--kind") {
      const value = argv[index + 1] as BrainLintIssueKind | undefined;
      if (value) {
        kinds.push(value);
        index += 1;
      }
    } else if (arg && !arg.startsWith("--")) {
      paths.push(arg);
    }
  }

  return { paths, kinds, strict, includeArchived, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      "brain-lint — lint the local brain Markdown wiki.",
      "",
      "Usage:",
      "  brain-lint [paths...] [options]",
      "",
      "Options:",
      "  --strict              Exit non-zero if any issue is found.",
      "  --kind <name>         Filter to a kind (orphan, broken-link, missing-title, missing-source-frontmatter). Repeatable.",
      "  --include-archived    Include _done/archive folders.",
      "  --help                Show this help.",
      "",
      "Env:",
      "  BRAIN_MCP_ROOT        Path to brain repo (default: ~/code/brain).",
      "",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const root = getBrainRoot();
  const report = await lintBrain(root, {
    paths: args.paths.length ? args.paths : undefined,
    kinds: args.kinds.length ? args.kinds : undefined,
    includeArchived: args.includeArchived,
  });

  if (report.issues.length === 0) {
    process.stdout.write(`brain-lint: clean (${report.scanned} page(s) scanned)\n`);
    return;
  }

  for (const issue of report.issues) {
    process.stdout.write(`${issue.path}: [${issue.kind}] ${issue.detail}\n`);
  }
  process.stdout.write(
    `\nbrain-lint: ${report.issues.length} issue(s) across ${report.scanned} page(s)\n`
  );

  if (args.strict) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`brain-lint: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
