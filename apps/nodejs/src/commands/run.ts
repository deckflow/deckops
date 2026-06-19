/**
 * Run command - Execute task with explicit type
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import {
  DEFAULT_TIMEOUT,
  MULTI_SOURCE_TASK_TYPES,
  supportsMultipleSourceFiles,
} from '../utils/constants.js';

/**
 * Collect multiple values
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Register run command
 */
export function registerRunCommand(program: Command, ctx: Context): void {
  program
    .command('run <task-type> <input-files...>')
    .description('Run a task with explicit type')
    .option('--param <key=value>', 'Task parameters (can be used multiple times)', collect, [])
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .addHelpText(
      'after',
      `
Examples:
  $ deckops run convertor.ppt2pdf demo.ppt
  $ deckops run pptx.join part1.pptx part2.pptx
  $ deckops run convertor.html2pptx page1.html page2.html

Multiple input files are passed as one ordered source set only for: ${MULTI_SOURCE_TASK_TYPES.join(', ')}.`
    )
    .action(
      async (
        taskType: string,
        inputFiles: string[],
        options: { param?: string[]; wait?: boolean; timeout: string }
      ) => {
        const wait = options.wait !== false;
        try {
          if (inputFiles.length > 1 && !supportsMultipleSourceFiles(taskType)) {
            ctx.error(
              `Task ${taskType} does not support multiple source files. Supported multi-source task types: ${MULTI_SOURCE_TASK_TYPES.join(', ')}`,
              'MULTI_INPUT_NOT_SUPPORTED'
            );
          }

          const client = await ctx.getClient();
          const uploader = await ctx.getUploader();
          const spaceId = ctx.config.spaceId;
          if (!spaceId) {
            ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
            return;
          }

          // Parse parameters
          const params: Record<string, unknown> = {};
          if (options.param) {
            for (const p of options.param) {
              if (!p.includes('=')) {
                ctx.error(`Invalid parameter format: ${p}\nExpected: key=value`, 'INVALID_PARAM');
              }

              const idx = p.indexOf('=');
              const key = p.slice(0, idx);
              const value = p.slice(idx + 1);
              // Try to parse as JSON, fallback to string
              try {
                params[key] = JSON.parse(value);
              } catch {
                params[key] = value;
              }
            }
          }

          // Upload files
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

          // Create task
          spinner = ctx.createSpinner('Creating task...');

          const firstFile = inputFiles[0];
          const taskName = firstFile ? path.basename(firstFile) : undefined;
          let task = await client.addTask(spaceId, fileIds, taskType, taskName, params);

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          // Wait for completion
          if (wait) {
            spinner = ctx.createSpinner('Processing...');

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10));

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Task completed');
            } else {
              ctx.failSpinner(spinner, 'Task failed');
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Task:')}`,
              `  Task ID: ${chalk.cyan(t.id)}`,
              `  Type: ${t.type}`,
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
