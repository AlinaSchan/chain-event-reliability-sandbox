import type { EventStatus, LifecycleState } from './types.js';

/**
 * Allowed transitions. `orphaned -> provisional` exists because a block that left the canonical
 * chain can come back (reorg followed by a reorg back); dropping that edge would leave canonical
 * events marked orphaned forever.
 */
const ALLOWED: Readonly<Record<LifecycleState, readonly EventStatus[]>> = {
  observed: ['provisional'],
  provisional: ['confirmed', 'orphaned'],
  confirmed: ['orphaned'],
  orphaned: ['provisional'],
};

export function canTransition(from: LifecycleState, to: EventStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: LifecycleState, to: EventStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal event transition ${from} -> ${to}`);
}

/**
 * Confirmation policy: an event in block N is confirmed once the durable checkpoint is at least
 * `depth` blocks above N (`checkpoint - N >= depth`), i.e. `depth` blocks sit on top of it.
 * The depth is measured against what this service has verified and stored, never against the
 * provider's self-reported head.
 */
export function highestConfirmableBlock(checkpointNumber: number, depth: number): number {
  return checkpointNumber - depth;
}

export function isConfirmable(eventBlockNumber: number, checkpointNumber: number, depth: number): boolean {
  return eventBlockNumber <= highestConfirmableBlock(checkpointNumber, depth);
}
