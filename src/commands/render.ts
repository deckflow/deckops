/**
 * Render command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { Context } from '../context.js';
import { RENDER_FORMATS, DEFAULT_TIMEOUT } from '../utils/constants.js';

/**
 * Register render command
 */
export function registerRenderCommand(program: Command, ctx: Context): void {
  program
    .command('render <input-file>')
    .description('Render/convert a file to different format')
    .requiredOption(
      '--format <format>',
      'Output format: image, pdf, video, html, png, pptx, webp'
    )
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (inputFile: string, options: { format: string; wait?: boolean; timeout: string }) => {
        const wait = options.wait !== false;
        try {
          const client = ctx.getClient();
          const uploader = ctx.getUploader();
          const spaceId = ctx.config.spaceId!;

          // Determine task type
          const ext = path.extname(inputFile).toLowerCase();
          const formatMap = RENDER_FORMATS[options.format];

          if (!formatMap) {
            const supportedFormats = Object.keys(RENDER_FORMATS).join(', ');
            ctx.error(
              `Unsupported output format: ${options.format}\nSupported: ${supportedFormats}`,
              'UNSUPPORTED_FORMAT'
            );
          }

          const taskType = formatMap[ext];
          if (!taskType) {
            const supportedExts = Object.keys(formatMap).join(', ');
            ctx.error(
              `Cannot render ${ext} to ${options.format}\nSupported input types: ${supportedExts}`,
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
            spinner = ora('Creating render task...').start();
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

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10));

            if (spinner) {
              if (task.status === 'completed') {
                spinner.succeed('Render completed');
              } else {
                spinner.fail('Render failed');
              }
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Render Task:')}`,
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
