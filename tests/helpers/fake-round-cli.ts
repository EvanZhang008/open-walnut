/**
 * A fake CLI for tests that run real session daemons, in a module of its own with nothing but
 * node:fs and node:path: bun fixtures outside vitest import it (tests/providers/fixtures/
 * in-process-daemon-session.ts, walnut-session-side.ts).
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * A fake CLI under `dir`: an init line, then for every stdin user line an assistant line and a result
 * line naming its ROUND-<word>, the result's num_turns counting the turns this one process answered
 * (a session that kept its CLI keeps counting: its conversation went on).
 */
export function fakeRoundCli(dir: string): string {
  const file = path.join(dir, 'fake-round-cli.sh')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'sid=fake',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "--session-id" ]; then sid="$2"; fi',
    '  shift',
    'done',
    'echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"fake\\",\\"tools\\":[]}"',
    'n=0',
    'while IFS= read -r line; do',
    '  case "$line" in',
    '    *\'"type":"user"\'*)',
    '      n=$((n+1))',
    '      word=$(printf \'%s\\n\' "$line" | sed -n \'s/.*ROUND-\\([A-Za-z0-9]*\\).*/\\1/p\')',
    '      echo "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"id\\":\\"msg_fake_${n}_$word\\",\\"type\\":\\"message\\",\\"role\\":\\"assistant\\",\\"model\\":\\"fake\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"answer $word\\"}],\\"stop_reason\\":\\"end_turn\\",\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1}}}"',
    '      echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"session_id\\":\\"$sid\\",\\"num_turns\\":$n,\\"result\\":\\"answer $word\\"}"',
    '      ;;',
    '  esac',
    'done',
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}
