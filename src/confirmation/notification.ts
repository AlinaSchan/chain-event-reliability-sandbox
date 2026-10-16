import type { NotificationType } from '../domain/identity.js';
import type { EventKind, Hex } from '../domain/types.js';
import { formatUnits } from '../domain/units.js';
import type { ResolvedWatch } from '../domain/watchlist.js';

/** What a downstream consumer receives. Amounts are exact: base units as a decimal string, plus a formatted copy. */
export interface NotificationPayload {
  schema: 'cers.notification.v1';
  notificationId: string;
  type: NotificationType;
  chainId: number;
  eventId: string;
  eventKind: EventKind;
  contract: Hex;
  symbol: string | null;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  amountUnits: string;
  amount: string | null;
  thresholdUnits: string;
  /** The event's confirmation counter when this notification was created. */
  confirmationEpoch: number;
  /** Present on `event_confirmed`. */
  confirmedAtCheckpoint?: number;
  confirmationDepth?: number;
  /** Present on `event_retracted`. */
  retractionReason?: string;
}

export interface NotificationSource {
  notificationId: string;
  type: NotificationType;
  chainId: number;
  eventId: string;
  eventKind: EventKind;
  contract: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  amountUnits: string;
  thresholdUnits: string;
  confirmationEpoch: number;
}

export function buildPayload(
  source: NotificationSource,
  watch: ResolvedWatch | undefined,
  extra: Pick<NotificationPayload, 'confirmedAtCheckpoint' | 'confirmationDepth' | 'retractionReason'>,
): NotificationPayload {
  return {
    schema: 'cers.notification.v1',
    ...source,
    symbol: watch?.symbol ?? null,
    amount: watch ? formatUnits(BigInt(source.amountUnits), watch.decimals) : null,
    ...extra,
  };
}
