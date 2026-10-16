import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/fault-injection/**/*.test.ts'],
          environment: 'node',
          sequence: { groupOrder: 2 },
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Every test file works in its own PostgreSQL schema and Redis key prefix,
          // so files can run in parallel.
          maxWorkers: 4,
        },
      },
    ],
  },
});
