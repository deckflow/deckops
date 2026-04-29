/**
 * Generation command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import { DEFAULT_TIMEOUT, GENERATION_FILE_EXTENSIONS } from '../utils/constants.js';

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
 * Register generation command
 */
export function registerGenerationCommand(program: Command, ctx: Context): void {
  program
    .command('generation [input-files...]')
    .description('Generate document content')
    .option('--input-text <text>', 'Input text from user')
    .option('--enable-search [boolean]', 'Enable search', parseBooleanOption)
    .option('--advanced-model [boolean]', 'Use advanced model', parseBooleanOption)
    .option('--fast-mode [boolean]', 'Enable fast mode', parseBooleanOption)
    .option('--intent <intent>', 'Content generation intent')
    .option('--audience <audience>', 'Target audience')
    .option('--page-count <number>', 'Expected page count')
    .option('--author <name>', 'Document author')
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFiles: string[],
        options: {
          inputText?: string;
          enableSearch?: boolean;
          advancedModel?: boolean;
          fastMode?: boolean;
          intent?: string;
          audience?: string;
          pageCount?: string;
          author?: string;
          wait?: boolean;
          timeout: string;
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

          if (!options.inputText && inputFiles.length === 0) {
            ctx.error(
              'At least one of --input-text or input file is required.',
              'GENERATION_INPUT_REQUIRED'
            );
          }

          if (inputFiles.length > 2) {
            ctx.error('Generation allows up to 2 reference files.', 'GENERATION_TOO_MANY_FILES');
          }

          for (const inputFile of inputFiles) {
            const ext = path.extname(inputFile).toLowerCase();
            if (!GENERATION_FILE_EXTENSIONS.includes(ext as (typeof GENERATION_FILE_EXTENSIONS)[number])) {
              ctx.error(
                `Unsupported file type: ${ext}\nSupported: ${GENERATION_FILE_EXTENSIONS.join(', ')}`,
                'UNSUPPORTED_TYPE'
              );
            }
          }

          const params: Record<string, unknown> = {};
          if (options.inputText !== undefined) params.inputText = options.inputText;
          if (options.enableSearch !== undefined) params.enableSearch = options.enableSearch;
          if (options.advancedModel !== undefined) params.advancedModel = options.advancedModel;
          if (options.fastMode !== undefined) params.fastMode = options.fastMode;
          if (options.intent !== undefined) params.intent = options.intent;
          if (options.audience !== undefined) params.audience = options.audience;
          if (options.author !== undefined) params.author = options.author;

          if (options.pageCount !== undefined) {
            const pageCount = Number.parseInt(options.pageCount, 10);
            if (!Number.isInteger(pageCount) || pageCount <= 0) {
              ctx.error(
                `Invalid --page-count: ${options.pageCount}\nExpected: a positive integer`,
                'INVALID_PAGE_COUNT'
              );
            }
            params.pageCount = pageCount;
          }

          const fileIds: string[] = [];
          let spinner: any;

          for (const inputFile of inputFiles) {
            spinner = ctx.createSpinner(`Uploading ${path.basename(inputFile)}...`);

            const fileId = await uploader.uploadFile(spaceId, inputFile, (progress) => {
              if (spinner) {
                spinner.text = `Uploading ${path.basename(inputFile)}: ${(progress * 100).toFixed(1)}%`;
              }
            });

            fileIds.push(fileId);
            ctx.succeedSpinner(spinner, `Uploaded ${path.basename(inputFile)}`);
          }

          spinner = ctx.createSpinner('Creating generation task...');

          const firstFile = inputFiles[0];
          const taskName = firstFile ? path.basename(firstFile) : options.intent || 'generation';
          let task = await client.addTask(spaceId, fileIds, 'generation', taskName, params);

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          if (wait) {
            spinner = ctx.createSpinner('Generating...');
            task = await client.waitForTask(task.id, Number.parseInt(options.timeout, 10));

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Generation completed');
            } else {
              ctx.failSpinner(spinner, 'Generation failed');
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Generation Task:')}`,
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
