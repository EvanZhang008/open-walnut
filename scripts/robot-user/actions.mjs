#!/usr/bin/env node
/**
 * Action catalog for the robot user.
 *
 * Each action is { name, weight, preconditions(hierarchy, state) -> bool, run(driver, ctx) }.
 * `ctx` = { prng, state, sleep, driver } — `state` carries what the robot believes about the
 * screen (current tab, whether a text burst is in flight, ...).
 *
 * All randomness flows through a seeded mulberry32 PRNG, so one seed fully determines the
 * action sequence (that is what makes an anomaly replayable).
 */

// ─── seeded PRNG ─────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, good enough, and identical across node versions. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randInt = (prng, min, max) => min + Math.floor(prng() * (max - min + 1));
export const pick = (prng, arr) => arr[Math.floor(prng() * arr.length)];

// ─── screen constants (verified interactable ids / coordinates) ───────────────

export const IDS = {
  composer: 'chat.composer',
  photo: 'chat.photo',
  mic: 'chat.mic',
  send: 'chat.send',
};

/** Tab bar lives at y ~= 94%; x centers per tab. */
export const TABS = {
  Chat: { x: 18, y: 94 },
  Notes: { x: 39, y: 94 },
  Tasks: { x: 60, y: 94 },
  Settings: { x: 81, y: 94 },
};

export const TAB_NAMES = Object.keys(TABS);

/** Photo picker: confirm checkmark sits near the top-right. */
const PICKER_CONFIRM = { x: 90, y: 16 };
/** Photo grid cells — 3 columns over the first few rows. */
const PICKER_CELLS = [
  { x: 18, y: 32 }, { x: 50, y: 32 }, { x: 82, y: 32 },
  { x: 18, y: 47 }, { x: 50, y: 47 }, { x: 82, y: 47 },
  { x: 18, y: 62 }, { x: 50, y: 62 }, { x: 82, y: 62 },
];

// ─── canned corpus (EN / CJK / emoji / code) ─────────────────────────────────

const CORPUS = [
  'quick check: what is on my plate today?',
  'summarize the last thing we talked about in two lines.',
  'remind me to water the plants tomorrow morning.',
  'draft a two sentence reply saying I will be late.',
  'what did I change yesterday?',
  '帮我把今天的待办整理成三条',
  '这个周末的计划是什么?简短回答',
  '把上一条翻译成英文',
  'nice work 🎉 keep going 🚀',
  'hmm 🤔 not sure about that one',
  'explain this: `const x = arr.flatMap(f)`',
  '```js\nconst sum = (a, b) => a + b;\n```\nwhat does this return for (1, 2)?',
  'why would `await Promise.all([])` resolve immediately?',
  'one line answer only: 2 + 2 * 2',
  'list three ideas, no preamble',
  'a longer one: I want to plan a small trip next month, budget conscious, two nights, near the coast, and I would like the itinerary as a compact table.',
];

const SHORT_CAPTIONS = ['look at this', 'what is this?', '这是什么', 'ok? 👀', 'context for the photo'];

const NOTE_BURSTS = ['robot note burst. ', '快速记录一下。', 'todo: follow up 🔁 ', 'x = 1; y = 2; '];

const sentence = (prng) => pick(prng, CORPUS);

// ─── hierarchy helpers ───────────────────────────────────────────────────────

export const hasId = (rows, id) => rows.some((r) => r.id === id);

export const findId = (rows, id) => rows.find((r) => r.id === id) || null;

/**
 * Rows that plausibly represent a tappable list row (session row, note row).
 * Heuristic: wide, short, has text, sits in the middle band of the screen.
 */
export function listRows(rows, screenH = 874) {
  return rows.filter(
    (r) => r.text && r.bounds && r.bounds.w > 150 && r.bounds.h > 18 && r.bounds.h < 140
      && r.bounds.y > screenH * 0.12 && r.bounds.y2 < screenH * 0.88,
  );
}

// ─── shared micro-steps ──────────────────────────────────────────────────────

async function gotoTab(driver, ctx, name) {
  const t = TABS[name];
  const r = await driver.tapPoint(t.x, t.y);
  if (r && r.ok) ctx.state.tab = name;
  await ctx.sleep(randInt(ctx.prng, 500, 1400));
  return r;
}

/** Swipe over the content area (avoids the tab bar and the nav bar). */
function contentSwipe(driver, ctx) {
  const up = ctx.prng() < 0.5;
  const fromY = up ? randInt(ctx.prng, 70, 85) : randInt(ctx.prng, 25, 40);
  const toY = up ? randInt(ctx.prng, 20, 35) : randInt(ctx.prng, 70, 88);
  const x = randInt(ctx.prng, 35, 65);
  return driver.swipe({ fromX: x, fromY, toX: x, toY, durationMs: pick(ctx.prng, [120, 250, 400, 800]) });
}

// ─── the catalog ─────────────────────────────────────────────────────────────

export const ACTIONS = [
  {
    name: 'typeAndSend',
    weight: 25,
    preconditions: (rows) => hasId(rows, IDS.composer),
    async run(driver, ctx) {
      const steps = [];
      steps.push(await driver.tapId(IDS.composer));
      await ctx.sleep(randInt(ctx.prng, 300, 900));
      const n = randInt(ctx.prng, 1, 2);
      let text = sentence(ctx.prng);
      if (n === 2) text += ' ' + sentence(ctx.prng);
      steps.push(await driver.inputText(text));
      await ctx.sleep(randInt(ctx.prng, 200, 700));
      steps.push(await driver.tapId(IDS.send));
      ctx.state.lastSentAt = Date.now();
      return { steps, detail: { chars: text.length } };
    },
  },

  {
    name: 'attachPhotoAndSend',
    weight: 8,
    preconditions: (rows) => hasId(rows, IDS.photo),
    async run(driver, ctx) {
      const steps = [];
      steps.push(await driver.tapId(IDS.photo));
      await ctx.sleep(randInt(ctx.prng, 1200, 2200));
      // The picker is a system sheet: confirm it actually came up before poking at cells.
      const h = await driver.inspectHierarchy();
      const pickerUp = h.ok && !hasId(h.rows, IDS.composer);
      if (!pickerUp) {
        return { steps, skipped: 'picker-did-not-appear' };
      }
      const cells = randInt(ctx.prng, 1, 2);
      for (let i = 0; i < cells; i++) {
        const c = pick(ctx.prng, PICKER_CELLS);
        steps.push(await driver.tapPoint(c.x, c.y));
        await ctx.sleep(randInt(ctx.prng, 250, 700));
      }
      steps.push(await driver.tapPoint(PICKER_CONFIRM.x, PICKER_CONFIRM.y));
      await ctx.sleep(randInt(ctx.prng, 1500, 3000));
      steps.push(await driver.tapId(IDS.composer));
      steps.push(await driver.inputText(pick(ctx.prng, SHORT_CAPTIONS)));
      await ctx.sleep(randInt(ctx.prng, 300, 800));
      steps.push(await driver.tapId(IDS.send));
      ctx.state.lastSentAt = Date.now();
      return { steps, detail: { cells } };
    },
  },

  {
    name: 'scrollStorm',
    weight: 20,
    preconditions: () => true,
    async run(driver, ctx) {
      const steps = [];
      const n = randInt(ctx.prng, 3, 6);
      for (let i = 0; i < n; i++) {
        steps.push(await contentSwipe(driver, ctx));
        await ctx.sleep(randInt(ctx.prng, 120, 600));
      }
      return { steps, detail: { swipes: n } };
    },
  },

  {
    name: 'keyboardChurn',
    weight: 15,
    preconditions: (rows) => hasId(rows, IDS.composer),
    async run(driver, ctx) {
      const steps = [];
      const n = randInt(ctx.prng, 2, 4);
      for (let i = 0; i < n; i++) {
        steps.push(await driver.tapId(IDS.composer));
        await ctx.sleep(randInt(ctx.prng, 300, 900));
        // Interactive dismiss: drag down over the content area.
        steps.push(await driver.swipe({ fromX: 50, fromY: randInt(ctx.prng, 30, 45), toX: 50, toY: randInt(ctx.prng, 70, 88), durationMs: pick(ctx.prng, [150, 300, 600]) }));
        await ctx.sleep(randInt(ctx.prng, 200, 800));
      }
      return { steps, detail: { cycles: n } };
    },
  },

  {
    name: 'tabHop',
    weight: 10,
    preconditions: () => true,
    async run(driver, ctx) {
      const steps = [];
      const from = ctx.state.tab || 'Chat';
      const target = pick(ctx.prng, TAB_NAMES.filter((t) => t !== from));
      steps.push(await gotoTab(driver, ctx, target));
      await ctx.sleep(randInt(ctx.prng, 1000, 3000));
      let back = false;
      if (ctx.prng() < 0.5) {
        steps.push(await gotoTab(driver, ctx, from));
        back = true;
      }
      return { steps, detail: { target, back } };
    },
  },

  {
    name: 'openSessionAndRead',
    weight: 10,
    preconditions: () => true,
    async run(driver, ctx) {
      const steps = [];
      steps.push(await gotoTab(driver, ctx, 'Tasks'));
      const h = await driver.inspectHierarchy();
      const rows = h.ok ? listRows(h.rows) : [];
      if (rows.length === 0) return { steps, skipped: 'no-session-rows' };
      const row = pick(ctx.prng, rows);
      const cx = ((row.bounds.x + row.bounds.x2) / 2 / 402) * 100;
      const cy = ((row.bounds.y + row.bounds.y2) / 2 / 874) * 100;
      steps.push(await driver.tapPoint(Math.max(5, Math.min(95, cx)), Math.max(12, Math.min(88, cy))));
      await ctx.sleep(randInt(ctx.prng, 1200, 2500));
      const scrolls = randInt(ctx.prng, 2, 4);
      for (let i = 0; i < scrolls; i++) {
        steps.push(await contentSwipe(driver, ctx));
        await ctx.sleep(randInt(ctx.prng, 200, 700));
      }
      steps.push(await driver.back());
      await ctx.sleep(randInt(ctx.prng, 600, 1500));
      return { steps, detail: { rowText: (row.text || '').slice(0, 40), scrolls } };
    },
  },

  {
    name: 'backgroundForeground',
    weight: 5,
    preconditions: () => true,
    async run(driver, ctx) {
      const steps = [];
      steps.push(await driver.terminate());
      await ctx.sleep(randInt(ctx.prng, 800, 2000));
      steps.push(await driver.launch());
      // Wait for the hierarchy to repopulate rather than a blind sleep.
      let repopulated = false;
      for (let i = 0; i < 10; i++) {
        await ctx.sleep(1000);
        const h = await driver.inspectHierarchy();
        if (h.ok && h.rows.length > 5) { repopulated = true; break; }
      }
      ctx.state.tab = 'Chat';
      return { steps, detail: { repopulated } };
    },
  },

  {
    name: 'notesEdit',
    weight: 5,
    preconditions: () => true,
    async run(driver, ctx) {
      const steps = [];
      steps.push(await gotoTab(driver, ctx, 'Notes'));
      const h = await driver.inspectHierarchy();
      const rows = h.ok ? listRows(h.rows) : [];
      if (rows.length === 0) return { steps, skipped: 'no-note-rows' };
      const row = rows[0];
      const cy = ((row.bounds.y + row.bounds.y2) / 2 / 874) * 100;
      steps.push(await driver.tapPoint(50, Math.max(12, Math.min(88, cy))));
      await ctx.sleep(randInt(ctx.prng, 1200, 2500));
      steps.push(await driver.inputText(pick(ctx.prng, NOTE_BURSTS)));
      await ctx.sleep(randInt(ctx.prng, 500, 1200));
      steps.push(await driver.back());
      await ctx.sleep(randInt(ctx.prng, 600, 1500));
      return { steps, detail: { rowText: (row.text || '').slice(0, 40) } };
    },
  },

  {
    name: 'idleThink',
    weight: 12,
    preconditions: () => true,
    async run(driver, ctx) {
      const ms = randInt(ctx.prng, 2000, 8000);
      await ctx.sleep(ms);
      return { steps: [], detail: { ms } };
    },
  },
];

export const ACTIONS_BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

export const TOTAL_WEIGHT = ACTIONS.reduce((s, a) => s + a.weight, 0);
