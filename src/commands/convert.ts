/**
 * Convert command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import { RENDER_FORMATS, DEFAULT_TIMEOUT } from '../utils/constants.js';

function parseBooleanOption(value: string | boolean | undefined): boolean {
  if (value === undefined || value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}. Expected true or false.`);
}

/**
 * Register convert command
 */
export function registerConvertCommand(program: Command, ctx: Context): void {
  program
    .command('convert <input-files...>')
    .description('Convert file(s) to different format')
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
    .option(
      '--need-embed-fonts [boolean]',
      'Whether to embed fonts for html->pptx conversion (default: false)',
      parseBooleanOption,
      false
    )
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFiles: string[],
        options: {
          to: string;
          wait?: boolean;
          timeout: string;
          width?: string;
          height?: string;
          needEmbedFonts: boolean;
        }
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
          const formatMap = RENDER_FORMATS[options.to];

          if (!formatMap) {
            const supportedFormats = Object.keys(RENDER_FORMATS).join(', ');
            ctx.error(
              `Unsupported output format: ${options.to}\nSupported: ${supportedFormats}`,
              'UNSUPPORTED_FORMAT'
            );
          }

          const taskTypes: string[] = inputFiles.map((inputFile) => {
            const ext = path.extname(inputFile).toLowerCase();
            const mappedTaskType = formatMap[ext];
            if (!mappedTaskType) {
              const supportedExts = Object.keys(formatMap).join(', ');
              ctx.error(
                `Cannot convert ${ext} to ${options.to}\nSupported input types: ${supportedExts}`,
                'UNSUPPORTED_CONVERSION'
              );
            }
            return mappedTaskType as string;
          });

          const uniqueTaskTypes = Array.from(new Set(taskTypes));
          if (uniqueTaskTypes.length !== 1) {
            ctx.error(
              'All input files must map to the same conversion task type.',
              'MIXED_CONVERSION_TYPES'
            );
          }
          const taskType = uniqueTaskTypes[0];
          if (!taskType) {
            ctx.error('Failed to determine conversion task type.', 'UNKNOWN_TASK_TYPE');
          }

          if (taskType !== 'convertor.html2pptx' && inputFiles.length > 1) {
            ctx.error(
              'Multiple input files are currently only supported for html -> pptx conversion.',
              'MULTI_INPUT_NOT_SUPPORTED'
            );
          }

          // Upload file(s)
          const fileIds: string[] = [];
          const total = inputFiles.length;
          let index = 0;
          let spinner: any;

          for (const inputFile of inputFiles) {
            index += 1;
            const baseName = path.basename(inputFile);
            spinner = ctx.createSpinner(`Uploading [${index}/${total}] ${baseName}...`);

            const fileId = await uploader.uploadFile(spaceId, inputFile, (progress) => {
              if (spinner) {
                spinner.text = `Uploading [${index}/${total}] ${baseName}: ${(progress * 100).toFixed(1)}%`;
              }
            });

            fileIds.push(fileId);

            ctx.succeedSpinner(spinner, `Uploaded [${index}/${total}] ${baseName}`);
          }

          // Create task
          spinner = ctx.createSpinner('Creating conversion task...');

          const firstFile = inputFiles[0];
          const firstExt = firstFile ? path.extname(firstFile).toLowerCase() : '';
          const taskName = firstFile ? path.basename(firstFile, firstExt) : undefined;
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

          if (taskType === 'convertor.html2pptx') {
            params.needEmbedFonts = options.needEmbedFonts ?? false;
          }

          let task = await client.addTask(spaceId, fileIds, taskType, taskName, params);

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          // Wait for completion
          if (wait) {
            spinner = ctx.createSpinner('Converting...');

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10));

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Conversion completed');
            } else {
              ctx.failSpinner(spinner, 'Conversion failed');
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
          ctx.error(error);
        }
      }
    );
}
