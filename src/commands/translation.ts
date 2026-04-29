/**
 * Translation command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import {
  DEFAULT_TIMEOUT,
  SUPPORTED_SOURCE_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  TRANSLATION_FILE_EXTENSIONS,
  TRANSLATE_MODELS,
  PDF_TRANSLATE_MODELS,
} from '../utils/constants.js';
import type { TranslateEngine } from '../types/tasks.js';

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
 * Register translation command
 */
export function registerTranslationCommand(program: Command, ctx: Context): void {
  program
    .command('translation <input-file>')
    .description('Translate a document file')
    .requiredOption(
      '--from <language>',
      `Source language (${SUPPORTED_SOURCE_LANGUAGES.join(', ')})`
    )
    .requiredOption('--to <language>', `Target language (${SUPPORTED_TARGET_LANGUAGES.join(', ')})`)
    .option('--engine <engine>', 'Translation engine (gemini, openai, deepl)')
    .option('--model <model>', 'Translation model')
    .option('--use-glossary [boolean]', 'Use glossary', parseBooleanOption, false)
    .option('--image-translate [boolean]', 'Translate images', parseBooleanOption, false)
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFile: string,
        options: {
          from: string;
          to: string;
          engine?: string;
          model?: string;
          useGlossary: boolean;
          imageTranslate: boolean;
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
          if (!TRANSLATION_FILE_EXTENSIONS.includes(ext as (typeof TRANSLATION_FILE_EXTENSIONS)[number])) {
            ctx.error(
              `Unsupported file type: ${ext}\nSupported: ${TRANSLATION_FILE_EXTENSIONS.join(', ')}`,
              'UNSUPPORTED_TYPE'
            );
          }

          const resolvedEngine = (options.engine ?? 'gemini') as string;
          if (!Object.hasOwn(TRANSLATE_MODELS, resolvedEngine)) {
            ctx.error(
              `Unsupported translation engine: ${resolvedEngine}\nSupported: ${Object.keys(TRANSLATE_MODELS).join(', ')}`,
              'INVALID_TRANSLATE_ENGINE'
            );
          }

          const engine = resolvedEngine as TranslateEngine;
          let allowedModels: readonly string[];

          if (ext === '.pdf') {
            if (!Object.hasOwn(PDF_TRANSLATE_MODELS, engine)) {
              ctx.error(
                `${resolvedEngine} does not support ${ext} translation`,
                'ENGINE_FILE_TYPE_NOT_SUPPORTED'
              );
            }
            allowedModels = PDF_TRANSLATE_MODELS[engine as keyof typeof PDF_TRANSLATE_MODELS].models;
          } else {
            allowedModels = TRANSLATE_MODELS[engine].models;
          }

          const resolvedModel =
            options.model ??
            (options.engine ? allowedModels[0] : engine === 'gemini' ? 'gemini-flash' : allowedModels[0]);
          if (!resolvedModel) {
            ctx.error(`No available model for engine ${engine}`, 'NO_DEFAULT_TRANSLATE_MODEL');
          }

          if (!allowedModels.includes(resolvedModel)) {
            ctx.error(
              `Unsupported model ${resolvedModel} for engine ${engine}\nSupported: ${allowedModels.join(', ')}`,
              'INVALID_TRANSLATE_MODEL'
            );
          }

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
            engine,
            model: resolvedModel,
            useGlossary: options.useGlossary,
            imageTranslate: options.imageTranslate,
          };

          let task = await client.addTask(spaceId, [fileId], 'translation', taskName, params);

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          if (wait) {
            spinner = ctx.createSpinner('Translating...');
            task = await client.waitForTask(task.id, Number.parseInt(options.timeout, 10));

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Translation completed');
            } else {
              ctx.failSpinner(spinner, 'Translation failed');
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
          ctx.error((error as Error).message);
        }
      }
    );
}
