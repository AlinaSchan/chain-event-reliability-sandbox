/**
 * Fault injection primitives. Everything here is deterministic: faults fire by call count, never by
 * chance or wall-clock time, so a scenario that fails once fails the same way every time.
 */

export type RpcMethod = 'getHead' | 'getHeader' | 'getLogs';

/**
 * timeout / server_error: the call throws.
 * stale: the call returns the previous successful response for the same method and arguments
 *        (a repeated or cached RPC response that no longer matches the chain).
 * duplicate_logs: getLogs returns every log twice (overlapping or repeated delivery).
 */
export type FaultAction = 'timeout' | 'server_error' | 'stale' | 'duplicate_logs';

export interface FaultRule {
  method: RpcMethod | '*';
  action: FaultAction;
  /** How many matching calls fault. */
  times: number;
  /** How many matching calls pass through untouched before the first fault. */
  skip?: number;
}

interface RuleState extends FaultRule {
  skipped: number;
  fired: number;
}

export interface FiredFault {
  seq: number;
  method: RpcMethod;
  action: FaultAction;
}

export class FaultPlan {
  private rules: RuleState[] = [];
  readonly fired: FiredFault[] = [];

  add(rule: FaultRule): this {
    this.rules.push({ ...rule, skipped: 0, fired: 0 });
    return this;
  }

  clear(): void {
    this.rules = [];
  }

  /** Consumes and returns the fault for this call, if any rule matches. */
  take(method: RpcMethod): FaultAction | undefined {
    for (const rule of this.rules) {
      if (rule.fired >= rule.times) continue;
      if (rule.method !== '*' && rule.method !== method) continue;
      if (rule.skipped < (rule.skip ?? 0)) {
        rule.skipped += 1;
        continue;
      }
      rule.fired += 1;
      this.fired.push({ seq: this.fired.length + 1, method, action: rule.action });
      return rule.action;
    }
    return undefined;
  }

  /** Faults that are configured but have not fired yet. */
  remaining(): number {
    return this.rules.reduce((sum, r) => sum + (r.times - r.fired), 0);
  }
}
