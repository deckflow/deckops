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
    .option(
      '--width <number>',
      'Width for html->pptx/html->png conversion (only applies to .html --to pptx/png)'
    )
    .option(
      '--height <number>',
      'Height for html->pptx/html->png conversion (only applies to .html --to pptx/png)'
    )
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFile: string,
        options: { to: string; wait?: boolean; timeout: string; width?: string; height?: string }
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
          const params: Record<string, unknown> = {};

          // Only pass width/height for html -> pptx / html -> png
          if (taskType === 'convertor.html2pptx' || taskType === 'convertor.html2png') {
            if (options.width !== undefined) {
              const width = Number(options.width);
              if (!Number.isFinite(width) || width <= 0) {
                ctx.error(`Invalid --width: ${options.width}\nExpected: a positive number`, 'INVALID_WIDTH');
              }
              params.width = width;
            }
            if (options.height !== undefined) {
              const height = Number(options.height);
              if (!Number.isFinite(height) || height <= 0) {
                ctx.error(
                  `Invalid --height: ${options.height}\nExpected: a positive number`,
                  'INVALID_HEIGHT'
                );
              }
              params.height = height;
            }
          }

          let task = await client.addTask(spaceId, [fileId], taskType, taskName, params);

          if (spinner) {
            spinner.succeed(`Task created: ${task.id}`);
          }

          // Wait for completion
          if (wait) {
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
