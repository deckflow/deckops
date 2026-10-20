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
import {
  runConvertCommand, runExtractCommand, runProbeCommand, runRenderCommand, type RawCliOptions,
} from './cli/commands/run-ops.js';
import { runInstallCommand } from './cli/commands/install.js';
import { printError } from './cli/output.js';
import { DeckOpsError } from './errors/index.js';
import { VERSION } from './version.js';

/**
 * CLI assembly: four verbs. `probe` runs locally and free; `render`, `extract` and `convert` run
 * in DeckOps Cloud. A bare source converts to Markdown on stdout. `modify` / `export` are reserved
 * so adding them later is not a breaking change.
 */

const KNOWN_COMMANDS = new Set([
  'probe', 'render', 'extract', 'convert', 'read', 'parse', 'formats', 'auth', 'config', 'install', 'modify', 'export', 'help',
]);

function commonOptions(command: Command): Command {
  return command
    .option('-o, --output <path>', 'output file or directory (- for stdout where the verb allows it)')
    .option('--from <ext>', 'input format for stdin (e.g. pdf)')
    .option('--space <id>', 'cloud space id')
    .option('--timeout <seconds>', 'seconds for the whole operation, uploads and downloads included (default: 300)')
    .option('--force', 'submit a new task even if an interrupted run left one to continue')
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
    .option('--stay-image-area-rate <rate>', 'keynote: image area keep rate 0-1')
    // Removed in 4.0, kept only to explain the removal.
    .addOption(hidden('--mode <mode>'));
}

function convertOptions(command: Command): Command {
  return command
    .option('--to <format>', 'target format', 'markdown')
    .option('--anchors', 'pdf: per-element provenance comments in markdown')
    .option('--split-pages', 'pptx/keynote: also write one markdown file per slide')
    .option('--strict', 'fail when the markdown cannot be rendered')
    .option('--keep-remote-images', 'link images by their signed URLs instead of downloading them')
    .addOption(hidden('--format <format>'));
}

function hidden(flags: string) {
  return new Command().createOption(flags).hideHelp();
}

async function main(): Promise<void> {
  const program = new Command('deckops')
    .version(VERSION)
    .description('Probe, render, extract and convert documents. Probe runs locally; the rest run in DeckOps Cloud.')
    // Commander errors (unknown option, missing argument) are usage errors:
    // exit 2 per the contract, not commander's default 1.
    .exitOverride();

  program
    .command('probe <input>')
    .description('local, free metadata and detection report (DeckProbe); never uploads')
    .option('--targets <list>', 'comma-separated facts to resolve, e.g. page_count,title')
    .option('--level <level>', 'header|metadata|deep')
    .option('--minimum-confidence <level>', 'none|low|medium|high|exact')
    .option('--from <ext>', 'input format for stdin (e.g. pdf)')
    .option('--timeout <seconds>', 'seconds for the engine (default: 300)')
    .option('--json', 'machine-readable output (the report itself)')
    .option('--quiet', 'only errors')
    .action((input: string, options: RawCliOptions) => runProbeCommand(input, options));

  commonOptions(program.command('render <input>').description('pages or slides → images, or a deck → video'))
    .option('--to <target>', 'image|video')
    .option('--pages <list>', 'pages to keep, e.g. 1-3,7 (the cloud renders all)')
    .option('--quality <level>', 'low|medium|high')
    .option('--image-format <format>', 'png|jpg|webp')
    .option('--width <pixels>', 'long edge in pixels')
    .option('--scale <factor>', 'multiple of the default size')
    .action((input: string, options: RawCliOptions) => runRenderCommand(input, options));

  parseOptions(commonOptions(program.command('extract <input>').description('document → structured JSON or its image assets')))
    .option('--to <target>', 'json|assets')
    .action((input: string, options: RawCliOptions) => runExtractCommand(input, options));

  convertOptions(parseOptions(commonOptions(program.command('convert <input>').description('document → markdown'))))
    .action((input: string, options: RawCliOptions) => runConvertCommand(input, options));

  // A bare source: convert to Markdown on stdout, as in 3.0.
  convertOptions(parseOptions(commonOptions(program.command('read <input>', { hidden: true }))))
    .action((input: string, options: RawCliOptions) => runConvertCommand(input, options, { output: '-' }));

  program
    .command('formats')
    .description('verbs × targets × inputs, from the route table')
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

  const collectAgent = (value: string, previous: string[]): string[] => [...previous, value];
  program
    .command('install')
    .description('install packaged DeckOps assets for coding agents')
    .option('--skills', 'install the DeckOps agent skill')
    .option('--agent <agent>', 'target auto|codex|claude|agents (repeatable)', collectAgent, [])
    .option('-g, --global', 'install into user-level agent directories')
    .option('--dir <directory>', 'explicit skills container; installs into <directory>/deckops')
    .option('--force', 'replace conflicting or locally modified managed skill files')
    .option('--dry-run', 'report the complete plan without writing')
    .option('--json', 'machine-readable install receipt')
    .action((options) => runInstallCommand(options));

  // Removed in 4.0: the message names the replacement instead of "unknown command".
  program
    .command('parse [input]', { hidden: true })
    .allowUnknownOption(true)
    .action(() => {
      throw DeckOpsError.usage('`deckops parse` was removed in DeckOps 4: there are no IR artifacts any more.', {
        hint: 'Structured content: deckops extract SOURCE --to json -o out.json. Markdown: deckops convert SOURCE -o out.md.',
      });
    });

  // Reserved verbs: calling them names the roadmap instead of "unknown command".
  for (const verb of ['modify', 'export'] as const) {
    program
      .command(`${verb} [input]`, { hidden: true })
      .allowUnknownOption(true)
      .action(() => {
        throw DeckOpsError.notImplemented(
          `\`${verb}\` is reserved for a future release. This version ships probe, render, extract and convert.`,
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

  // A bare source uses the content entry point; explicit commands keep their contracts.
  const argv = [...process.argv];
  const first = argv[2];
  if (first === '-' || (first && !first.startsWith('-') && !KNOWN_COMMANDS.has(first))) {
    argv.splice(2, 0, 'read');
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
    printError(error, 'convert', { json: process.argv.includes('--json'), quiet: false });
    process.exit(error.exitCode);
  }
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
