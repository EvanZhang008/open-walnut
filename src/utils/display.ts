import chalk from 'chalk';
import type { Task, DashboardData } from '../core/types.js';
import { statusSymbol, prioritySymbol, shortDate } from './format.js';

function getWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 100);
}

function boxTop(width: number): string {
  return '┌' + '─'.repeat(width - 2) + '┐';
}

function boxBottom(width: number): string {
  return '└' + '─'.repeat(width - 2) + '┘';
}

function boxDivider(width: number): string {
  return '├' + '─'.repeat(width - 2) + '┤';
}

function boxLine(text: string, width: number): string {
  const stripped = stripAnsi(text);
  const pad = width - 4 - stripped.length;
  if (pad < 0) {
    // Truncate the visible text to fit
    const maxLen = width - 4;
    return '│ ' + truncateAnsi(text, maxLen) + ' │';
  }
  return '│ ' + text + ' '.repeat(pad) + ' │';
}

function boxEmpty(width: number): string {
  return '│' + ' '.repeat(width - 2) + '│';
}

/**
 * Strip ANSI escape codes for length calculation.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate a string that may contain ANSI codes to a visible length.
 */
function truncateAnsi(str: string, maxLen: number): string {
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < maxLen) {
    if (str[i] === '\x1b') {
      const end = str.indexOf('m', i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visible++;
    i++;
  }
  // Include any trailing ANSI reset sequences
  let rest = str.slice(i);
  const resets: string[] = [];
  const ansiRe = /^\x1b\[[0-9;]*m/;
  let match = ansiRe.exec(rest);
  while (match) {
    resets.push(match[0]);
    rest = rest.slice(match[0].length);
    match = ansiRe.exec(rest);
  }
  return str.slice(0, i) + resets.join('');
}

function formatTaskLine(task: Task, maxTitleLen: number): string {
  const sym = statusSymbol(task.status);
  const pri = prioritySymbol(task.priority);
  const id = task.id.slice(0, 8);
  const cat = task.category ? chalk.dim(`[${task.category}]`) : '';
  const title = task.title.length > maxTitleLen
    ? task.title.slice(0, maxTitleLen - 1) + '…'
    : task.title;

  let coloredTitle: string;
  if (task.status === 'in_progress') {
    coloredTitle = chalk.yellow(title);
  } else if (task.priority === 'immediate') {
    coloredTitle = chalk.red(title);
  } else {
    coloredTitle = title;
  }

  const priColored = task.priority === 'immediate'
    ? chalk.red(pri)
    : chalk.dim(pri);

  return `${sym} ${chalk.dim(id)} ${priColored.padEnd(3)} ${coloredTitle} ${cat}`;
}

/**
 * Render the full dashboard with box-drawing characters.
 */
export function renderDashboard(data: DashboardData): void {
  const width = getWidth();
  const lines: string[] = [];

  // Header
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const headerText = chalk.bold(`walnut Dashboard  ${dateStr}  ${days[now.getDay()]}`);

  lines.push(boxTop(width));
  lines.push(boxLine(headerText, width));
  lines.push(boxDivider(width));

  // Urgent section
  lines.push(boxLine(chalk.bold.red('⚡ Urgent'), width));
  if (data.urgent_tasks.length === 0) {
    lines.push(boxLine(chalk.dim('  No urgent tasks'), width));
  } else {
    for (const task of data.urgent_tasks) {
      lines.push(boxLine('  ' + formatTaskLine(task, width - 30), width));
    }
  }
  lines.push(boxDivider(width));

  // Tasks section
  lines.push(boxLine(chalk.bold('📋 Tasks'), width));
  const activeTasks = data.today_tasks.filter(t => t.status !== 'done');
  if (activeTasks.length === 0) {
    lines.push(boxLine(chalk.dim('  No active tasks'), width));
  } else {
    for (const task of activeTasks) {
      lines.push(boxLine('  ' + formatTaskLine(task, width - 30), width));
    }
  }
  lines.push(boxDivider(width));

  // Stats section
  const { total, todo, in_progress, done } = data.stats;
  lines.push(boxLine(chalk.bold('📊 Stats'), width));
  const statsLine = [
    `Total: ${chalk.bold(String(total))}`,
    `Todo: ${chalk.cyan(String(todo))}`,
    `In Progress: ${chalk.yellow(String(in_progress))}`,
    `Done: ${chalk.green(String(done))}`,
  ].join('  ');
  lines.push(boxLine('  ' + statsLine, width));

  lines.push(boxBottom(width));

  console.log(lines.join('\n'));
}

/**
 * Render a single line indicating a task was created.
 */
export function renderTaskCreated(task: Task): void {
  const pri = prioritySymbol(task.priority);
  console.log(chalk.green('✓') + ` Added: ${task.title} ${chalk.dim(`(id: ${task.id.slice(0, 8)}, priority: ${pri})`)}`);
}

/**
 * Render a single line indicating a task was completed.
 */
export function renderTaskCompleted(task: Task): void {
  console.log(chalk.green('✓') + ` Completed: ${task.title}`);
}

/**
 * Render a table-like list of tasks.
 */
export function renderTaskList(tasks: Task[]): void {
  if (tasks.length === 0) {
    console.log(chalk.dim('No tasks found.'));
    return;
  }

  for (const task of tasks) {
    const sym = statusSymbol(task.status);
    const id = chalk.dim(task.id.slice(0, 8));
    const pri = prioritySymbol(task.priority);
    const cat = task.category ? chalk.dim(`[${task.category}]`) : '';
    const date = chalk.dim(shortDate(task.updated_at));

    let coloredStatus: string;
    switch (task.status) {
      case 'in_progress':
        coloredStatus = chalk.yellow(sym);
        break;
      case 'done':
        coloredStatus = chalk.green(sym);
        break;
      default:
        coloredStatus = sym;
    }

    const priColored = task.priority === 'immediate'
      ? chalk.red(pri)
      : chalk.dim(pri);

    console.log(`${coloredStatus} ${id} ${priColored.padEnd(3)} ${task.title}  ${cat} ${date}`);
  }
}
