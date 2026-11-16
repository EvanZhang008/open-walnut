/** Message samples for the scope check's ref patterns, shared by the server's and the daemon's tests. */
export const SAMPLE_TASK_ID = 'cccc2222-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** Every kind of ref, with fake numbers; the last line is "work order 14142135, incident number: 17320508" in Chinese. */
export const REF_SAMPLES = [
  'CR-123456 and PR #4321, https://github.com/acme/app/pull/77, MR-9999',
  'Issue key ABC-42; ticket 31415926; incident #27182818; Sev2 16180339; case #16180340; CVE-2026-12345',
  '\u5de5\u5355 14142135, \u4e8b\u6545\u53f7\uff1a17320508',
  `files at /home/u/.local/state/open-walnut/tasks/${SAMPLE_TASK_ID}/x.patch and /s/tasks/mabcdef1-zz99/y.md`,
]

/** Words that only look like refs. */
export const NOT_REF_SAMPLES = [
  'SHA-256 and UTF-16, ISO-8601 dates (2026-11-16), GPT-6, rq-10efc3c6771f, commit 3346a76a3',
  'zone-west-1a, DC60, lib/service_stacks.ts:156, /tmp/tasks/notes.md, port 3456, 12,345 rows',
  // A review's probe of common words (2026-11-16): none is a ticket.
  'X86-64, COVID-19, Q4-2026, AL2-2023, PEP-440, TOP-10, EC2-123, DDR5-6000, GB-200, A100-40, in that case 50000 requests failed',
  `GET /api/v1/tasks/${SAMPLE_TASK_ID}/sessions and /api/tasks/${SAMPLE_TASK_ID}/history`,
]

