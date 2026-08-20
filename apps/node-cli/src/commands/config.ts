/**
 * Configuration commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { Context } from '../context.js';

/**
 * Register config commands
 */
export function registerConfigCommands(program: Command, ctx: Context): void {
  const config = program.command('config').description('Manage configuration');

  // config set-token
  config
    .command('set-token <token>')
    .description('Set authentication token')
    .action(async (token: string) => {
      try {
        await ctx.config.setToken(token);

        ctx.output(
          { token, message: 'Token set successfully' },
          () => chalk.green('✓ Token set successfully')
        );
      } catch (error) {
        ctx.error(error);
      }
    });

  // config set-api-key
  config
    .command('set-api-key <api-key>')
    .description('Set API key (shared with deckhtml at ~/.deckflow/credentials)')
    .action(async (apiKey: string) => {
      try {
        await ctx.config.setApiKey(apiKey);

        ctx.output(
          { apiKey, message: 'API key set successfully' },
          () => chalk.green('✓ API key set successfully')
        );
      } catch (error) {
        ctx.error(error);
      }
    });

  // config set-space
  config
    .command('set-space <space-id>')
    .description('Set workspace/space ID')
    .action(async (spaceId: string) => {
      try {
        await ctx.config.setSpaceId(spaceId);

        ctx.output(
          { spaceId, message: 'Space ID set successfully' },
          () => chalk.green('✓ Space ID set successfully')
        );
      } catch (error) {
        ctx.error(error);
      }
    });

  // config set-api-base
  config
    .command('set-api-base <url>')
    .description('Set API base URL')
    .action(async (url: string) => {
      try {
        await ctx.config.setApiBase(url);

        ctx.output(
          { apiBase: url, message: 'API base URL set successfully' },
          () => chalk.green('✓ API base URL set successfully')
        );
      } catch (error) {
        ctx.error(error);
      }
    });

  // config show
  config
    .command('show')
    .description('Show current configuration')
    .action(() => {
      try {
        const allConfig = ctx.config.all();
        const shouldShowLoginHint = !allConfig.token && !allConfig.apiKey;

        // Mask sensitive data in human-readable output
        const displayConfig = { ...allConfig };
        if (displayConfig.token && !ctx.jsonOutput) {
          displayConfig.token = `${displayConfig.token.slice(0, 8)}...`;
        }
        if (displayConfig.apiKey && !ctx.jsonOutput) {
          displayConfig.apiKey = `${displayConfig.apiKey.slice(0, 8)}...`;
        }

        ctx.output(displayConfig, (data) => {
          const content = Object.entries(data)
            .map(([key, value]) => `${chalk.cyan(key)}: ${value || chalk.gray('(not set)')}`)
            .join('\n');
          if (shouldShowLoginHint) {
            return `${content}\n${chalk.yellow('Tip: credentials missing. Please run `deckops login` or set an API key first.')}`;
          }
          return content;
        });
      } catch (error) {
        ctx.error(error);
      }
    });
}
