import { keccak256, stringToHex } from 'viem';

/** Derives a 32-bit seed from arbitrary parts. Same parts, same seed, on every machine. */
export function seedFrom(...parts: Array<string | number>): number {
  const digest = keccak256(stringToHex(parts.join('|')));
  return Number.parseInt(digest.slice(2, 10), 16) >>> 0;
}

/** mulberry32: tiny, fast, and fully deterministic. Not for anything security related. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform-ish bigint in [0, maxExclusive). Built from 32-bit draws so it works above 2^53. */
export function randBelow(rng: () => number, maxExclusive: bigint): bigint {
  if (maxExclusive <= 1n) return 0n;
  const bits = maxExclusive.toString(2).length;
  const chunks = Math.ceil(bits / 32) + 1; // one spare chunk keeps modulo bias negligible
  let value = 0n;
  for (let i = 0; i < chunks; i++) {
    value = (value << 32n) | BigInt(Math.floor(rng() * 4294967296));
  }
  return value % maxExclusive;
}
