import { describe, expect, it } from 'vitest';
import { SCENARIOS, runScenario } from '../../scenarios/index.js';
import { redisUrl } from '../../scenarios/harness.js';

/**
 * The failure-scenario suite S01-S09, executed for real. Each scenario builds its own deterministic
 * fixture, injects its faults, and evaluates the checks it declared; this file only asserts that the
 * verdict is PASSED with every declared check evaluated. Scenarios that need Redis are SKIPPED (and
 * reported as skipped) when REDIS_URL is not set - never passed.
 */
describe.each(SCENARIOS)('$id - $title', (def) => {
  const missingRedis = def.requires.includes('redis') && redisUrl() === undefined;

  it.skipIf(missingRedis)(
    'passes every declared check',
    async () => {
      const result = await runScenario(def);
      expect(result.error, result.error).toBeUndefined();
      expect(result.checks.filter((c) => !c.passed)).toEqual([]);
      expect(result.executedChecks).toBe(result.declaredChecks);
      expect(result.status).toBe('passed');
    },
    90_000,
  );
});
