import fs from 'node:fs';
import chalk from 'chalk';
import { logFilePath } from '../logging/logger.js';
import { levelColor } from '../logging/subsystem.js';
import type { LogLevel } from '../logging/levels.js';

interface LogsOptions {
  follow?: boolean;
  json?: boolean;
  limit?: string;
  subsystem?: string;
}

function formatLogLine(entry: Record<string, unknown>): string {
  const time = typeof entry.time === 'string' ? entry.time.split('T')[1]?.split('.')[0] ?? '' : '';
  const level = (entry.level as string ?? 'info').toUpperCase().padEnd(5);
  const subsystem = entry.subsystem as string ?? '???';
  const message = entry.message as string ?? '';

  // Color the level using shared levelColor map
  const lvl = entry.level as LogLevel;
  const colorFn = levelColor[lvl] ?? ((t: string) => t);
  const coloredLevel = colorFn(level.trim());
  const coloredSub = chalk.dim(`[${subsystem}]`);

  let line = `${chalk.gray(time)} ${coloredLevel} ${coloredSub} ${message}`;

  // Append meta keys if present (exclude standard fields)
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!['time', 'level', 'subsystem', 'message'].includes(k) && v !== undefined) {
      meta[k] = v;
    }
  }
  if (Object.keys(meta).length > 0) {
    line += ' ' + chalk.dim(JSON.stringify(meta));
  }

  return line;
}

function readAndPrintLines(filePath: string, options: LogsOptions): number {
  if (!fs.existsSync(filePath)) {
    console.error(`No log file found at ${filePath}`);
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const limit = parseInt(options.limit ?? '100', 10);
  const startIdx = Math.max(0, lines.length - limit);
  const tail = lines.slice(startIdx);

  let printed = 0;
  for (const line of tail) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Filter by subsystem if specified
      if (options.subsystem && entry.subsystem !== options.subsystem) {
        continue;
      }

      if (options.json) {
        console.log(line);
      } else {
        console.log(formatLogLine(entry));
      }
      printed++;
    } catch {
      // Skip unparseable lines
      if (options.json) {
        console.log(line);
        printed++;
      }
    }
  }

  return printed;
}

export async function runLogs(options: LogsOptions): Promise<void> {
  let logPath = logFilePath();

  if (!options.follow) {
    const count = readAndPrintLines(logPath, options);
    if (count === 0) {
      console.log('No log entries found. Start the server with `walnut web` to generate logs.');
    }
    return;
  }

  // Follow mode: print existing, then poll for new lines
  let lastSize = 0;

  if (fs.existsSync(logPath)) {
    // Print existing lines first
    readAndPrintLines(logPath, options);
    lastSize = fs.statSync(logPath).size;
  }

  console.error(chalk.dim('--- Following log (Ctrl+C to stop) ---'));

  // Poll every second — recalculate path each tick to handle midnight rollover
  const interval = setInterval(() => {
    const currentPath = logFilePath();
    if (currentPath !== logPath) {
      // Midnight rollover: new day, new file
      logPath = currentPath;
      lastSize = 0;
    }

    if (!fs.existsSync(logPath)) return;

    const stat = fs.statSync(logPath);
    if (stat.size <= lastSize) return;

    // Read only new bytes
    const fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(stat.size - lastSize);
    fs.readSync(fd, buffer, 0, buffer.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;

    const newContent = buffer.toString('utf-8');
    const lines = newContent.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;

        if (options.subsystem && entry.subsystem !== options.subsystem) {
          continue;
        }

        if (options.json) {
          console.log(line);
        } else {
          console.log(formatLogLine(entry));
        }
      } catch {
        if (options.json) console.log(line);
      }
    }
  }, 1000);

  // Keep running until Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}
