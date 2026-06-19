/**
 * Translation command
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import {
  DEFAULT_TIMEOUT,
  SUPPORTED_SOURCE_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  TRANSLATION_FILE_EXTENSIONS,
} from '../utils/constants.js';
import { parsePositiveInteger } from '../utils/parse.js';

const TRANSLATION_MODELS = ['Standard', 'Pro'] as const;
type TranslationModel = (typeof TRANSLATION_MODELS)[number];

function normalizeModel(value: string): TranslationModel {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'standard') return 'Standard';
  if (trimmed.toLowerCase() === 'pro') return 'Pro';
  throw new Error(`Invalid model: ${value}. Expected one of: ${TRANSLATION_MODELS.join(', ')}`);
}

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
 * Register translate command
 */
export function registerTranslationCommand(program: Command, ctx: Context): void {
  program
    .command('translate <input-file>')
    .description('Translate a document file')
    .addOption(
      new Option('--from <language>', `Source language (${SUPPORTED_SOURCE_LANGUAGES.join(', ')})`)
        .choices([...SUPPORTED_SOURCE_LANGUAGES])
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option('--to <language>', `Target language (${SUPPORTED_TARGET_LANGUAGES.join(', ')})`)
        .choices([...SUPPORTED_TARGET_LANGUAGES])
        .makeOptionMandatory(true)
    )
    .addOption(
      new Option('--model <model>', `Translation model (${TRANSLATION_MODELS.join(', ')})`)
        .choices([...TRANSLATION_MODELS])
        .makeOptionMandatory(true)
    )
    .option('--use-glossary [boolean]', 'Use glossary', parseBooleanOption, false)
    .option('--image-translate [boolean]', 'Translate images', parseBooleanOption, false)
    .option('-o, --out <path>', 'Write completed task output to a file or directory')
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFile: string,
        options: {
          from: string;
          to: string;
          model: string;
          useGlossary: boolean;
          imageTranslate: boolean;
          out?: string;
          wait?: boolean;
          timeout: string;
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

          if (
            !SUPPORTED_SOURCE_LANGUAGES.includes(
              options.from as (typeof SUPPORTED_SOURCE_LANGUAGES)[number]
            )
          ) {
            ctx.error(
              `Unsupported source language: ${options.from}\nSupported: ${SUPPORTED_SOURCE_LANGUAGES.join(', ')}`,
              'INVALID_SOURCE_LANGUAGE'
            );
          }

          if (
            !SUPPORTED_TARGET_LANGUAGES.includes(
              options.to as (typeof SUPPORTED_TARGET_LANGUAGES)[number]
            )
          ) {
            ctx.error(
              `Unsupported target language: ${options.to}\nSupported: ${SUPPORTED_TARGET_LANGUAGES.join(', ')}`,
              'INVALID_TARGET_LANGUAGE'
            );
          }

          const ext = path.extname(inputFile).toLowerCase();
          if (
            !TRANSLATION_FILE_EXTENSIONS.includes(ext as (typeof TRANSLATION_FILE_EXTENSIONS)[number])
          ) {
            ctx.error(
              `Unsupported file type: ${ext}\nSupported: ${TRANSLATION_FILE_EXTENSIONS.join(', ')}`,
              'UNSUPPORTED_TYPE'
            );
          }

          const resolvedModel = normalizeModel(options.model);

          let spinner: any = ctx.createSpinner(`Uploading ${path.basename(inputFile)}...`);

          const fileId = await uploader.uploadFile(spaceId, inputFile, (progress) => {
            if (spinner) {
              spinner.text = `Uploading ${path.basename(inputFile)}: ${(progress * 100).toFixed(1)}%`;
            }
          });

          ctx.succeedSpinner(spinner, `Uploaded ${path.basename(inputFile)}`);

          spinner = ctx.createSpinner('Creating translation task...');

          const taskName = path.basename(inputFile, ext);
          const params = {
            from: options.from,
            to: options.to,
            model: resolvedModel,
            useGlossary: options.useGlossary,
            imageTranslate: options.imageTranslate,
          };

          let task = await client.addTask(spaceId, [fileId], 'translation', taskName, params);

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          if (wait) {
            spinner = ctx.createSpinner('Translating...');
            task = await client.waitForTask(task.id, parsePositiveInteger(options.timeout, '--timeout'));

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Translation completed');
            } else {
              ctx.failSpinner(spinner, 'Translation failed');
            }
          }

          if (options.out) {
            const outputResult = await ctx.tryWriteTaskOutput(task, options.out);
            if (outputResult) {
              ctx.outputTaskSaved(outputResult);
              return;
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Translation Task:')}`,
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
