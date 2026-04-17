/**
 * Compress command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
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
        if (!ctx.jsonOutput) {
          spinner = ora(`Uploading ${path.basename(inputFile)}...`).start();
        }

        const fileId = await uploader.uploadFile(spaceId, inputFile, (progress) => {
          if (spinner) {
            spinner.text = `Uploading: ${(progress * 100).toFixed(1)}%`;
          }
        });

        if (spinner) {
          spinner.succeed('File uploaded');
        }

        // Create task
        if (!ctx.jsonOutput) {
          spinner = ora('Creating compression task...').start();
        }

        const taskName = path.basename(inputFile, ext);
        let task = await client.addTask(spaceId, [fileId], taskType, taskName);

        if (spinner) {
          spinner.succeed(`Task created: ${task.id}`);
        }

        // Wait for completion
        if (options.wait) {
          if (!ctx.jsonOutput) {
            spinner = ora('Processing...').start();
          }

          task = await client.waitForTask(task.id, parseInt(options.timeout, 10), true, (t) => {
            if (spinner && t.status === 'running') {
              spinner.text = 'Processing...';
            }
          });

          if (spinner) {
            if (task.status === 'completed') {
              spinner.succeed('Compression completed');
            } else {
              spinner.fail('Compression failed');
            }
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
