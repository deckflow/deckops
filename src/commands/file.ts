/**
 * File commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { Context } from '../context.js';

/**
 * Register file commands
 */
export function registerFileCommands(program: Command, ctx: Context): void {
  const file = program.command('file').description('File operations');

  // file upload
  file
    .command('upload <path>')
    .description('Upload a file to the workspace')
    .option('--no-progress', 'Disable progress indicator')
    .action(async (filePath: string, options: { progress: boolean }) => {
      try {
        const uploader = ctx.getUploader();
        const spaceId = ctx.config.spaceId;

        if (!spaceId) {
          ctx.error('Space ID not set. Run: deckflow config set-space <space-id>', 'NO_SPACE_ID');
        }

        let spinner: any;
        if (!ctx.jsonOutput && options.progress) {
          spinner = ora('Uploading file...').start();
        }

        const fileId = await uploader.uploadFile(spaceId, filePath, (progress) => {
          if (spinner) {
            spinner.text = `Uploading: ${(progress * 100).toFixed(1)}%`;
          }
        });

        if (spinner) {
          spinner.succeed(`File uploaded successfully`);
        }

        ctx.output(
          { fileId, path: filePath },
          () => `${chalk.green('✓')} File ID: ${chalk.cyan(fileId)}`
        );
      } catch (error) {
        ctx.error((error as Error).message);
      }
    });
}
