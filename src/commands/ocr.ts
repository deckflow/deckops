/**
 * OCR command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { Context } from '../context.js';
import { DEFAULT_TIMEOUT, DEFAULT_OCR_LANGUAGE, OCR_LANGUAGES } from '../utils/constants.js';

/**
 * Register OCR command
 */
export function registerOcrCommand(program: Command, ctx: Context): void {
  program
    .command('ocr <input-file>')
    .description('Extract text from images using OCR')
    .option('--language <lang>', `OCR language (${OCR_LANGUAGES.join(', ')})`, DEFAULT_OCR_LANGUAGE)
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFile: string,
        options: { language: string; wait?: boolean; timeout: string }
      ) => {
        const wait = options.wait !== false;
        try {
          const client = await ctx.getClient();
          const uploader = await ctx.getUploader();
          const spaceId = ctx.config.spaceId;
          if (!spaceId) {
            ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
          }

          // Validate language
          if (!OCR_LANGUAGES.includes(options.language as any)) {
            ctx.error(
              `Unsupported language: ${options.language}\nSupported: ${OCR_LANGUAGES.join(', ')}`,
              'INVALID_LANGUAGE'
            );
          }

          // Validate file extension
          const ext = path.extname(inputFile).toLowerCase();
          const supportedExts = ['.jpg', '.jpeg', '.png'];
          if (!supportedExts.includes(ext)) {
            ctx.error(
              `Unsupported file type: ${ext}\nSupported: ${supportedExts.join(', ')}`,
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

          // Create OCR task
          if (!ctx.jsonOutput) {
            spinner = ora('Creating OCR task...').start();
          }

          const taskName = path.basename(inputFile, ext);
          const taskType = 'image.ocr';
          const params = { language: options.language };

          let task = await client.addTask(spaceId, [fileId], taskType, taskName, params);

          if (spinner) {
            spinner.succeed(`Task created: ${task.id}`);
          }

          // Wait for completion
          if (options.wait) {
            if (!ctx.jsonOutput) {
              spinner = ora('Processing OCR...').start();
            }

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10));

            if (spinner) {
              if (task.status === 'completed') {
                spinner.succeed('OCR completed');
              } else {
                spinner.fail('OCR failed');
              }
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('OCR Task:')}`,
              `  Task ID: ${chalk.cyan(t.id)}`,
              `  Language: ${options.language}`,
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
