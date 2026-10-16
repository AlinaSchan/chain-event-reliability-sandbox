/**
 * Failpoints that simulate the process dying at an exact line. In production wiring the dependency is
 * simply absent. In tests and scenarios, arming a point makes its next hit throw `InjectedCrash`, which
 * stands in for SIGKILL: nothing after that line runs, and nothing may catch it and carry on.
 */
export type CrashPointName =
  | 'scanner.before_commit'
  | 'scanner.after_commit'
  | 'publisher.after_publish_before_mark'
  | 'consumer.before_effect_commit'
  | 'consumer.after_effect_before_ack';

export class InjectedCrash extends Error {
  override readonly name = 'InjectedCrash';
  constructor(readonly point: CrashPointName) {
    super(`injected crash at ${point}`);
  }
}

export class CrashPoints {
  private readonly armed = new Map<CrashPointName, number>();
  private readonly gates = new Map<CrashPointName, () => Promise<void>>();
  readonly triggered: CrashPointName[] = [];

  /**
   * Test control for interleavings: the next time `point` is reached via `pause()`, run `fn` and wait for
   * it before execution continues, then remove the gate. Lets a test start a competing operation while
   * the code under test is holding its locks.
   */
  gate(point: CrashPointName, fn: () => Promise<void>): this {
    this.gates.set(point, fn);
    return this;
  }

  async pause(point: CrashPointName): Promise<void> {
    const fn = this.gates.get(point);
    if (!fn) return;
    this.gates.delete(point);
    await fn();
  }

  /** The (afterHits + 1)-th hit of `point` throws, once. */
  arm(point: CrashPointName, opts: { afterHits?: number } = {}): this {
    this.armed.set(point, opts.afterHits ?? 0);
    return this;
  }

  disarmAll(): void {
    this.armed.clear();
  }

  hit(point: CrashPointName): void {
    const remaining = this.armed.get(point);
    if (remaining === undefined) return;
    if (remaining > 0) {
      this.armed.set(point, remaining - 1);
      return;
    }
    this.armed.delete(point);
    this.triggered.push(point);
    throw new InjectedCrash(point);
  }
}
