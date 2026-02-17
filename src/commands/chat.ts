import readline from 'node:readline';
import chalk from 'chalk';
import { runAgentLoop } from '../agent/loop.js';
import { outputJson } from '../utils/json-output.js';
import { usageTracker } from '../core/usage/index.js';
import type { GlobalOptions } from '../core/types.js';
import type { MessageParam } from '../agent/model.js';

export interface ChatOptions extends GlobalOptions {
  debug?: boolean;
}

async function interactiveChat(debug: boolean): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.bold('Walnut Chat') + chalk.dim(' (type "exit" or Ctrl+C to quit)'));
  console.log();

  let history: MessageParam[] = [];

  const prompt = (): void => {
    rl.question(chalk.cyan('You: '), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        rl.close();
        return;
      }

      console.log();
      try {
        const result = await runAgentLoop(trimmed, history, {
          onToolActivity(activity) {
            if (activity.status === 'calling') {
              process.stdout.write(chalk.dim(`  🔧 ${activity.toolName}...`));
            } else {
              process.stdout.write(chalk.dim(' done\n'));
            }
          },
          onUsage(usage) {
            try { usageTracker.record({ source: 'agent-cli', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens }); } catch {}
            if (!debug) return;
            const parts: string[] = [];
            if (usage.input_tokens) parts.push(`in:${usage.input_tokens}`);
            if (usage.output_tokens) parts.push(`out:${usage.output_tokens}`);
            if (usage.cache_read_input_tokens) parts.push(`cache_read:${usage.cache_read_input_tokens}`);
            if (usage.cache_creation_input_tokens) parts.push(`cache_write:${usage.cache_creation_input_tokens}`);
            if (parts.length > 0) {
              process.stdout.write(chalk.dim(`  [${parts.join(', ')}]\n`));
            }
          },
        }, { source: 'cli' });
        history = result.messages;
        console.log(chalk.green('Bot: ') + result.response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red('Error: ') + msg);
      }
      console.log();
      prompt();
    });
  };

  rl.on('close', () => {
    console.log(chalk.dim('\nGoodbye.'));
  });

  prompt();
}

export async function runChat(
  question: string | undefined,
  globals: ChatOptions,
): Promise<void> {
  // One-shot mode: run a single agent turn (same as interactive, just one round)
  if (question) {
    try {
      const result = await runAgentLoop(question, [], {
        onUsage(usage) {
          try { usageTracker.record({ source: 'agent-cli', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens }); } catch {}
        },
      }, { source: 'cli-oneshot' });
      if (globals.json) {
        outputJson({ question, response: result.response });
      } else {
        console.log(result.response);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (globals.json) {
        outputJson({ error: msg });
      } else {
        console.log(chalk.red('Error: ') + msg);
      }
    }
    return;
  }

  // Interactive mode
  await interactiveChat(!!globals.debug);
}
