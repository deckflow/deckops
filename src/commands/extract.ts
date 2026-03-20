/**
 * Extract command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { Context } from '../context.js';
import { EXTRACT_TYPES, EXTRACT_TYPE_MAP, DEFAULT_TIMEOUT, DEFAULT_OCR_LANGUAGE } from '../utils/constants.js';

/**
 * Register extract command
 */
export function registerExtractCommand(program: Command, ctx: Context): void {
  program
    .command('extract <input-file>')
    .description('Extract information from a file')
    .option('--type <type>', 'Extract type: ocr, fonts, text-shapes')
    .option('--language <lang>', 'OCR language', DEFAULT_OCR_LANGUAGE)
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFile: string,
        options: { type?: string; language: string; wait?: boolean; timeout: string }
      ) => {
        const wait = options.wait !== false;
        try {
          const client = ctx.getClient();
          const uploader = ctx.getUploader();
          const spaceId = ctx.config.spaceId!;

          // Determine task type
          const ext = path.extname(inputFile).toLowerCase();
          let taskType: string;

          if (options.type) {
            taskType = EXTRACT_TYPE_MAP[options.type];
            if (!taskType) {
              const supportedTypes = Object.keys(EXTRACT_TYPE_MAP).join(', ');
              ctx.error(
                `Unknown extract type: ${options.type}\nSupported: ${supportedTypes}`,
                'INVALID_TYPE'
              );
            }
          } else {
            taskType = EXTRACT_TYPES[ext];
            if (!taskType) {
              ctx.error(
                `Cannot auto-detect extract type for: ${ext}\nPlease specify --type`,
                'UNSUPPORTED_TYPE'
              );
            }
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

          // Build params
          const params: Record<string, unknown> = {};
          if (taskType === 'image.ocr') {
            params.language = options.language;
          }

          // Create task
          if (!ctx.jsonOutput) {
            spinner = ora('Creating extraction task...').start();
          }

          const taskName = path.basename(inputFile, ext);
          let task = await client.addTask(spaceId, [fileId], taskType, taskName, params);

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
                spinner.succeed('Extraction completed');
              } else {
                spinner.fail('Extraction failed');
              }
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
          ctx.error((error as Error).message);
        }
      }
    );
}
