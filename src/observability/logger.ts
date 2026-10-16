import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logging. Every log line that records a state change or a recovery step carries a
 * stable machine-readable `event` field (for example `reorg.applied`, `backfill.range`,
 * `checkpoint.advanced`) so that logs can be used as evidence, not just read.
 */
export function createLogger(opts: { level?: string; destination?: DestinationStream; name?: string } = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: { service: opts.name ?? 'chain-event-sandbox' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    opts.destination,
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export interface LogLine {
  level: string;
  event?: string;
  msg?: string;
  [key: string]: unknown;
}

/** Collects log lines in memory so tests and scenarios can assert on and quote them. */
export class LogCapture {
  readonly lines: LogLine[] = [];

  private readonly destination: DestinationStream = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') this.lines.push(JSON.parse(line) as LogLine);
      }
    },
  };

  /** No timestamps and no pid/host, so captured lines are identical from run to run. */
  logger(level = 'debug'): Logger {
    return pino({ level, base: null, timestamp: false, formatters: { level: (label) => ({ level: label }) } }, this.destination);
  }

  events(name: string): LogLine[] {
    return this.lines.filter((l) => l.event === name);
  }

  count(name: string): number {
    return this.events(name).length;
  }
}
