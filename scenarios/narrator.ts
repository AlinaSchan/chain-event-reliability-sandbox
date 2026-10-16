import type { CheckResult, Json, Narrator, Stage } from './types.js';

const STEP: Record<Stage, string> = {
  fixture: '1 PREPARE FIXTURE',
  baseline: '2 BASELINE INGESTION',
  fault: '4 FAULT INJECTION',
  problem: '5 PROBLEM DETECTED',
  recovery: '6 RECOVERY',
  final: '7 FINAL STATE',
};

/** Full 32-byte hashes are noise in a walk-through; the database, the API and the stored evidence keep them whole. */
const shorten = (text: string): string => text.replace(/0x[0-9a-f]{64}/g, (h) => `${h.slice(0, 10)}...`);

const NL = '\n';

const cell = (value: Json | undefined): string => {
  if (value === undefined || value === null) return '-';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

/** Plain-ASCII renderer for the demo: copy-pasteable, and the same on every terminal. */
export class ConsoleNarrator implements Narrator {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  stage(stage: Stage, text: string): void {
    this.write('');
    this.write(`[${STEP[stage]}] ${text}`);
  }

  logs(lines: Array<Record<string, Json>>): void {
    for (const line of lines) {
      const { level, ...rest } = line;
      this.write(`    log ${cell(level)} ${shorten(JSON.stringify(rest))}`);
    }
  }

  note(text: string, data?: Json): void {
    this.write(data === undefined ? `    - ${text}` : `    - ${text}: ${shorten(JSON.stringify(data))}`);
  }

  table(title: string, rows: Array<Record<string, Json>>): void {
    // Step 3 of the walk-through is "show the canonical events"; any table with that title is announced as such.
    if (title.startsWith('Canonical events')) this.write(`${NL}[3 CANONICAL EVENTS] ${title}${rows.length === 0 ? ' (none)' : ''}`);
    else this.write(`    ${title}${rows.length === 0 ? ' (none)' : ''}`);
    if (rows.length === 0) return;
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
    const line = (values: string[]) => `      ${values.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd();
    this.write(line(columns));
    this.write(line(widths.map((w) => '-'.repeat(w))));
    for (const row of rows) this.write(line(columns.map((c) => cell(row[c]))));
  }

  check(result: CheckResult): void {
    this.write(`    [${result.passed ? ' OK ' : 'FAIL'}] ${result.id}`);
    if (!result.passed) {
      this.write(`           expected ${JSON.stringify(result.expected)}`);
      this.write(`           actual   ${JSON.stringify(result.actual)}`);
    }
  }
}
