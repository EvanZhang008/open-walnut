/**
 * Persona sections shared by every launch profile.
 *
 * These strings ride `--system-prompt` on a spawned session, including a cold
 * `--resume`, so they must stay PURE (no I/O) and stable: the profile is rebuilt
 * from the record on every respawn, and a section that changed between spawns
 * would give the same session two identities.
 */

import { renderSelfKnowledgeContract } from '../self-knowledge-contract.js';

/** Stable product contract: what Walnut is and how it works. */
export function buildWorkModesSection(): string {
  // The suggest-card syntax deliberately does NOT live here — it loads on demand
  // via the shipped `suggest-cards` skill (one index line instead of ~1.1KB in
  // every prompt).
  return renderSelfKnowledgeContract();
}

/** The Personal AI's own identity line, followed by the product contract. */
export function buildRoleSection(name: string): string {
  return `You are Walnut, ${name}'s Personal AI and project manager. You manage tasks, sessions, and knowledge.

${buildWorkModesSection()}`;
}
