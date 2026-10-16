import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { createRuntime } from './runtime.js';

loadDotEnv();

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : (err as Error).message);
  process.exit(2);
}

const runtime = await createRuntime(config);
await runtime.start();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    runtime.logger.info({ event: 'app.stopping', signal }, 'shutting down');
    runtime.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  });
}
