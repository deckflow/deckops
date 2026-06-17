/**
 * Task commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { Context } from '../context.js';
import type { Task } from '../types/api.js';

/**
 * Register task commands
 */
export function registerTaskCommands(program: Command, ctx: Context): void {
  const task = program.command('task').description('Manage tasks');

  // task list
  task
    .command('list')
    .description('List all tasks')
    .option('--type <type>', 'Filter by task type')
    .option('--limit <n>', 'Maximum number of results', '50')
    .option('--offset <n>', 'Start index for pagination', '0')
    .action(async (options: { type?: string; limit: string; offset: string }) => {
      try {
        const client = await ctx.getClient();
        const spaceId = ctx.config.spaceId;

        if (!spaceId) {
          ctx.error('Space ID missing. Please run `deckflow login` first.', 'NO_SPACE_ID');
        }

        const result = await client.listTasks(
          spaceId,
          options.type,
          parseInt(options.offset, 10),
          parseInt(options.limit, 10)
        );

        ctx.output(result, (data) => {
          if (data.tasks.length === 0) {
            return chalk.yellow('No tasks found');
          }

          const lines = [`Found ${chalk.cyan(data.total)} tasks:\n`];
          data.tasks.forEach((task: Task) => {
            const statusColor =
              task.status === 'completed'
                ? chalk.green
                : task.status === 'failed'
                ? chalk.red
                : task.status === 'running'
                ? chalk.blue
                : chalk.gray;

            lines.push(
              `  ${chalk.cyan(task.id)} - ${statusColor(task.status)} - ${task.type}`
            );
          });
          return lines.join('\n');
        });
      } catch (error) {
        ctx.error(error);
      }
    });

  // task get
  task
    .command('get <task-id>')
    .description('Get task details')
    .action(async (taskId: string) => {
      try {
        const client = await ctx.getClient();
        const taskData = await client.getTask(taskId);

        ctx.output(taskData, (task) => {
          const statusColor =
            task.status === 'completed'
              ? chalk.green
              : task.status === 'failed'
              ? chalk.red
              : task.status === 'running'
              ? chalk.blue
              : chalk.gray;

          const lines = [
            `${chalk.bold('Task Details:')}`,
            `  ID: ${chalk.cyan(task.id)}`,
            `  Type: ${task.type}`,
            `  Status: ${statusColor(task.status)}`,
          ];

          if (task.name) {
            lines.push(`  Name: ${task.name}`);
          }

          if (task.error) {
            lines.push(`  Error: ${chalk.red(task.error)}`);
          }

          if (task.result) {
            lines.push(`  Result: ${JSON.stringify(task.result, null, 2)}`);
          }

          return lines.join('\n');
        });
      } catch (error) {
        ctx.error(error);
      }
    });

  // task delete
  task
    .command('delete <task-id>')
    .description('Delete a task')
    .action(async (taskId: string) => {
      try {
        const client = await ctx.getClient();
        await client.deleteTask(taskId);

        ctx.output(
          { taskId, deleted: true },
          () => `${chalk.green('✓')} Task ${chalk.cyan(taskId)} deleted`
        );
      } catch (error) {
        ctx.error(error);
      }
    });
}
