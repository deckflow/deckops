/**
 * Join command - Merge multiple pptx files into one (pptx.join)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { Context } from '../context.js';
import { DEFAULT_TIMEOUT } from '../utils/constants.js';

const PPTX_JOIN_TASK_TYPE = 'pptx.join';
const PPTX_EXT = '.pptx';

/**
 * Register pptx join command
 */
export function registerJoinCommand(program: Command, ctx: Context): void {
  program
    .command('join <input-files...>')
    .description('Merge multiple pptx files into one (in the given order)')
    .option('--name <name>', 'Output task name (defaults to first input file name)')
    .option('--no-wait', 'Do not wait for task completion')
    .option('--timeout <seconds>', 'Timeout in seconds', String(DEFAULT_TIMEOUT))
    .action(
      async (
        inputFiles: string[],
        options: { name?: string; wait?: boolean; timeout: string }
      ) => {
        const wait = options.wait !== false;
        try {
          if (inputFiles.length < 2) {
            ctx.error(
              `Join requires at least 2 pptx files, got ${inputFiles.length}`,
              'INVALID_ARGS'
            );
          }

          // Validate every input is a .pptx file
          const invalid = inputFiles.filter(
            (f) => path.extname(f).toLowerCase() !== PPTX_EXT
          );
          if (invalid.length > 0) {
            ctx.error(
              `Only .pptx files are supported. Invalid file(s): ${invalid.join(', ')}`,
              'UNSUPPORTED_TYPE'
            );
          }

          const client = await ctx.getClient();
          const uploader = await ctx.getUploader();
          const spaceId = ctx.config.spaceId;
          if (!spaceId) {
            ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
            return;
          }

          // Upload files sequentially to preserve the requested order
          const fileIds: string[] = [];
          const total = inputFiles.length;
          let spinner: any;
          let index = 0;

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

          // Create pptx.join task
          spinner = ctx.createSpinner('Creating pptx.join task...');

          const firstFile = inputFiles[0];
          const taskName =
            options.name || (firstFile ? path.basename(firstFile, PPTX_EXT) : undefined);

          let task = await client.addTask(
            spaceId,
            fileIds,
            PPTX_JOIN_TASK_TYPE,
            taskName
          );

          ctx.succeedSpinner(spinner, `Task created: ${task.id}`);

          // Wait for completion
          if (wait) {
            spinner = ctx.createSpinner('Joining pptx files...');

            task = await client.waitForTask(task.id, parseInt(options.timeout, 10), true, (t) => {
              if (spinner && t.status === 'running') {
                spinner.text = 'Joining pptx files...';
              }
            });

            if (task.status === 'completed') {
              ctx.succeedSpinner(spinner, 'Join completed');
            } else {
              ctx.failSpinner(spinner, 'Join failed');
            }
          }

          ctx.output(task, (t) => {
            const lines = [
              `${chalk.bold('Join Task:')}`,
              `  Task ID: ${chalk.cyan(t.id)}`,
              `  Type: ${t.type}`,
              `  Inputs: ${inputFiles.length} file(s)`,
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
