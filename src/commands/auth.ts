import chalk from 'chalk';
import { authenticate } from '../integrations/microsoft-todo.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

export async function runAuth(globals: GlobalOptions): Promise<void> {
  console.log(chalk.bold('\nMicrosoft To-Do Authentication\n'));

  try {
    const { account, lists } = await authenticate((info) => {
      console.log(`To sign in, open: ${chalk.cyan(info.verificationUri)}`);
      console.log(`Enter code: ${chalk.bold.yellow(info.userCode)}\n`);
      console.log(chalk.dim('Waiting for authentication...'));
    });

    console.log();
    console.log(chalk.green('+ ') + `Authenticated as ${chalk.bold(account)}`);
    console.log(
      chalk.green('+ ') +
        `Found ${lists.length} task list${lists.length !== 1 ? 's' : ''}: ${lists.map((l) => l.displayName).join(', ')}`,
    );
    console.log(chalk.green('+ ') + `Token saved to ~/.open-walnut/sync/`);

    if (globals.json) {
      outputJson({ account, lists });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red('Authentication failed: ') + message);
    process.exitCode = 1;
  }
}
