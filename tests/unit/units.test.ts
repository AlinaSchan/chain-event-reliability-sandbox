import { describe, expect, it } from 'vitest';
import { formatUnits, isHighValue, MAX_UINT256, parseUnits, UnitsError } from '../../src/domain/units.js';
import { mulberry32, randBelow } from '../../src/fixtures/prng.js';

describe('parseUnits', () => {
  it('converts decimal strings to base units exactly', () => {
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('0', 18)).toBe(0n);
    expect(parseUnits('5', 0)).toBe(5n);
    expect(parseUnits('250000.50', 2)).toBe(25_000_050n);
    expect(parseUnits('5', 18)).toBe(5_000_000_000_000_000_000n);
  });

  it('keeps full precision above 2^53, where Number would silently round', () => {
    expect(Number('9007199254740993')).toBe(9007199254740992); // the trap
    expect(parseUnits('9007199254740993', 0)).toBe(9007199254740993n);
    expect(parseUnits(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256);
  });

  it('is exact where binary floating point is not (0.1 + 0.2 !== 0.3)', () => {
    expect(0.1 + 0.2 === 0.3).toBe(false);
    expect(parseUnits('0.1', 1) + parseUnits('0.2', 1)).toBe(parseUnits('0.3', 1));
  });

  it('refuses to round: more fractional digits than decimals is an error', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow(UnitsError);
    expect(() => parseUnits('0.5', 0)).toThrow(UnitsError);
  });

  it.each(['', ' 1', '1 ', '-1', '+1', '1e6', '0x10', '.5', '1.', '01', '1,000', '1.2.3', 'NaN', 'Infinity'])(
    'rejects %j',
    (input) => {
      expect(() => parseUnits(input, 6)).toThrow(UnitsError);
    },
  );

  it('rejects decimals outside 0..77', () => {
    expect(() => parseUnits('1', -1)).toThrow(UnitsError);
    expect(() => parseUnits('1', 78)).toThrow(UnitsError);
    expect(() => parseUnits('1', 1.5)).toThrow(UnitsError);
  });
});

describe('formatUnits', () => {
  it('formats exactly and trims trailing zeros', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(0n, 18)).toBe('0');
    expect(formatUnits(42n, 0)).toBe('42');
    expect(formatUnits(MAX_UINT256, 18)).toBe('115792089237316195423570985008687907853269984665640564039457.584007913129639935');
  });

  it('round-trips with parseUnits for random values and decimals (property)', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 500; i++) {
      const decimals = Math.floor(rng() * 40);
      const value = randBelow(rng, MAX_UINT256);
      expect(parseUnits(formatUnits(value, decimals), decimals)).toBe(value);
    }
  });
});

describe('isHighValue', () => {
  const threshold = parseUnits('10000', 6);

  it('is inclusive at the threshold and exact one base unit either side', () => {
    expect(isHighValue(threshold - 1n, threshold)).toBe(false);
    expect(isHighValue(threshold, threshold)).toBe(true);
    expect(isHighValue(threshold + 1n, threshold)).toBe(true);
  });

  it('compares near the top of uint256 without overflow or rounding', () => {
    expect(isHighValue(MAX_UINT256, threshold)).toBe(true);
    expect(isHighValue(MAX_UINT256 - 1n, MAX_UINT256)).toBe(false);
  });
});
