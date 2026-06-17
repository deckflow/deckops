/**
 * When required CLI arguments or mandatory options are missing, prompt the user
 * interactively (TTY only). Choice-constrained options use an inquirer list.
 */

import type { Argument } from 'commander';
import { Command, CommanderError, Option } from 'commander';
import inquirer from 'inquirer';
import fs from 'fs';
import tty from 'tty';

const REPAIRABLE = new Set<string>([
  'commander.missingMandatoryOptionValue',
  'commander.missingArgument',
  'commander.optionMissingArgument',
]);

const DEV_TTY = '/dev/tty';

function isInteractiveCapable(argv: string[]): boolean {
  if (argv.includes('--json')) {
    return false;
  }
  if (!fs.existsSync(DEV_TTY)) {
    return false;
  }
  // Most reliable: can we actually open the controlling terminal?
  try {
    const inFd = fs.openSync(DEV_TTY, 'r');
    const outFd = fs.openSync(DEV_TTY, 'w');
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    return true;
  } catch {
    return false;
  }
}

function normalizeFlagHead(flagSpec: string): string {
  const first = flagSpec.trim().split(/\s+/)[0];
  return first ?? flagSpec;
}

/**
 * Resolve the leaf Command for the current argv prefix (for option/argument lookup).
 */
function resolveLeafCommand(root: Command, argv: string[]): Command {
  let cmd: Command = root;
  let i = 2;

  while (i < argv.length) {
    const t = argv[i];
    if (t === undefined) {
      break;
    }
    if (t === '--') {
      break;
    }

    if (t.startsWith('-')) {
      const opt = cmd.options.find((o) => o.long === t || o.short === t);
      if (opt) {
        i += 1;
        if (opt.required || opt.optional) {
          if (i < argv.length && !argv[i]!.startsWith('-')) {
            i += 1;
          }
        }
      } else {
        i += 1;
      }
      continue;
    }

    const sub = cmd.commands.find((c) => c.name() === t || c.aliases().includes(t));
    if (sub) {
      cmd = sub;
      i += 1;
      continue;
    }

    break;
  }

  return cmd;
}

function findOptionForSpec(cmd: Command, flagSpec: string): Option | undefined {
  const head = normalizeFlagHead(flagSpec);
  return cmd.options.find(
    (o) => o.long === head || o.short === head || o.flags.startsWith(head)
  );
}

let promptFn: ((questions: any) => Promise<any>) | undefined;
function prompt(questions: any) {
  if (!promptFn) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      promptFn = inquirer.prompt.bind(inquirer);
    } else if (fs.existsSync(DEV_TTY)) {
      try {
        const inFd = fs.openSync(DEV_TTY, 'r');
        const outFd = fs.openSync(DEV_TTY, 'w');
        const input = new tty.ReadStream(inFd);
        const output = new tty.WriteStream(outFd);
        promptFn = inquirer.createPromptModule({ input, output }) as any;
      } catch {
        promptFn = inquirer.prompt.bind(inquirer);
      }
    } else {
      promptFn = inquirer.prompt.bind(inquirer);
    }
  }
  return promptFn!(questions);
}

async function promptOptionValue(option: Option): Promise<string> {
  const label = option.flags;
  if (option.argChoices && option.argChoices.length > 0) {
    const { value } = (await prompt([
      {
        type: 'list',
        name: 'value',
        message: `Select ${label}`,
        choices: option.argChoices,
      },
    ])) as { value: string };
    return value;
  }

  const { value } = (await prompt([
    {
      type: 'input',
      name: 'value',
      message: `Enter a value for ${label}`,
      validate: (input: string) => (input.trim().length > 0 ? true : 'Value is required'),
    },
  ])) as { value: string };
  return value.trim();
}

async function promptArgumentValue(arg: Argument, displayName: string): Promise<string> {
  if (arg.argChoices && arg.argChoices.length > 0) {
    const { value } = (await prompt([
      {
        type: 'list',
        name: 'value',
        message: `Select ${displayName}`,
        choices: arg.argChoices,
      },
    ])) as { value: string };
    return value;
  }

  const message = arg.variadic
    ? `Enter ${displayName} (separate multiple values with spaces)`
    : `Enter ${displayName}`;

  const { value } = (await prompt([
    {
      type: 'input',
      name: 'value',
      message,
      validate: (input: string) => (input.trim().length > 0 ? true : 'Value is required'),
    },
  ])) as { value: string };

  return value.trim();
}

function appendOptionArgv(argv: string[], option: Option, value: string): string[] {
  if (option.long) {
    return [...argv, option.long, value];
  }
  if (option.short) {
    return [...argv, option.short, value];
  }
  return [...argv, normalizeFlagHead(option.flags), value];
}

function insertOptionValueAfterFlag(argv: string[], flagHead: string, value: string): string[] {
  const out = [...argv];
  let idx = -1;
  for (let i = out.length - 1; i >= 2; i--) {
    if (out[i] === flagHead) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    out.splice(idx + 1, 0, value);
    return out;
  }
  return [...argv, flagHead, value];
}

async function repairArgv(
  program: Command,
  argv: string[],
  err: CommanderError
): Promise<string[] | null> {
  const debug = process.env.DECKOPS_INTERACTIVE_DEBUG === '1';
  if (err.code === 'commander.missingMandatoryOptionValue') {
    const m = err.message.match(/required option '([^']+)'/);
    if (!m?.[1]) {
      return null;
    }
    const leaf = resolveLeafCommand(program, argv);
    const option = findOptionForSpec(leaf, m[1]);
    if (debug) {
      // eslint-disable-next-line no-console
      console.error(`[deckops] repair mandatory option=${m[1]} leaf=${leaf.name()} found=${Boolean(option)}`);
    }
    if (!option) {
      return null;
    }
    const value = await promptOptionValue(option);
    return appendOptionArgv(argv, option, value);
  }

  if (err.code === 'commander.optionMissingArgument') {
    const m = err.message.match(/option '([^']+)' argument missing/);
    if (!m?.[1]) {
      return null;
    }
    const leaf = resolveLeafCommand(program, argv);
    const option = findOptionForSpec(leaf, m[1]);
    if (debug) {
      // eslint-disable-next-line no-console
      console.error(`[deckops] repair optionMissingArg option=${m[1]} leaf=${leaf.name()} found=${Boolean(option)}`);
    }
    if (!option) {
      return null;
    }
    const value = await promptOptionValue(option);
    const head = normalizeFlagHead(m[1]);
    return insertOptionValueAfterFlag(argv, head, value);
  }

  if (err.code === 'commander.missingArgument') {
    const m = err.message.match(/missing required argument '([^']+)'/);
    if (!m?.[1]) {
      return null;
    }
    const argName = m[1];
    const leaf = resolveLeafCommand(program, argv);
    const arg = leaf.registeredArguments.find((a) => a.name() === argName);
    if (debug) {
      // eslint-disable-next-line no-console
      console.error(`[deckops] repair missingArgument arg=${argName} leaf=${leaf.name()} found=${Boolean(arg)}`);
    }
    if (!arg) {
      return null;
    }
    const raw = await promptArgumentValue(arg, argName);
    if (arg.variadic) {
      const parts = raw.split(/\s+/).filter(Boolean);
      return [...argv, ...parts];
    }
    return [...argv, raw];
  }

  return null;
}

function resetOutput(program: Command): void {
  program.configureOutput({
    writeOut: (str: string) => process.stdout.write(str),
    writeErr: (str: string) => process.stderr.write(str),
  });
}

/**
 * Parse argv with optional interactive repair for missing required values.
 */
export async function parseWithInteractiveRepair(program: Command, argv: string[]): Promise<void> {
  // Important: subcommands are created before we parse.
  // Calling exitOverride only on root does NOT retrofit into already-created subcommands,
  // so missing required values may still call process.exit().
  const applyExitOverride = (cmd: Command) => {
    cmd.exitOverride();
    cmd.commands.forEach(applyExitOverride);
  };
  applyExitOverride(program);
  const interactive = isInteractiveCapable(argv);
  if (process.env.DECKOPS_INTERACTIVE_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(
      `[deckops] interactive=${interactive} stdinTTY=${Boolean(process.stdin.isTTY)} stdoutTTY=${Boolean(process.stdout.isTTY)} hasDevTty=${fs.existsSync(
        DEV_TTY
      )}`
    );
  }
  const maxAttempts = interactive ? 24 : 1;
  let current = [...argv];

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      program.configureOutput({
        writeErr: (str: string) => {
          if (!interactive || attempt === 0) {
            process.stderr.write(str);
          }
        },
      });

      try {
        await program.parseAsync(current);
        return;
      } catch (e) {
        if (process.env.DECKOPS_INTERACTIVE_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error(`[deckops] parse attempt=${attempt} caught=${(e as any)?.code ?? 'unknown'}`);
        }
        if (!(e instanceof CommanderError)) {
          throw e;
        }
        if (!interactive || !REPAIRABLE.has(e.code)) {
          throw e;
        }
        const next = await repairArgv(program, current, e);
        if (!next) {
          if (process.env.DECKOPS_INTERACTIVE_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.error('[deckops] repairArgv returned null');
          }
          throw e;
        }
        current = next;
      }
    }

    throw new CommanderError(
      1,
      'commander.interactiveRepairLimit',
      'Interactive CLI repair failed: too many attempts'
    );
  } finally {
    resetOutput(program);
  }
}
