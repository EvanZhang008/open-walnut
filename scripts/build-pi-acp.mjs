import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function patchPiAcp(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('pi-acp 0.0.33 patch context changed');
    source = source.replace(before, () => after);
  };
  replace('var pkg = readNearestPackageJson(import.meta.url);', 'var pkg = { name: "pi-acp", version: "0.0.33" };');
  replace('    const quietStartup = getQuietStartup(params.cwd);\n    const updateNotice = buildUpdateNotice();', '    const quietStartup = true;\n    const updateNotice = null;');
  replace('    const args = ["--mode", "rpc", "--no-themes"];', `    const { execFile } = await import("node:child_process");
    const version = await new Promise((resolve, reject) => {
      execFile(cmd, ["--version"], { timeout: 5000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) reject(RequestError2.internalError({ walnutError: "provider_missing" }, "Pi executable could not report its version."));
        else resolve(stdout.trim().match(/^(?:pi\\s+v?|v)?(\\d+)\\.(\\d+)\\.(\\d+)/i));
      });
    });
    if (!version || !(Number(version[1]) > 0 || Number(version[2]) > 80 || (Number(version[2]) === 80 && Number(version[3]) >= 4))) {
      throw RequestError2.internalError({ walnutError: "provider_incompatible", provider: "pi" }, "Pi 0.80.4 or newer is required; update the Pi CLI.");
    }
    const args = ["--mode", "rpc", "--no-themes"];`);
  replace('      this.pending.clear();\n    });\n    child.on("error",', '      this.pending.clear();\n      for (const handler of this.eventHandlers) handler({ type: "pi_process_exit" });\n    });\n    child.on("error",');
  replace('    switch (type) {\n      case "message_update":', `    switch (type) {
      case "pi_process_exit": {
        void this.flushEmits().finally(() => {
          const error = RequestError.internalError(undefined, "Pi process exited; send a message to resume.");
          this.pendingTurn?.reject(error);
          this.pendingTurn = null;
          for (const turn of this.turnQueue.splice(0)) turn.reject(error);
          this.inAgentLoop = false;
        });
        break;
      }
      case "message_update":`);
  replace('    const existing = this.sessions.maybeGet(sessionId);\n    if (existing) return existing;', `    const existing = this.sessions.maybeGet(sessionId);
    if (existing && existing.proc.child.exitCode === null && existing.proc.child.signalCode === null) return existing;
    if (existing) this.sessions.close(sessionId);`);
  replace('      title: bashCommand(params.args) ?? params.toolName,', '      title: bashCommand(params.args) ?? params.toolName,\n      rawInput: params.args,');
  replace('  cancelRequested = false;', '  cancelRequested = false;\n  lastAssistant = null;');
  replace('    this.cancelRequested = false;', '    this.cancelRequested = false;\n    this.lastAssistant = null;');
  replace('      case "agent_end": {', `      case "message_end": {
        if (ev.message?.role === "assistant") this.lastAssistant = ev.message;
        break;
      }
      case "agent_end": {`);
  // Pi reports inference failures in message_end, not in the prompt acknowledgement.
  replace('          const reason = this.cancelRequested ? "cancelled" : "end_turn";\n          this.pendingTurn?.resolve(reason);', `          const reason = this.lastAssistant?.stopReason;
          if (this.cancelRequested || reason === "aborted") {
            this.pendingTurn?.resolve("cancelled");
          } else if (reason === "error") {
            this.pendingTurn?.reject(maybeAuthRequiredError(this.lastAssistant.errorMessage)
              ?? RequestError.internalError(undefined, "Pi model request failed"));
          } else {
            this.pendingTurn?.resolve(reason === "length" ? "max_tokens" : "end_turn");
          }`);
  replace('          const reason = this.cancelRequested ? "cancelled" : "error";\n          this.pendingTurn?.resolve(reason);', `          if (this.cancelRequested) this.pendingTurn?.resolve("cancelled");
          else this.pendingTurn?.reject(RequestError.internalError(undefined, "Pi prompt failed"));`);
  return source;
}

export async function buildPiAcp(outdir) {
  const entry = require.resolve('pi-acp');
  const root = resolve(dirname(entry), '..');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '0.0.33') throw new Error('Review the Pi ACP patch before changing adapter version');
  await mkdir(outdir, { recursive: true });
  await build({
    stdin: {
      contents: patchPiAcp(await readFile(entry, 'utf8')),
      resolveDir: dirname(entry),
      sourcefile: entry,
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    legalComments: 'eof',
    outfile: join(outdir, 'pi-acp.js'),
  });
  const adapterRequire = createRequire(entry);
  const packageFiles = [join(root, 'package.json'), ...['@agentclientprotocol/sdk', 'zod'].map((name) => adapterRequire.resolve(`${name}/package.json`))];
  const notices = await Promise.all(packageFiles.map(async (file) => {
    const dependency = JSON.parse(await readFile(file, 'utf8'));
    return `${dependency.name} ${dependency.version}\n\n${await readFile(join(dirname(file), 'LICENSE'), 'utf8')}`;
  }));
  await writeFile(join(outdir, 'pi-acp.LICENSE'), notices.join('\n\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPiAcp(resolve(dirname(fileURLToPath(import.meta.url)), '../dist/daemon-binaries'));
}
