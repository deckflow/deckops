#!/usr/bin/env node
import { Command } from 'commander';
import {
  runAuthLogin,
  runAuthLogout,
  runAuthStatus,
  runConfigList,
  runConfigSet,
  runFormats,
} from './cli/commands/aux.js';
import { runConvertCommand, runParseCommand, type RawCliOptions } from './cli/commands/run-ops.js';
import { printError } from './cli/output.js';
import { DeckOpsError } from './errors/index.js';
import { migrateConfig, type MigrationOptions } from './config/migrate.js';
import { VERSION } from './version.js';

/**
 * CLI assembly (docs/rfc.md §5.1). Bare invocation is `parse` — the product is
 * called DeckOps, its default action produces the IR artifact, not markdown.
 * `extract` / `modify` / `export` are reserved so adding them later is not a
 * breaking change.
 */

const KNOWN_COMMANDS = new Set([
  'parse',
  'convert',
  'formats',
  'auth',
  'config',
  'extract',
  'modify',
  'export',
  'help',
]);

function commonOptions(command: Command): Command {
  return command
    .option('-o, --output <path>', 'output file or directory (- for stdout on convert)')
    .option('--from <ext>', 'input format for stdin (e.g. pdf)')
    .option('--space <id>', 'cloud space id')
    .option('--timeout <seconds>', 'task wait timeout')
    .option('--preflight <mode>', 'local DeckProbe check: off|validate|strict (default: validate)')
    .option('--engine <engine>', 'parse engine: local|cloud|auto (default: local)')
    .option('--allow-upload', 'allow auto mode to upload when local quality is insufficient')
    .option('--fail-on-degraded', 'fail when the selected local parser reports degraded quality')
    .option('--max-source-bytes <bytes>', 'local parser source-size limit')
    .option('--max-expanded-bytes <bytes>', 'local OOXML cumulative expanded-size limit')
    .option('--max-part-bytes <bytes>', 'local OOXML single-part expanded-size limit')
    .option('--max-asset-bytes <bytes>', 'local single-asset size limit')
    .option('--max-total-asset-bytes <bytes>', 'local cumulative asset-size limit')
    .option('--max-zip-entries <count>', 'local OOXML ZIP entry limit')
    .option('--max-url-bytes <bytes>', 'local HTML response-size limit')
    .option('--worker-heap-mb <mb>', 'local OOXML worker heap limit')
    .option('--force', 'ignore local reuse and redo the work')
    .option('--api-key <key>', 'API key (overrides stored credentials)')
    .option('--token <token>', 'user token (overrides stored credentials)')
    .option('--api-base <url>', 'API base URL')
    .option('--json', 'machine-readable output')
    .option('--quiet', 'only errors');
}

function parseOptions(command: Command): Command {
  return command
    .option('--profile <level>', 'pdf: fast|balanced|quality')
    .option('--password <pwd>', 'pdf: password for encrypted documents')
    .option('--no-images', 'pdf: skip image extraction')
    .option('--page-furniture <mode>', 'pdf: off|drop|extract')
    .option('--overlaid-text <mode>', 'pdf: auto|keep|drop')
    .option('--tracked-changes <mode>', 'docx: final|original|all')
    .option('--stay-image-area-rate <rate>', 'keynote: image area keep rate 0-1')
    .option('--mode <mode>', 'url: source|runtime');
}

function convertOptions(command: Command): Command {
  return command
    .option('--to <format>', 'target view format', 'markdown')
    .option('--anchors', 'pdf: per-element provenance comments in markdown')
    .option('--split-pages', 'pptx/keynote: one markdown file per page')
    .option('--strict', 'fail the task when rendering degrades')
    .option('--keep-remote-images', 'accept expiring remote image links instead of failing');
}

async function main(): Promise<void> {
  const program = new Command('deckops')
    .version(VERSION)
    .description('Parse documents into durable IR artifacts; convert IR into views. Parse once, operate repeatedly.')
    // Commander errors (unknown option, missing argument) are usage errors:
    // exit 2 per the contract, not commander's default 1.
    .exitOverride();

  parseOptions(commonOptions(program.command('parse <input>').description('document → IR artifact'))).action(
    (input: string, options: RawCliOptions) => runParseCommand(input, options)
  );

  convertOptions(
    parseOptions(
      commonOptions(
        program
          .command('convert <input>')
          .description('IR artifact (or document, one-shot) → view; markdown in v1')
      )
    )
  ).action((input: string, options: RawCliOptions) => runConvertCommand(input, options));

  program
    .command('formats')
    .description('what parses to what')
    .option('--json', 'machine-readable output')
    .action((options: { json?: boolean }) => runFormats(options));

  const auth = program.command('auth').description('login shared across DeckFlow CLIs');
  auth
    .command('login')
    .option('--api-base <url>', 'API base URL')
    .action((options: { apiBase?: string }) => runAuthLogin(options));
  auth
    .command('status')
    .option('--api-base <url>', 'API base URL')
    .option('--json', 'machine-readable output')
    .action((options: { apiBase?: string; json?: boolean }) => runAuthStatus(options));
  auth.command('logout').action(() => runAuthLogout());

  const config = program.command('config').description('credentials and defaults');
  config.command('list').option('--json', 'machine-readable output').action((options: { json?: boolean }) =>
    runConfigList(options)
  );
  config.command('set <key> <value>').action((key: string, value: string) => runConfigSet(key, value));
  config.command('migrate').description('import legacy configuration once; keep existing values and source files')
    .option('--from-parse <directory>', 'legacy DeckParse configuration directory')
    .option('--from-tools <directory>', 'legacy tool configuration directory')
    .option('--shared-dir <directory>', 'shared credential directory')
    .option('--ops-dir <directory>', 'new DeckOps configuration directory')
    .option('--tools-dir <directory>', 'DeckTools configuration directory')
    .option('--dry-run', 'report paths and field names without writing')
    .action(async (options: MigrationOptions) => { process.stdout.write(`${JSON.stringify(await migrateConfig(options), null, 2)}\n`); });

  // Reserved verbs: calling them names the roadmap instead of "unknown command".
  for (const verb of ['extract', 'modify', 'export'] as const) {
    program
      .command(`${verb} [input]`, { hidden: true })
      .allowUnknownOption(true)
      .action(() => {
        throw DeckOpsError.notImplemented(
          `\`${verb}\` is reserved for a future release. v1 ships parse and convert.`,
          { hint: 'See the roadmap: https://github.com/deckflow/deckops#roadmap' }
        );
      });
  }

  // exitOverride must cover subcommands created above.
  for (const command of program.commands) {
    command.exitOverride();
    for (const sub of command.commands) {
      sub.exitOverride();
    }
  }

  // Bare invocation = parse: `deckops doc.pdf` ≡ `deckops parse doc.pdf`.
  const argv = [...process.argv];
  const first = argv[2];
  if (first === '-' || (first && !first.startsWith('-') && !KNOWN_COMMANDS.has(first))) {
    argv.splice(2, 0, 'parse');
  }

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const commanderError = error as { code?: string };
    if (typeof commanderError.code === 'string' && commanderError.code.startsWith('commander.')) {
      const benign = ['commander.version', 'commander.helpDisplayed', 'commander.help'];
      process.exit(benign.includes(commanderError.code) ? 0 : 2);
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  if (error instanceof DeckOpsError) {
    printError(error, 'parse', { json: process.argv.includes('--json'), quiet: false });
    process.exit(error.exitCode);
  }
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
