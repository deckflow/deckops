import chalk from 'chalk';
import type { DeckOpsError } from '../errors/index.js';
import type { ConvertEnvelope, Envelope, ParseEnvelope } from '../types.js';

/**
 * Result rendering. `--json` prints the envelope verbatim (public contract);
 * human mode prints a short outcome summary. Everything informational goes to
 * stdout, errors to stderr.
 */

export interface OutputContext {
  json: boolean;
  quiet: boolean;
}

export function printEnvelope(envelope: Envelope, ctx: OutputContext): void {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (!envelope.ok) {
    return;
  }
  printAssessment(envelope);
  if (envelope.op === 'convert' && envelope.content !== undefined) { process.stdout.write(envelope.content); printWarnings(envelope.warnings); return; }
  if (ctx.quiet) {
    return;
  }
  if (envelope.op === 'parse') {
    printParse(envelope);
  } else {
    printConvert(envelope);
  }
}

function printParse(envelope: ParseEnvelope): void {
  const head = envelope.reusedParse
    ? chalk.green('✓ reused existing artifact')
    : chalk.green('✓ parsed');
  process.stdout.write(`${head}  ${chalk.dim(`[${envelope.type}]`)}\n`);
  process.stdout.write(`  artifact  ${envelope.artifact}\n`);
  process.stdout.write(`  engine    ${envelope.engine}\n`);
  process.stdout.write(`  quality   ${envelope.quality.status}\n`);
  process.stdout.write(`  schema    ${envelope.irSchemaVersion}\n`);
  if (envelope.irKey) process.stdout.write(`  irKey     ${envelope.irKey}\n`);
  if (envelope.taskId) {
    process.stdout.write(`  task      ${envelope.taskId}\n`);
  }
  process.stdout.write(chalk.dim(`  ${envelope.durationMs} ms\n`));
  printWarnings(envelope.warnings);
}

function printConvert(envelope: ConvertEnvelope): void {
  const head =
    envelope.engine === 'artifact-cache'
      ? chalk.green('✓ reused existing view')
      : chalk.green(`✓ converted to ${envelope.to}`);
  process.stdout.write(`${head}  ${chalk.dim(`[${envelope.format}]`)}\n`);
  for (const output of envelope.outputs.filter((entry) => entry.file.endsWith('.md'))) {
    process.stdout.write(`  ${output.file}\n`);
  }
  const assets = envelope.outputs.filter((entry) => !entry.file.endsWith('.md') && !entry.file.endsWith('.json'));
  if (assets.length > 0) {
    process.stdout.write(chalk.dim(`  + ${assets.length} image${assets.length === 1 ? '' : 's'} localized\n`));
  }
  process.stdout.write(chalk.dim(`  ${envelope.durationMs} ms\n`));
  printWarnings(envelope.warnings);
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${chalk.yellow('warning:')} ${warning}\n`);
  }
}

export function printError(error: DeckOpsError, op: 'parse' | 'convert' | 'install' | 'read', ctx: OutputContext): void {
  if (ctx.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...(op === 'read' ? { schemaVersion: 'deckops.read.v1' } : {}),
          ok: false,
          op,
          error: {
            code: error.code,
            message: error.message,
            ...(error.hint ? { hint: error.hint } : {}),
            ...(error.taskId ? { taskId: error.taskId } : {}),
          },
        },
        null,
        2
      )}\n`
    );
    return;
  }
  process.stderr.write(`${chalk.red('error:')} ${error.message} ${chalk.dim(`[${error.code}]`)}\n`);
  if (error.hint) {
    process.stderr.write(`${chalk.dim('hint:')} ${error.hint}\n`);
  }
}

function printAssessment(envelope: ParseEnvelope | ConvertEnvelope): void {
  const assessment = envelope.assessment;
  if (assessment?.status === 'needs_attention') {
    const s = assessment.summary;
    if (s) process.stderr.write(`quality: ${s.parsedPages}/${s.sourcePages ?? '?'} pages/slides; missing=${s.missingPageCount}; failed=${s.failedPages.length}; searchableTextCharacters=${s.searchableTextCharacters}\n`);
    const first = assessment.issues.find(i => i.severity !== 'info' && i.impact !== 'informational');
    if (first) process.stderr.write(`quality: ${first.message}\n`);
  }
  if (assessment?.recommendation) process.stderr.write(`recommendation: ${assessment.recommendation.message}\n`);
  if (envelope.decision?.next) process.stderr.write(`next: ${envelope.decision.next.argv.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ')}\n`);
}
