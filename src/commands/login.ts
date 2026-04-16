/**
 * Login command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { Context } from '../context.js';

const DEFAULT_PORT = 3737;

/**
 * Register login command
 */
export function registerLoginCommand(program: Command, ctx: Context): void {
  program
    .command('login')
    .description('Login to Deckflow and save authentication token')
    .option('--port <port>', 'Local server port for callback', String(DEFAULT_PORT))
    .action(async (options: { port: string }) => {
      try {
        const port = parseInt(options.port, 10);
        await ctx.ensureLoggedIn(port, 'explicit');

        if (!ctx.jsonOutput) {
          console.log(chalk.green('\n✓ Token saved successfully!\n'));
          console.log('You can now use Deckflow CLI commands.\n');
        }

        ctx.output(
          { success: true, message: 'Login successful' },
          () => chalk.green('✓ Login successful!')
        );
      } catch (error) {
        ctx.error((error as Error).message);
      }
    });
}
