#!/usr/bin/env node

/**
 * Deckflow CLI - Main entry point
 */

import { Command } from 'commander';
import { Context } from './context.js';
import { registerConfigCommands } from './commands/config.js';
import { registerLoginCommand } from './commands/login.js';
import { registerTaskCommands } from './commands/task.js';
import { registerCompressCommand } from './commands/compress.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerOcrCommand } from './commands/ocr.js';
import { registerConvertCommand } from './commands/convert.js';
import { registerJoinCommand } from './commands/join.js';
import { registerGenerationCommand } from './commands/generation.js';
import { registerTranslationCommand } from './commands/translation.js';
import { registerRunCommand } from './commands/run.js';
import { registerReplCommand } from './commands/repl.js';
import { ExitCode, outputError } from './utils/errors.js';

async function main() {
  // Create global context
  const ctx = new Context();
  await ctx.init();

  // Create Commander program
  const program = new Command();

  program
    .name('deckflow')
    .description('Deckflow CLI - File processing and conversion tools')
    .version('0.2.0')
    .option('--json', 'Output in JSON format')
    .hook('preAction', (thisCommand) => {
      // Set JSON output mode based on global flag
      const opts = thisCommand.optsWithGlobals();
      ctx.jsonOutput = Boolean(opts.json);
    });

  // Register command groups and commands
  registerConfigCommands(program, ctx);
  registerLoginCommand(program, ctx);
  registerTaskCommands(program, ctx);
  registerCompressCommand(program, ctx);
  registerExtractCommand(program, ctx);
  registerOcrCommand(program, ctx);
  registerConvertCommand(program, ctx);
  registerJoinCommand(program, ctx);
  registerGenerationCommand(program, ctx);
  registerTranslationCommand(program, ctx);
  registerRunCommand(program, ctx);
  registerReplCommand(program, ctx);

  // Parse arguments
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    outputError(error as Error, ctx.jsonOutput);
    process.exit(ExitCode.ERROR);
  }

  // If no command provided, show help
  if (process.argv.length <= 2) {
    program.help();
  }
}

// Run main and handle errors
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(ExitCode.ERROR);
});
