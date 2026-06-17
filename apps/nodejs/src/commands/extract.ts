/**
 * Extract command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import { EXTRACT_TYPES, EXTRACT_TYPE_MAP, DEFAULT_TIMEOUT } from '../utils/constants.js';

/**
 * Register extract command
 */
export function registerExtractCommand(program: Command, ctx: Context): void {
  program
    .command('extract <input-file>')
    .description('Extract information from a file (fonts, text-shapes)')
    .option('--type <type>', 'Extract type: fonts, text-shapes')
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFile: string,
        options: { type?: string; wait?: boolean; timeout: string }
      ) => {
        const wait = options.wait !== false;
        try {
          const client = await ctx.getClient();
          const uploader = await ctx.getUploader();
          const spaceId = ctx.config.spaceId;
          if (!spaceId) {
            ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
          }

          // Determine task type
          const ext = path.extname(inputFile).toLowerCase();
          let taskType: string;

          if (options.type) {
            const mapped = EXTRACT_TYPE_MAP[options.type];
            if (!mapped) {
              const supportedTypes = Object.keys(EXTRACT_TYPE_MAP).join(', ');
              ctx.error(
                `Unknown extract type: ${options.type}\nSupported: ${supportedTypes}`,
                'INVALID_TYPE'
              );
            }
            taskType = mapped;
          } else {
            const autoDetected = EXTRACT_TYPES[ext];
            if (!autoDetected) {
              ctx.error(
                `Cannot auto-detect extract type for: ${ext}\nPlease specify --type`,
                'UNSUPPORTED_TYPE'
              );
            }
            taskType = autoDetected;
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
          spinner = ctx.createSpinner('Creating extraction task...');

          const taskName = path.basename(inputFile, ext);
          let task = await client.addTask(spaceId, [fileId], taskType, taskName);

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          // Wait for completion
          if (wait) {
            spinner = ctx.createSpinner('Processing...');

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10));

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Extraction completed');
            } else {
              ctx.failSpinner(spinner, 'Extraction failed');
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Extraction Task:')}`,
              `  Task ID: ${chalk.cyan(t.id)}`,
              `  Status: ${t.status === 'completed' ? chalk.green(t.status) : chalk.yellow(t.status)}`,
            ];

            if (t.result) {
              lines.push(`  Result: ${JSON.stringify(t.result, null, 2)}`);
            }

            return lines.join('\n');
          });
        } catch (error) {
          ctx.error(error);
        }
      }
    );
}
