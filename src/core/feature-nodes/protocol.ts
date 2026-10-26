import { z } from 'zod';

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_JSON_DEPTH = 20;
export const MAX_JSON_NODES = 4096;
export const MAX_READ_MS = 10_000;
export const MAX_PENDING_BYTES = 1024 * 1024;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Outcome<T = JsonValue> = { success: true; payload: T } | { success: false; code: FailureCode };
export const failureCodes = [
  'offline', 'unavailable', 'denied', 'expired', 'busy', 'cancelled',
  'malformed', 'invalid_input', 'invalid_output', 'internal',
] as const;
export type FailureCode = typeof failureCodes[number];

export const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const capabilitySchema = z.strictObject({
  id: identifierSchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type CapabilityRef = z.infer<typeof capabilitySchema>;
const correlation = {
  correlationId: identifierSchema,
  generation: identifierSchema,
};
const manifestSchema = z.strictObject({
  protocolVersion: z.literal(1),
  type: z.literal('manifest'),
  capabilities: z.array(capabilitySchema).max(64).refine(
    (items) => new Set(items.map(capabilityKey)).size === items.length,
  ),
});
const readSchema = z.strictObject({
  protocolVersion: z.literal(1),
  type: z.literal('read'),
  ...correlation,
  nodeId: identifierSchema,
  accountId: identifierSchema,
  capability: capabilitySchema,
  fingerprint: identifierSchema,
  permissionVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  input: z.unknown().refine((value) => value !== undefined),
});
const cancelSchema = z.strictObject({
  protocolVersion: z.literal(1), type: z.literal('cancel'), ...correlation,
});
const successSchema = z.strictObject({
  protocolVersion: z.literal(1), type: z.literal('result'), ...correlation,
  success: z.literal(true), payload: z.unknown().refine((value) => value !== undefined),
});
const failureSchema = z.strictObject({
  protocolVersion: z.literal(1), type: z.literal('result'), ...correlation,
  success: z.literal(false), code: z.enum(failureCodes),
});
export const frameSchema = z.union([
  manifestSchema, readSchema, cancelSchema, successSchema, failureSchema,
]);
export type Frame = z.infer<typeof frameSchema>;
export type ReadFrame = z.infer<typeof readSchema>;
export type ResultFrame = z.infer<typeof successSchema> | z.infer<typeof failureSchema>;
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export function capabilityKey(ref: CapabilityRef): string {
  return `${ref.id}/${ref.version}`;
}
export function failure(code: FailureCode): Outcome<never> {
  return { success: false, code };
}

export function boundedJson(value: unknown, maxBytes = MAX_FRAME_BYTES): Outcome<JsonValue> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) return failure('malformed');
  const root: { value?: JsonValue } = {};
  const stack: Array<{ value: unknown; depth: number; assign: (value: JsonValue) => void }> = [
    { value, depth: 0, assign: (copy) => { root.value = copy; } },
  ];
  let bytes = 0;
  let nodes = 0;
  const add = (amount: number) => { bytes += amount; return bytes <= maxBytes; };
  const stringBytes = (text: string) => text.length > maxBytes
    ? maxBytes + 1 : Buffer.byteLength(JSON.stringify(text), 'utf8');
  try {
    while (stack.length) {
      const item = stack.pop()!;
      if (++nodes > MAX_JSON_NODES || item.depth > MAX_JSON_DEPTH) return failure('malformed');
      const current = item.value;
      if (current === null || typeof current === 'boolean') {
        if (!add(current === null ? 4 : current ? 4 : 5)) return failure('malformed');
        item.assign(current);
      } else if (typeof current === 'number') {
        if (!Number.isFinite(current) || !add(String(current).length)) return failure('malformed');
        item.assign(current);
      } else if (typeof current === 'string') {
        if (!add(stringBytes(current))) return failure('malformed');
        item.assign(current);
      } else if (typeof current === 'object') {
        const array = Array.isArray(current);
        const proto = Object.getPrototypeOf(current);
        if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) return failure('malformed');
        const keys = Reflect.ownKeys(current);
        if (keys.length > MAX_JSON_NODES || keys.some((key) => typeof key !== 'string')) return failure('malformed');
        const descriptors = Object.getOwnPropertyDescriptors(current);
        for (const key of keys as string[]) {
          const descriptor = descriptors[key];
          if (!descriptor || !('value' in descriptor) || ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)) return failure('malformed');
          if (!(array && key === 'length') && !descriptor.enumerable) return failure('malformed');
        }
        const entries = (keys as string[]).filter((key) => !(array && key === 'length'));
        if (array) {
          const length = descriptors.length.value as number;
          if (length > MAX_JSON_NODES || entries.length !== length
            || entries.some((key, index) => key !== String(index))) return failure('malformed');
        }
        if (nodes + stack.length + entries.length > MAX_JSON_NODES || !add(2 + Math.max(0, entries.length - 1))) return failure('malformed');
        const copy: JsonValue[] | { [key: string]: JsonValue } = array ? [] : Object.create(null);
        item.assign(copy);
        for (let index = entries.length - 1; index >= 0; index--) {
          const key = entries[index];
          if (!array && !add(stringBytes(key) + 1)) return failure('malformed');
          stack.push({
            value: descriptors[key].value, depth: item.depth + 1,
            assign: (child) => { (copy as { [key: string]: JsonValue })[key] = child; },
          });
        }
      } else return failure('malformed');
    }
    return { success: true, payload: root.value! };
  } catch {
    return failure('malformed');
  }
}

export function immutableJson(value: unknown, maxBytes = MAX_FRAME_BYTES): Outcome<JsonValue> {
  const checked = boundedJson(value, maxBytes);
  if (!checked.success) return checked;
  const stack: JsonValue[] = [checked.payload];
  while (stack.length) {
    const item = stack.pop()!;
    if (item && typeof item === 'object') {
      stack.push(...Object.values(item));
      Object.freeze(item);
    }
  }
  return checked;
}

export function decodeFrame(raw: unknown): Outcome<Frame> {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME_BYTES
    || Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return failure('malformed');
  try {
    const checked = boundedJson(JSON.parse(raw));
    if (!checked.success) return checked;
    const parsed = frameSchema.safeParse(checked.payload);
    return parsed.success ? { success: true, payload: parsed.data } : failure('malformed');
  } catch {
    return failure('malformed');
  }
}

export function encodeFrame(value: unknown): Outcome<string> {
  const checked = boundedJson(value);
  if (!checked.success) return checked;
  const parsed = frameSchema.safeParse(checked.payload);
  if (!parsed.success) return failure('malformed');
  const text = JSON.stringify(checked.payload);
  return Buffer.byteLength(text, 'utf8') <= MAX_FRAME_BYTES
    ? { success: true, payload: text } : failure('malformed');
}

export function tightenedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid feature node limit');
  return value;
}
