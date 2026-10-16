import type { SandboxOptions } from './harness.js';
import type { ScenarioContext } from './context.js';

export type ScenarioId = 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S07' | 'S08' | 'S09';

export type Requirement = 'postgres' | 'redis';

/** The seven steps of the demo, in order. Every scenario narrates through them. */
export type Stage = 'fixture' | 'baseline' | 'fault' | 'problem' | 'recovery' | 'final';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface DeclaredCheck {
  id: string;
  description: string;
}

/**
 * A failure scenario is data plus one function. It declares, up front, every check that must be
 * evaluated for it to count as passed; a scenario whose run ends without having evaluated all of them
 * is reported as FAILED ("not executed"), never as passed.
 */
export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  summary: string;
  /** The deterministic fixture: seed, shape, and the events placed in it. */
  fixture: string;
  /** What is injected. */
  faults: string[];
  /** What the system is expected to do about it. */
  expected: string[];
  /** The acceptance criterion from the brief, verbatim in spirit. */
  acceptance: string;
  requires: Requirement[];
  sandbox: SandboxOptions;
  checks: DeclaredCheck[];
  run: (ctx: ScenarioContext) => Promise<void>;
}

export interface CheckResult {
  id: string;
  description: string;
  passed: boolean;
  expected: Json;
  actual: Json;
}

export type ScenarioStatus = 'passed' | 'failed' | 'skipped';

export interface ScenarioResult {
  id: ScenarioId;
  title: string;
  status: ScenarioStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  declaredChecks: number;
  executedChecks: number;
  checks: CheckResult[];
  evidence: Record<string, Json>;
  error?: string;
  skipReason?: string;
}

/** Receives the narration of a run. The demo prints it; tests pass none. */
export interface Narrator {
  stage(stage: Stage, text: string): void;
  /** Structured log lines produced since the previous call, filtered to the ones that show recovery at work. */
  logs(lines: Array<Record<string, Json>>): void;
  note(text: string, data?: Json): void;
  table(title: string, rows: Array<Record<string, Json>>): void;
  check(result: CheckResult): void;
}
