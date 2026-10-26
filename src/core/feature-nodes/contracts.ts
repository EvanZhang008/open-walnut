import { z } from 'zod';
import {
  capabilityKey, capabilitySchema, identifierSchema, immutableJson, failure,
  MAX_FRAME_BYTES, tightenedLimit,
  type CapabilityRef, type JsonValue, type Outcome,
} from './protocol.js';

export interface ReadContract {
  readonly capability: CapabilityRef;
  readonly fingerprint: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
}
export interface InstalledContract extends ReadContract {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}
export interface PermissionGrant {
  readonly capability: CapabilityRef;
  readonly fingerprint: string;
}
export interface Authority {
  readonly nodeId: string;
  readonly accountId: string;
  readonly permissionVersion: number;
  readonly grants: readonly PermissionGrant[];
}
export type AuthorityLookup = (nodeId: string, accountId: string) => Authority | undefined;
const authoritySchema = z.strictObject({
  nodeId: identifierSchema,
  accountId: identifierSchema,
  permissionVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  grants: z.array(z.strictObject({ capability: capabilitySchema, fingerprint: identifierSchema })).max(64),
});

export class ContractRegistry {
  private readonly contracts = new Map<string, InstalledContract>();

  register(contract: ReadContract): () => void {
    const capability = Object.freeze(capabilitySchema.parse(contract.capability));
    const fingerprint = identifierSchema.parse(contract.fingerprint);
    if (!(contract.input instanceof z.ZodType) || !(contract.output instanceof z.ZodType)) {
      throw new Error('A trusted local validator is required');
    }
    const key = capabilityKey(capability);
    if (this.contracts.has(key)) throw new Error('Feature node contract already registered');
    const installed: InstalledContract = Object.freeze({
      capability, fingerprint, input: contract.input, output: contract.output,
      maxInputBytes: tightenedLimit(contract.maxInputBytes, MAX_FRAME_BYTES),
      maxOutputBytes: tightenedLimit(contract.maxOutputBytes, MAX_FRAME_BYTES),
    });
    this.contracts.set(key, installed);
    return () => { if (this.contracts.get(key) === installed) this.contracts.delete(key); };
  }

  get(ref: CapabilityRef): InstalledContract | undefined {
    return this.contracts.get(capabilityKey(ref));
  }

  isCurrent(contract: InstalledContract): boolean {
    return this.get(contract.capability) === contract;
  }

  validate(contract: InstalledContract, kind: 'input' | 'output', value: unknown): Outcome<JsonValue> {
    const code = kind === 'input' ? 'invalid_input' : 'invalid_output';
    const limit = kind === 'input' ? contract.maxInputBytes : contract.maxOutputBytes;
    const copied = immutableJson(value, limit);
    if (!copied.success) return failure(code);
    try {
      const validated = contract[kind].safeParse(copied.payload);
      if (!validated.success) return failure(code);
      const result = immutableJson(validated.data, limit);
      return result.success ? result : failure(code);
    } catch {
      return failure(code);
    }
  }
}

export function readAuthority(lookup: AuthorityLookup, nodeId: string, accountId: string): Authority | undefined {
  try {
    const copied = immutableJson(lookup(nodeId, accountId));
    if (!copied.success) return undefined;
    const parsed = authoritySchema.safeParse(copied.payload);
    if (!parsed.success || parsed.data.nodeId !== nodeId || parsed.data.accountId !== accountId) return undefined;
    return Object.freeze({
      ...parsed.data,
      grants: Object.freeze(parsed.data.grants.map((grant) => Object.freeze({
        ...grant, capability: Object.freeze(grant.capability),
      }))),
    });
  } catch {
    return undefined;
  }
}

export function isAuthorized(
  lookup: AuthorityLookup, bound: Authority, capability: CapabilityRef,
  fingerprint: string, permissionVersion: number,
): boolean {
  const current = readAuthority(lookup, bound.nodeId, bound.accountId);
  if (!current || permissionVersion !== bound.permissionVersion
    || current.permissionVersion !== permissionVersion) return false;
  const matches = (grant: PermissionGrant) => capabilityKey(grant.capability) === capabilityKey(capability)
    && grant.fingerprint === fingerprint;
  return bound.grants.some(matches) && current.grants.some(matches);
}
