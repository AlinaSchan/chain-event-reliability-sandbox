/**
 * Token amount arithmetic. All on-chain values are bigint base units; decimal strings are only ever
 * parsed and formatted with integer operations, never through Number.
 */

export class UnitsError extends Error {
  override readonly name = 'UnitsError';
}

export const MAX_UINT256 = (1n << 256n) - 1n;

/** Plain non-negative decimal: no sign, no exponent, no leading zeros, no thousands separators. */
const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new UnitsError(`decimals must be an integer in 0..77, got ${decimals}`);
  }
}

/** "1.5" with 6 decimals -> 1_500_000n. Rejects input that would need rounding instead of rounding it. */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (!DECIMAL_RE.test(value)) {
    throw new UnitsError(`not a plain non-negative decimal: ${JSON.stringify(value)}`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new UnitsError(
      `${JSON.stringify(value)} has ${fraction.length} fractional digits but the token has ${decimals} decimals`,
    );
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/** 1_500_000n with 6 decimals -> "1.5". Exact; trailing fractional zeros are trimmed. */
export function formatUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (value < 0n) throw new UnitsError('negative amounts are not representable');
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** The single definition of "high value": at or above the threshold, compared as integers. */
export function isHighValue(amount: bigint, thresholdUnits: bigint): boolean {
  return amount >= thresholdUnits;
}
