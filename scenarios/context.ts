import { isDeepStrictEqual } from 'node:util';
import { formatUnits } from '../src/domain/units.js';
import type { Sandbox } from './harness.js';
import type { CheckResult, Json, Narrator, ScenarioDefinition, Stage } from './types.js';

/** JSON-safe copy of anything a scenario observes: bigint -> decimal string, Map/Set/Date/undefined handled. */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return toJson(Object.fromEntries(value));
  if (value instanceof Set) return toJson([...value]);
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJson(v)]));
  }
  return typeof value; // function / symbol: not evidence
}

export const short = (hash: string | null | undefined): string => (hash ? `${hash.slice(0, 10)}…` : '-');

/**
 * What a scenario talks to while it runs: it narrates (for the demo), records evidence, and evaluates
 * checks. `check` compares an observed value with an independently derived expectation using deep strict
 * equality; there is no way to record a pass without comparing something.
 */
export class ScenarioContext {
  readonly checks: CheckResult[] = [];
  readonly evidence: Record<string, Json> = {};

  constructor(
    readonly sandbox: Sandbox,
    private readonly def: ScenarioDefinition,
    private readonly narrator: Narrator | null,
  ) {}

  stage(stage: Stage, text: string): void {
    this.narrator?.stage(stage, text);
  }

  note(text: string, data?: unknown): void {
    this.narrator?.note(text, data === undefined ? undefined : toJson(data));
  }

  table(title: string, rows: Array<Record<string, unknown>>): void {
    this.narrator?.table(title, rows.map((r) => toJson(r) as Record<string, Json>));
  }

  /** Stores a named observation in the scenario result (visible in GET /scenarios/:id). */
  record(key: string, value: unknown): void {
    this.evidence[key] = toJson(value);
  }

  /** Evaluates one declared check: passes only if `actual` deep-equals `expected`. */
  check(id: string, actual: unknown, expected: unknown): void {
    const declared = this.def.checks.find((c) => c.id === id);
    if (!declared) throw new Error(`scenario ${this.def.id} evaluated an undeclared check "${id}"`);
    const result: CheckResult = {
      id,
      description: declared.description,
      passed: isDeepStrictEqual(actual, expected),
      expected: toJson(expected),
      actual: toJson(actual),
    };
    this.checks.push(result);
    this.narrator?.check(result);
  }

  /** Convenience for boolean conditions. `detail` is shown as the actual value when the check fails. */
  ok(id: string, condition: boolean, detail?: unknown): void {
    this.check(id, condition ? true : (detail ?? false), true);
  }

  /** Human-readable rows for the canonical events currently stored, for narration and evidence. */
  async eventRows(opts: { includeOrphaned?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
    const sb = this.sandbox;
    const events = (await sb.events()).filter((e) => opts.includeOrphaned || e.status !== 'orphaned');
    return events.map((e) => {
      const watch = sb.watch.byAddress.get(e.contract);
      return {
        block: e.blockNumber,
        log: e.logIndex,
        kind: e.kind === 'erc20_transfer' ? 'Transfer' : 'SettlementRecorded',
        token: watch?.symbol ?? '?',
        amount: watch ? formatUnits(e.amount, watch.decimals) : e.amount.toString(),
        status: e.status,
        event: `${e.eventId.split(':')[1]?.slice(0, 10)}…#${e.logIndex}`,
      };
    });
  }
}
