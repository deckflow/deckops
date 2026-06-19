/**
 * Convert command
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import {
  RENDER_FORMATS,
  DEFAULT_TIMEOUT,
  MULTI_SOURCE_CONVERT_TASK_TYPES,
  supportsMultipleConvertSourceFiles,
} from '../utils/constants.js';

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
    .description('Convert file(s) to a different format')
    .addOption(
      new Option('--to <format>', 'Output format: image, pdf, video, html, png, pptx, webp')
        .choices(Object.keys(RENDER_FORMATS))
        .makeOptionMandatory(true)
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
    .option('-o, --out <path>', 'Write completed task output to a file or directory')
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .addHelpText(
      'after',
      `
Examples:
  $ deckops convert slides.pptx --to pdf
  $ deckops convert page1.html page2.html --to pptx

Multiple input files create one ordered conversion task only for html -> pptx.`
    )
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
          out?: string;
        }
      ) => {
        const wait = options.wait !== false || Boolean(options.out);
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

          if (inputFiles.length > 1 && !supportsMultipleConvertSourceFiles(taskType)) {
            ctx.error(
              `Multiple input files for one conversion task are only supported by: ${MULTI_SOURCE_CONVERT_TASK_TYPES.join(', ')}`,
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

          let outputResult: unknown;
          if (options.out) {
            if (task.status !== 'completed') {
              ctx.error('Cannot write --out because the task did not complete.', 'TASK_NOT_COMPLETED');
            }
            spinner = ctx.createSpinner('Downloading result...');
            outputResult = await ctx.writeTaskOutput(task, options.out);
            ctx.succeedSpinner(spinner, 'Result saved');
          }

          ctx.output(outputResult ? { ...task, output: outputResult } : task, (t) => {
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
