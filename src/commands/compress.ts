/**
 * Compress command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import { COMPRESS_TYPES, DEFAULT_TIMEOUT } from '../utils/constants.js';

/**
 * Register compress command
 */
export function registerCompressCommand(program: Command, ctx: Context): void {
  program
    .command('compress <input-file>')
    .description('Compress a file')
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(async (inputFile: string, options: { wait?: boolean; timeout: string }) => {
      const wait = options.wait !== false;
      try {
        const client = await ctx.getClient();
        const uploader = await ctx.getUploader();
        const spaceId = ctx.config.spaceId;
        if (!spaceId) {
          ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
        }

        // Auto-detect task type
        const ext = path.extname(inputFile).toLowerCase();
        const taskType = COMPRESS_TYPES[ext];

        if (!taskType) {
          const supportedTypes = Object.keys(COMPRESS_TYPES).join(', ');
          ctx.error(
            `Unsupported file type: ${ext}\nSupported: ${supportedTypes}`,
            'UNSUPPORTED_TYPE'
          );
        }

        // Upload file
        let spinner: any;
        spinner = ctx.createSpinner(`Uploading ${path.basename(inputFile)}...`);

        const fileId = await uploader.uploadFile(spaceId, inputFile, (progress) => {
          if (spinner) {
            spinner.text = `Uploading: ${(progress * 100).toFixed(1)}%`;
          }
        });

        ctx.succeedSpinner(spinner, 'File uploaded');

        // Create task
        spinner = ctx.createSpinner('Creating compression task...');

        const taskName = path.basename(inputFile, ext);
        let task = await client.addTask(spaceId, [fileId], taskType, taskName);

        ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

        // Wait for completion
        if (wait) {
          spinner = ctx.createSpinner('Processing...');

          task = await client.waitForTask(task.id, parseInt(options.timeout, 10), true, (t) => {
            if (spinner && t.status === 'running') {
              spinner.text = 'Processing...';
            }
          });

          if (task.status === 'completed') {
            ctx.succeedSpinner(spinner, 'Compression completed');
          } else {
            ctx.failSpinner(spinner, 'Compression failed');
          }
        }

        ctx.output(task, (t) => {
          const lines = [
            `${chalk.bold('Compression Task:')}`,
            `  Task ID: ${chalk.cyan(t.id)}`,
            `  Status: ${t.status === 'completed' ? chalk.green(t.status) : chalk.yellow(t.status)}`,
          ];

          if (t.result) {
            lines.push(`  Result: ${JSON.stringify(t.result, null, 2)}`);
          }

          return lines.join('\n');
        });
      } catch (error) {
        ctx.error((error as Error).message);
      }
    });
}
