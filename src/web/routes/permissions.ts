/**
 * /api/permissions — Permission Doctor (macOS TCC health + guided fixes).
 *
 * GET  /                      → PermissionsReport (30s cache; ?force=1 re-probes,
 *                               used by the fix dialog's 2s verify poll)
 * POST /:id/open-settings     → opens the matching System Settings pane ON THE
 *                               MAC. Runs server-side on purpose: the server
 *                               always lives on the Mac, so this works no matter
 *                               where the UI is (browser, Mac app, iPhone).
 * POST /:id/request           → triggers the one-time system prompt for
 *                               prompt-capable permissions (calendar). Returns
 *                               the post-prompt state so the UI can flip to a
 *                               green check without another poll.
 *
 * Every handler answers within a deadline (probes have child-process
 * timeouts) — a hung TCC probe must degrade, never pin a browser connection.
 */
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { getPermissionsReport } from '../../core/permissions/darwin.js';
import { requestCalendarAccess } from '../../core/calendar/sources/eventkit.js';
import { getCalendarService } from '../../core/calendar/index.js';
import { log } from '../../logging/index.js';

export const permissionsRouter = Router();

permissionsRouter.get('/', async (req, res) => {
  try {
    const report = await getPermissionsReport(req.query.force === '1');
    res.json(report);
  } catch (err) {
    log.web.error('permissions report failed', { error: String(err).slice(0, 300) });
    res.status(500).json({ error: 'permissions probe failed' });
  }
});

permissionsRouter.post('/:id/open-settings', async (req, res) => {
  const report = await getPermissionsReport();
  const perm = report.permissions.find((p) => p.id === req.params.id);
  if (!perm) {
    res.status(404).json({ error: `unknown permission: ${req.params.id}` });
    return;
  }
  // `open` with a fixed, server-owned URL (never user input — the deep link
  // comes from our own registry, so this can't be turned into open-anything).
  execFile('/usr/bin/open', [perm.settingsUrl], { timeout: 5_000 }, (err) => {
    if (err) log.web.warn('open settings failed', { id: perm.id, error: String(err).slice(0, 200) });
  });
  // Fire-and-forget by design: `open` returns before Settings finishes
  // launching, and the UI's verify poll is what confirms the outcome anyway.
  res.json({ ok: true, opened: perm.settingsUrl });
});

permissionsRouter.post('/:id/request', async (req, res) => {
  if (req.params.id !== 'calendar') {
    // Full Disk Access has NO system prompt (macOS never asks) — reaching
    // here means the UI showed the wrong button; 409 keeps that loud.
    res.status(409).json({ error: 'this permission cannot be requested via prompt; open System Settings instead' });
    return;
  }
  const state = await requestCalendarAccess();
  if (state === 'granted') {
    // The user just granted mid-session: refresh so the calendar view fills
    // in without them hunting for a refresh button.
    getCalendarService()
      .refreshAll()
      .catch((err: unknown) =>
        log.calendar.warn('post-grant refresh failed', { error: String(err).slice(0, 200) })
      );
  }
  res.json({ state });
});
