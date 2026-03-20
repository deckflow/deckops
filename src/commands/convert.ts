/**
 * Convert command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { Context } from '../context.js';
import { RENDER_FORMATS, DEFAULT_TIMEOUT } from '../utils/constants.js';

/**
 * Register convert command
 */
export function registerConvertCommand(program: Command, ctx: Context): void {
  program
    .command('convert <input-file>')
    .description('Convert a file to different format')
    .requiredOption(
      '--to <format>',
      'Output format: image, pdf, video, html, png, pptx, webp'
    )
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (inputFile: string, options: { to: string; wait?: boolean; timeout: string }) => {
        const wait = options.wait !== false;
        try {
          const client = ctx.getClient();
          const uploader = ctx.getUploader();
          const spaceId = ctx.config.spaceId;

          // Determine task type
          const ext = path.extname(inputFile).toLowerCase();
          const formatMap = RENDER_FORMATS[options.to];

          if (!formatMap) {
            const supportedFormats = Object.keys(RENDER_FORMATS).join(', ');
            ctx.error(
              `Unsupported output format: ${options.to}\nSupported: ${supportedFormats}`,
              'UNSUPPORTED_FORMAT'
            );
          }

          const taskType = formatMap[ext];
          if (!taskType) {
            const supportedExts = Object.keys(formatMap).join(', ');
            ctx.error(
              `Cannot convert ${ext} to ${options.to}\nSupported input types: ${supportedExts}`,
              'UNSUPPORTED_CONVERSION'
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
            spinner = ora('Creating conversion task...').start();
          }

          const taskName = path.basename(inputFile, ext);
          let task = await client.addTask(spaceId, [fileId], taskType, taskName);

          if (spinner) {
            spinner.succeed(`Task created: ${task.id}`);
          }

          // Wait for completion
          if (options.wait) {
            if (!ctx.jsonOutput) {
              spinner = ora('Converting...').start();
            }

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10));

            if (spinner) {
              if (task.status === 'completed') {
                spinner.succeed('Conversion completed');
              } else {
                spinner.fail('Conversion failed');
              }
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Conversion Task:')}`,
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
      }
    );
}
