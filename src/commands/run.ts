/**
 * Run command - Execute task with explicit type
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { Context } from '../context.js';
import { DEFAULT_TIMEOUT } from '../utils/constants.js';

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
    .action(
      async (
        taskType: string,
        inputFiles: string[],
        options: { param?: string[]; wait?: boolean; timeout: string }
      ) => {
        const wait = options.wait !== false;
        try {
          const client = await ctx.getClient();
          const uploader = await ctx.getUploader();
          const spaceId = ctx.config.spaceId;
          if (!spaceId) {
            ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
          }

          // Parse parameters
          const params: Record<string, unknown> = {};
          if (options.param) {
            for (const p of options.param) {
              if (!p.includes('=')) {
                ctx.error(`Invalid parameter format: ${p}\nExpected: key=value`, 'INVALID_PARAM');
              }

              const [key, value] = p.split('=', 2);
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
            if (!ctx.jsonOutput) {
              spinner = ora(`Uploading ${path.basename(inputFile)}...`).start();
            }

            const fileId = await uploader.uploadFile(spaceId, inputFile, (progress) => {
              if (spinner) {
                spinner.text = `Uploading ${path.basename(inputFile)}: ${(progress * 100).toFixed(1)}%`;
              }
            });

            fileIds.push(fileId);

            if (spinner) {
              spinner.succeed(`Uploaded ${path.basename(inputFile)}`);
            }
          }

          // Create task
          if (!ctx.jsonOutput) {
            spinner = ora('Creating task...').start();
          }

          const taskName = inputFiles.length > 0 ? path.basename(inputFiles[0]) : undefined;
          let task = await client.addTask(spaceId, fileIds, taskType, taskName, params);

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
                spinner.succeed('Task completed');
              } else {
                spinner.fail('Task failed');
              }
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
          ctx.error((error as Error).message);
        }
      }
    );
}
