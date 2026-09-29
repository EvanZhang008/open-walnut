/**
 * A dictation whose final pass fails must never lose words silently, in
 * Chromium. The scenarios and why they exist: stt-failure-helpers.ts.
 */
import { registerSttFailureScenarios } from './stt-failure-helpers'

registerSttFailureScenarios()
