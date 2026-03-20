/**
 * REPL (Read-Eval-Print Loop) mode
 */

import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'readline';
import { Context } from '../context.js';

/**
 * Register REPL command
 */
export function registerReplCommand(program: Command, ctx: Context): void {
  program
    .command('repl')
    .description('Start interactive REPL mode')
    .action(async () => {
      console.log(chalk.cyan('Deckflow REPL'));
      console.log(chalk.gray("Type 'help' for commands, 'exit' to quit\n"));

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.green('deckflow> '),
      });

      rl.prompt();

      rl.on('line', async (line) => {
        const trimmed = line.trim();

        if (!trimmed) {
          rl.prompt();
          return;
        }

        if (trimmed === 'exit' || trimmed === 'quit') {
          console.log(chalk.yellow('Exiting...'));
          rl.close();
          return;
        }

        try {
          // Parse the command line into arguments
          const args = parseCommandLine(trimmed);

          // Create a new program instance for this command
          const replProgram = new Command();
          replProgram.exitOverride(); // Prevent process.exit()
          replProgram.configureOutput({
            writeOut: (str) => process.stdout.write(str),
            writeErr: (str) => process.stderr.write(str),
          });

          // Re-register all commands from the main program
          const mainProgram = program.parent || program;
          mainProgram.commands.forEach((cmd) => {
            if (cmd.name() !== 'repl') {
              replProgram.addCommand(cmd);
            }
          });

          // Parse and execute
          await replProgram.parseAsync(['node', 'deckflow', ...args], { from: 'user' });
        } catch (error: any) {
          // Handle command errors gracefully
          if (error.code !== 'commander.help' && error.code !== 'commander.helpDisplayed') {
            console.error(chalk.red(`Error: ${error.message}`));
          }
        }

        rl.prompt();
      });

      rl.on('close', () => {
        console.log(chalk.yellow('\nGoodbye!'));
        process.exit(0);
      });
    });
}

/**
 * Parse command line with proper quote handling
 */
function parseCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuote) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}
