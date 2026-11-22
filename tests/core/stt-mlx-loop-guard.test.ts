/**
 * The mlx daemon's loop guard stops a degenerate repetition inside decoding,
 * and never touches real speech.
 *
 * 2026-11-22: a 102 s take whose speaker went quiet near the end came back as
 * its words and then one filler syllable 3270 times (41 s of engine time, the
 * next dictation waited 38 s behind it). The guard (LOOP_GUARD_PY, pure Python)
 * runs here on the system python3 with plain token lists, stepped the way
 * mlx-audio's generate_step calls a logits processor: the history grows by one
 * token per step and starts again with every 30 s chunk. No mlx needed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findPython3 } from '../../src/core/stt/setup-mlx.js';
import { LOOP_GUARD_PY, MLX_SERVER_PY } from '../../src/core/stt/mlx-daemon-script.js';

const run = promisify(execFile);

/**
 * Steps the guard over each chunk of fixed token lists; reports
 * [chunk, tokens generated before the step, "ban" | "end", token].
 */
const HARNESS = `
import json, sys
${LOOP_GUARD_PY}
out = []
for case in json.loads(sys.stdin.read()):
    guard = LoopGuard()
    bans = []
    for ci, chunk in enumerate(case):
        hist = list(chunk["prompt"])
        gen = chunk["gen"]
        for i in range(len(gen) + 1):
            action = guard.step(len(hist), lambda k: hist[len(hist) - k:])
            if action is not None:
                bans.append([ci, i, action[0], action[1]])
            if i < len(gen):
                hist.append(gen[i])
    out.append({"bans": bans, "fired": guard.fired})
print(json.dumps(out))
`;

interface Chunk { prompt: number[]; gen: number[] }
interface Outcome { bans: Array<[number, number, 'ban' | 'end', number]>; fired: number }

let python: string | null = null;

async function guard(...cases: Chunk[][]): Promise<Outcome[]> {
  const child = run(python!, ['-c', HARNESS], { timeout: 20_000 });
  child.child.stdin!.end(JSON.stringify(cases));
  return JSON.parse((await child).stdout) as Outcome[];
}

const rep = (unit: number[], times: number): number[] => Array.from({ length: times }, () => unit).flat();
// Token ids. AUDIO_PAD stands for <|audio_pad|>; the rest are made up.
const AUDIO_PAD = 151676;
const LAST_PROMPT_TOKEN = 77;
const WORDS = [501, 502, 503];
const FILLER = 900;           // one syllable said again and again
const SYLLABLE = [910, 911];  // a word the tokenizer splits in two
/** generate_step hands the first processor call only the prompt's last token. */
const tail = (gen: number[]): Chunk => ({ prompt: [LAST_PROMPT_TOKEN], gen });

describe('mlx daemon loop guard', () => {
  beforeAll(async () => { python = (await findPython3())?.path ?? null; });

  it('the daemon script and the guard are valid Python', async (ctx) => {
    if (!python) ctx.skip();
    await run(python!, ['-c', 'import ast, sys; ast.parse(sys.argv[1]); ast.parse(sys.argv[2])', MLX_SERVER_PY, LOOP_GUARD_PY], { timeout: 20_000 });
  });

  it('stops a one-token loop at its 12th repeat by banning that token', async (ctx) => {
    if (!python) ctx.skip();
    const [eleven, loop] = await guard([tail([...WORDS, ...rep([FILLER], 11)])], [tail([...WORDS, ...rep([FILLER], 20)])]);
    expect(eleven.bans).toEqual([]);
    // 3 words + 12 fillers generated: the 13th filler is the one banned.
    expect(loop.bans[0]).toEqual([0, 15, 'ban', FILLER]);
  });

  it('stops a two-token loop at its 8th repeat by banning the token that starts the next cycle', async (ctx) => {
    if (!python) ctx.skip();
    const [seven, loop] = await guard([tail([...WORDS, ...rep(SYLLABLE, 7)])], [tail([...WORDS, ...rep(SYLLABLE, 10)])]);
    expect(seven.bans).toEqual([]);
    expect(loop.bans[0]).toEqual([0, 3 + 16, 'ban', SYLLABLE[0]]);
  });

  it('stops a loop of 3 to 8 tokens at its 6th repeat, and never a longer unit', async (ctx) => {
    if (!python) ctx.skip();
    const three = [601, 602, 603];
    const eight = [701, 702, 703, 704, 705, 706, 707, 708];
    const nine = [...eight, 709];
    const [five3, six3, six8, many9] = await guard(
      [tail([...WORDS, ...rep(three, 5)])],
      [tail([...WORDS, ...rep(three, 6)])],
      [tail(rep(eight, 6))],
      [tail(rep(nine, 10))],
    );
    expect(five3.bans).toEqual([]);
    expect(six3.bans).toEqual([[0, 3 + 18, 'ban', three[0]]]);
    expect(six8.bans).toEqual([[0, 48, 'ban', eight[0]]]);
    expect(many9.bans).toEqual([]);
  });

  it('lets real stutters and repeated phrases through', async (ctx) => {
    if (!python) ctx.skip();
    const I = 1001; const NOT = 1002; const IS = 1003; const WE = 1004; const PLURAL = 1005;
    const sentences = [
      // "I I I" (one token said three times)
      [...WORDS, I, I, I, ...WORDS],
      // "it's not, it's not, it's not, it's not": as one token and as two
      [...WORDS, ...rep([NOT], 4), ...WORDS],
      [...WORDS, ...rep([NOT, IS], 4), ...WORDS],
      // "we we we" with "we" as two tokens
      [...WORDS, ...rep([WE, PLURAL], 3), ...WORDS],
      // the filler ten times at the end of a take, as the normal re-hearing ended
      [...WORDS, ...rep([FILLER], 10)],
      // all of them in one long take
      [...WORDS, I, I, I, ...rep([NOT, IS], 4), ...rep([WE, PLURAL], 3), ...rep(WORDS, 5), ...rep([FILLER], 10)],
    ];
    for (const out of await guard(...sentences.map((g) => [tail(g)]))) expect(out).toEqual({ bans: [], fired: 0 });
  });

  it('starts counting again in every chunk', async (ctx) => {
    if (!python) ctx.skip();
    const [split, within] = await guard(
      // 8 fillers end chunk 1, 8 more start chunk 2: 16 in a row across the cut, 8 in each.
      [tail([...WORDS, ...rep([FILLER], 8)]), tail([...rep([FILLER], 8), ...WORDS])],
      // a loop inside chunk 2 is still caught there
      [tail([...WORDS, ...rep([FILLER], 8)]), tail(rep([FILLER], 14))],
    );
    expect(split.bans).toEqual([]);
    expect(within.bans[0]).toEqual([1, 12, 'ban', FILLER]);
  });

  it('never judges the prompt: its audio pads do not trigger, whole or as its last token', async (ctx) => {
    if (!python) ctx.skip();
    const prompt = [11, 12, ...rep([AUDIO_PAD], 400), 13, 14];
    const [whole, padsOnly, thenLoop] = await guard(
      [{ prompt, gen: WORDS }],
      [{ prompt: rep([AUDIO_PAD], 400), gen: [AUDIO_PAD, ...WORDS] }],
      // a new chunk whose history is the whole prompt again, then a real loop
      [{ prompt, gen: WORDS }, { prompt, gen: rep([FILLER], 13) }],
    );
    expect(whole.bans).toEqual([]);
    expect(padsOnly.bans).toEqual([]);
    expect(thenLoop.bans[0]).toEqual([1, 12, 'ban', FILLER]);
  });

  it('bans once, then allows only the end, and counts every step it acted on', async (ctx) => {
    if (!python) ctx.skip();
    // A fixed list keeps looping past the actions (a real model cannot).
    const [out] = await guard([tail(rep([FILLER], 15))]);
    expect(out.bans).toEqual([[0, 12, 'ban', FILLER], [0, 13, 'end', FILLER], [0, 14, 'end', FILLER], [0, 15, 'end', FILLER]]);
    expect(out.fired).toBe(4);
  });

  it('ends a loop the model resumes after the ban, and starts over in the next chunk', async (ctx) => {
    if (!python) ctx.skip();
    // A model that says its words, then the filler forever; banned, it says one
    // other token and goes back to the filler ("x x x ... y x x x ...", the
    // unit too long to see). Allowed only the end, it ends.
    const sim = `
import json, sys
${LOOP_GUARD_PY}
EOS, OTHER, FILLER = -1, 950, ${FILLER}
guard = LoopGuard()
chunks = []
for words in json.loads(sys.stdin.read()):
    hist, out = [${LAST_PROMPT_TOKEN}], []
    while len(out) < 3000:
        action = guard.step(len(hist), lambda k: hist[len(hist) - k:])
        nxt = words[len(out)] if len(out) < len(words) else FILLER
        if action and action[0] == "end":
            nxt = EOS
        elif action and action[1] == nxt:
            nxt = OTHER
        if nxt == EOS:
            break
        out.append(nxt)
        hist.append(nxt)
    chunks.append(out)
print(json.dumps({"chunks": chunks, "fired": guard.fired}))
`;
    const child = run(python!, ['-c', sim], { timeout: 20_000 });
    child.child.stdin!.end(JSON.stringify([WORDS, WORDS]));
    const { chunks, fired } = JSON.parse((await child).stdout) as { chunks: number[][]; fired: number };
    const expected = [...WORDS, ...rep([FILLER], 12), 950, ...rep([FILLER], 12)];
    expect(chunks).toEqual([expected, expected]);
    expect(fired).toBe(4); // a ban and an end in each chunk
  });
});
