/**
 * Does an installed component work: one real call per component, nothing
 * downloaded and no permission prompt. The build's --verify runs these on each
 * platform's runner, `walnut __selftest` runs them inside the compiled file
 * (selftest.ts), and the tests run them after installing from a local server.
 */

import type { ComponentName } from './types.js';

export interface SmokeTarget {
  /** createRequire rooted in the component dir. */
  require: NodeJS.Require;
  /** file URL of the component's entry module. */
  entryUrl: string;
}

// ── A one-node ONNX model (Identity on a float[2]), encoded by hand ──

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const key = (field: number, wire: number) => varint((field << 3) | wire);
const vint = (field: number, n: number) => [...key(field, 0), ...varint(n)];
const bytes = (field: number, b: number[]) => [...key(field, 2), ...varint(b.length), ...b];
const str = (field: number, s: string) => bytes(field, [...Buffer.from(s, 'utf8')]);

function valueInfo(name: string): number[] {
  const dim = bytes(1, vint(1, 2)); // Dimension { dim_value: 2 }
  const shape = bytes(2, dim); // TensorShapeProto { dim }
  const tensor = [...vint(1, 1), ...shape]; // elem_type FLOAT, shape
  return [...str(1, name), ...bytes(2, bytes(1, tensor))]; // ValueInfoProto { name, type { tensor_type } }
}

export function identityModel(): Uint8Array {
  const node = [...str(1, 'x'), ...str(2, 'y'), ...str(4, 'Identity')];
  const graph = [...bytes(1, node), ...str(2, 'g'), ...bytes(11, valueInfo('x')), ...bytes(12, valueInfo('y'))];
  const model = [...vint(1, 7), ...bytes(8, vint(2, 13)), ...bytes(7, graph)];
  return Uint8Array.from(model);
}

type Ort = {
  InferenceSession: { create(model: Uint8Array): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> }> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};

/** Throws with what failed; resolves with a one-line description of what worked. */
export async function smokeComponent(name: ComponentName, target: SmokeTarget): Promise<string> {
  if (name === 'embedding') {
    const transformers = await import(target.entryUrl) as { pipeline?: unknown; env?: { backends?: unknown } };
    if (typeof transformers.pipeline !== 'function') throw new Error('transformers has no pipeline()');
    const ort = target.require('onnxruntime-node') as Ort;
    const session = await ort.InferenceSession.create(identityModel());
    const out = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1.5, -2]), [2]) });
    const y = Array.from(out.y.data);
    if (y[0] !== 1.5 || y[1] !== -2) throw new Error(`onnxruntime answered ${JSON.stringify(y)}`);
    return 'transformers loads; onnxruntime ran a model on the CPU';
  }
  if (name === 'images') {
    const sharp = target.require('sharp') as typeof import('sharp');
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#336699' } }).png().toBuffer();
    const small = await sharp(png).resize({ width: 1568, height: 1568, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
    const meta = await sharp(small).metadata();
    if (meta.width !== 1568 || meta.format !== 'jpeg') throw new Error(`sharp resized to ${meta.width} ${meta.format}`);
    return `sharp resized 3000x2000 to ${meta.width}x${meta.height}`;
  }
  // Loading the addon asks for nothing; capturing would (screen recording permission).
  const mod = target.require('screencapturekit-audio-capture') as { AudioCapture?: unknown };
  if (typeof mod.AudioCapture !== 'function') throw new Error('the capture addon has no AudioCapture');
  return 'the ScreenCaptureKit addon loads';
}
