import type { HeadRef } from '../domain/types.js';
import type { HeadNotifier, HeadSubscriber } from '../ingestion/ports.js';
import type { FixtureChain } from './chain.js';

export class FixtureNotifier implements HeadNotifier {
  private readonly subscribers = new Set<HeadSubscriber>();
  private isConnected = true;
  private dropRemaining = 0;
  private duplicateRemaining = 0;
  readonly stats = { delivered: 0, dropped: 0, duplicated: 0 };

  constructor(chain: FixtureChain) {
    chain.onHead((head) => this.publish(head));
  }

  get connected(): boolean {
    return this.isConnected;
  }

  subscribe(subscriber: HeadSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Connection drops. Heads mined while disconnected are never delivered, not even later. */
  disconnect(): void {
    if (!this.isConnected) return;
    this.isConnected = false;
    for (const s of this.subscribers) s.onDisconnect();
  }

  reconnect(): void {
    if (this.isConnected) return;
    this.isConnected = true;
    for (const s of this.subscribers) s.onConnect();
  }

  /** Silently loses the next `n` notifications while staying connected. */
  dropNext(n: number): void {
    this.dropRemaining = n;
  }

  /** Delivers each of the next `n` notifications twice. */
  duplicateNext(n: number): void {
    this.duplicateRemaining = n;
  }

  private publish(head: HeadRef): void {
    if (!this.isConnected || this.dropRemaining > 0) {
      if (this.dropRemaining > 0) this.dropRemaining -= 1;
      this.stats.dropped += 1;
      return;
    }
    let copies = 1;
    if (this.duplicateRemaining > 0) {
      this.duplicateRemaining -= 1;
      copies = 2;
      this.stats.duplicated += 1;
    }
    for (let i = 0; i < copies; i++) {
      this.stats.delivered += 1;
      for (const s of this.subscribers) s.onHead(head);
    }
  }
}
