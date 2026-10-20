import chalk from 'chalk';
import type { DeckOpsError } from '../errors/index.js';
import type { ProbeReport } from '../ops/probe.js';
import type { ErrorEnvelope, OpsEnvelope } from '../types.js';

/**
 * Result rendering. `--json` prints the envelope verbatim (public contract); human mode prints
 * content, or a short outcome summary when files were written. Errors go to stderr, or as an
 * error envelope to stdout with `--json`.
 */

export interface OutputContext {
  json: boolean;
  quiet: boolean;
}

export function printEnvelope(envelope: OpsEnvelope, ctx: OutputContext): void {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (envelope.content !== undefined) {
    process.stdout.write(typeof envelope.content === 'string' ? envelope.content : `${JSON.stringify(envelope.content, null, 2)}\n`);
    if (!ctx.quiet) printWarnings(envelope.warnings);
    return;
  }
  if (ctx.quiet) return;
  const detail = [envelope.format, envelope.reusedParse ? 'reused parse' : undefined].filter(Boolean).join(', ');
  process.stdout.write(`${chalk.green(`✓ ${envelope.op} → ${envelope.to}`)}${detail ? `  ${chalk.dim(`[${detail}]`)}` : ''}\n`);
  for (const output of envelope.outputs) process.stdout.write(`  ${output.file}\n`);
  process.stdout.write(chalk.dim(`  ${envelope.tasks.map((task) => `${task.type} ${task.id}`).join(', ')} · ${envelope.durationMs} ms\n`));
  printWarnings(envelope.warnings);
}

/** DeckProbe's schema-2 report, unchanged: the same JSON `deckprobe --pretty` prints. */
export function printProbe(report: ProbeReport): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export function printWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${chalk.yellow('warning:')} ${warning}\n`);
  }
}

export function printError(error: DeckOpsError, op: ErrorEnvelope['op'], ctx: OutputContext): void {
  if (ctx.json) {
    const envelope: ErrorEnvelope = {
      ok: false,
      op,
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.taskId ? { taskId: error.taskId } : {}),
      },
    };
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${chalk.red('error:')} ${error.message} ${chalk.dim(`[${error.code}]`)}\n`);
  if (error.hint) {
    process.stderr.write(`${chalk.dim('hint:')} ${error.hint}\n`);
  }
}
