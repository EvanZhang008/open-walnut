/**
 * The vector the text-embed-worker fixture gives a text: 4 int8 values from an
 * FNV-1a hash, never all zero (a zero vector is the quarantine sentinel). Shared
 * by the fixture and the tests, so a test can check that every stored vector is
 * the embedding of the passage text at its seq.
 */
function textVec(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const out = new Int8Array(4);
  for (let i = 0; i < 4; i++) out[i] = ((h >>> (i * 8)) % 127) + 1;
  return out;
}
module.exports = { textVec };
