import { s01 } from './s01-missed-notification.js';
import { s02 } from './s02-duplicate-delivery.js';
import { s03 } from './s03-crash-after-commit.js';
import { s04 } from './s04-reorganization.js';
import { s05 } from './s05-rpc-timeout.js';
import { s06 } from './s06-delayed-confirmations.js';
import { s07 } from './s07-outbox-delivery-failure.js';
import { s08 } from './s08-restart-and-replay.js';
import { s09 } from './s09-thresholds-and-decimals.js';
import type { ScenarioDefinition, ScenarioId } from './types.js';

export const SCENARIOS: readonly ScenarioDefinition[] = [s01, s02, s03, s04, s05, s06, s07, s08, s09];

export function findScenario(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());
}

export const SCENARIO_IDS: readonly ScenarioId[] = SCENARIOS.map((s) => s.id);

export { runScenario, persistResult } from './runner.js';
