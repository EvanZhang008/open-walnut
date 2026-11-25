/**
 * The model menu rows of a session whose engine advertises its own models over ACP (Antigravity,
 * Codex, OpenCode and the rest: engineCaps(engine).modelCatalog === 'provider-advertised').
 *
 * Such a session's models are its CLI's, never Claude Code's host catalog (host-model-catalog.ts):
 * 2026-11-25, an Antigravity session's phone sheet (GET /api/v1/sessions/:id/model-options) and
 * GET /api/sessions/:id/models listed Claude's models, and a pick of one could only fail. Each row's
 * value is the catalog's own model id ("gemini-4-neon[high]" for an effort-qualified one), which
 * the model change hands to the ACP session as it is (AcpSession.setModel splits it); the effort
 * lives in that id, so no row offers separate effort levels.
 */
import type { SessionModelCatalogEntry } from '../types.js';
import type { AcpModelCatalog } from '../../providers/acp-worker/protocol.js';
import { engineCaps } from '../agents/engine-registry.js';

/** The engine lists its own models (an ACP catalog), so Claude Code's host catalog never stands in for them. */
export function listsOwnModels(engine: unknown): boolean {
  return engineCaps(engine).modelCatalog === 'provider-advertised';
}

/** The live ACP catalog as menu rows. */
export function acpCatalogRows(catalog: AcpModelCatalog): SessionModelCatalogEntry[] {
  return catalog.availableModels.map((m) => ({
    value: m.modelId,
    displayName: m.name || m.modelId,
    ...(m.description ? { description: m.description } : {}),
    supportsEffort: false,
  }));
}

interface AcpRecordModel { acpModel?: string; acpModelName?: string; model?: string }

/** The model the record names: the one row a menu shows when no live catalog answers. */
export function recordModelRows(record: AcpRecordModel): SessionModelCatalogEntry[] {
  const id = record.acpModel || record.model;
  return id ? [{ value: id, displayName: record.acpModelName || id, supportsEffort: false }] : [];
}

/** Rows and the current id: the live catalog when it lists any, else the record's own model. */
export function acpMenu(catalog: AcpModelCatalog | null | undefined, record: AcpRecordModel): { rows: SessionModelCatalogEntry[]; current: string | null } {
  const rows = catalog && catalog.availableModels.length > 0 ? acpCatalogRows(catalog) : recordModelRows(record);
  return { rows, current: catalog?.currentModelId || record.acpModel || record.model || null };
}
