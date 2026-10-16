import { describe, expect, it } from 'vitest';
import { eventIdOf, notificationIdOf, parseEventId } from '../../src/domain/identity.js';
import type { Hex } from '../../src/domain/types.js';

const H = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const base = { chainId: 31337, blockHash: H(0xaa), transactionHash: H(0x11), logIndex: 3 };

describe('event identity', () => {
  it('is stable: the same occurrence always maps to the same id', () => {
    expect(eventIdOf(base)).toBe(eventIdOf({ ...base }));
  });

  it('normalizes hex case so differently-cased deliveries are the same event', () => {
    const upper = { ...base, blockHash: base.blockHash.toUpperCase().replace('0X', '0x') as Hex };
    expect(eventIdOf(upper)).toBe(eventIdOf(base));
  });

  it('keeps the same transaction in a different block apart (re-inclusion after a reorg is a new occurrence)', () => {
    expect(eventIdOf({ ...base, blockHash: H(0xbb) })).not.toBe(eventIdOf(base));
  });

  it('separates logs of one transaction, and separates chains', () => {
    expect(eventIdOf({ ...base, logIndex: 4 })).not.toBe(eventIdOf(base));
    expect(eventIdOf({ ...base, chainId: 1 })).not.toBe(eventIdOf(base));
  });

  it('round-trips through parseEventId and rejects malformed ids', () => {
    expect(parseEventId(eventIdOf(base))).toEqual(base);
    expect(() => parseEventId('nope')).toThrow(/malformed/);
  });
});

describe('notification identity', () => {
  const id = eventIdOf(base);

  it('is distinct from the event id and derived deterministically', () => {
    expect(notificationIdOf(id, 'event_confirmed', 1)).not.toBe(id);
    expect(notificationIdOf(id, 'event_confirmed', 1)).toBe(notificationIdOf(id, 'event_confirmed', 1));
  });

  it('differs per type and per confirmation epoch, so a re-confirmation is a new notification', () => {
    const ids = new Set([
      notificationIdOf(id, 'event_confirmed', 1),
      notificationIdOf(id, 'event_confirmed', 2),
      notificationIdOf(id, 'event_retracted', 1),
    ]);
    expect(ids.size).toBe(3);
  });
});
