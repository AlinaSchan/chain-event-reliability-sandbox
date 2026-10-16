import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateOpenApi } from '../../scripts/generate-openapi.js';

describe('docs/openapi.json', () => {
  it('is exactly what the server\'s route schemas generate (regenerate with: npm run openapi)', async () => {
    const committed = readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8');
    expect(await generateOpenApi()).toBe(committed);
  });

  it('documents the required endpoints, request validation and the admin security scheme', async () => {
    const doc = JSON.parse(await generateOpenApi()) as {
      openapi: string;
      paths: Record<string, Record<string, { tags?: string[]; security?: unknown[]; parameters?: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    for (const path of ['/healthz', '/status', '/events', '/events/{id}', '/alerts', '/scenarios', '/scenarios/{id}', '/metrics']) {
      expect(doc.paths[path]?.get, path).toBeDefined();
    }
    expect(doc.paths['/events']?.get?.parameters?.length).toBeGreaterThanOrEqual(6); // validated query parameters are part of the contract
    const admin = Object.entries(doc.paths).filter(([p]) => p.startsWith('/admin/'));
    expect(admin.length).toBeGreaterThanOrEqual(6);
    for (const [, methods] of admin) {
      for (const op of Object.values(methods)) {
        expect(op.tags).toEqual(['admin']);
        expect(op.security).toEqual([{ adminBearer: [] }]);
      }
    }
    expect(doc.components.securitySchemes).toHaveProperty('adminBearer');
  });
});
