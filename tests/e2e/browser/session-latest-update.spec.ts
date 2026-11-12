/**
 * "Latest update" in the composer's "+" -> More flyout, in Chromium (and WebKit through
 * the twin, session-latest-update.webkit.spec.ts, which runs the same cases).
 * Matrix: session-latest-update-helpers.ts.
 */
import { test } from '@playwright/test';
import { latestUpdateCases } from './session-latest-update-cases';

latestUpdateCases(test);
