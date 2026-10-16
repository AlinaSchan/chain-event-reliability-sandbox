import { keccak256, stringToHex } from 'viem';
import type { Hex } from '../domain/types.js';
import type { WatchEntry } from '../domain/watchlist.js';

/**
 * Synthetic addresses: the last 20 bytes of keccak256("cers:synthetic:<label>").
 * Nobody holds a key for these, they are not real wallets, and they carry no funds.
 */
export function syntheticAddress(label: string): Hex {
  return `0x${keccak256(stringToHex(`cers:synthetic:${label}`)).slice(-40)}`;
}

export const ACCOUNT_LABELS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'treasury', 'exchange'] as const;

/** Resolves a label ("alice") or a raw 0x address to an address. */
export function resolveAccount(labelOrAddress: string): Hex {
  return /^0x[0-9a-fA-F]{40}$/.test(labelOrAddress)
    ? (labelOrAddress.toLowerCase() as Hex)
    : syntheticAddress(`account:${labelOrAddress}`);
}

/**
 * The contracts the fixture emits events for. Decimals differ on purpose (0, 2, 6, 18) so the
 * threshold logic is exercised against every shape of base-unit conversion.
 */
export const FIXTURE_WATCHLIST: readonly WatchEntry[] = [
  { address: syntheticAddress('contract:USDX'), kind: 'erc20_transfer', symbol: 'USDX', decimals: 6, highValueThreshold: '10000' },
  { address: syntheticAddress('contract:WRAPX'), kind: 'erc20_transfer', symbol: 'WRAPX', decimals: 18, highValueThreshold: '5' },
  { address: syntheticAddress('contract:GOLDX'), kind: 'erc20_transfer', symbol: 'GOLDX', decimals: 0, highValueThreshold: '100' },
  { address: syntheticAddress('contract:SETTLE'), kind: 'settlement_recorded', symbol: 'SETTLE', decimals: 2, highValueThreshold: '250000.50' },
];
