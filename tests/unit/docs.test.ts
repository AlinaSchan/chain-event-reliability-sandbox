import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVARIANT_IDS } from '../../src/recovery/invariants.js';
import { RELATED_TESTS, renderScenarioDocs } from '../../scripts/generate-scenario-docs.js';
import { SCENARIOS } from '../../scenarios/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('generated documentation', () => {
  it('docs/failure-scenarios.md is exactly what the scenario definitions render (regenerate with: npm run docs:scenarios)', () => {
    expect(read('docs/failure-scenarios.md')).toBe(renderScenarioDocs());
  });

  it('every test file the scenario document points at exists', () => {
    for (const tests of Object.values(RELATED_TESTS)) {
      for (const entry of tests) {
        const file = entry.split(' ')[0] ?? '';
        expect(existsSync(path.join(root, file)), file).toBe(true);
      }
    }
  });
});

describe('docs/reliability-invariants.md', () => {
  it('lists every stored-state invariant the checker evaluates', () => {
    const doc = read('docs/reliability-invariants.md');
    for (const id of INVARIANT_IDS) expect(doc, id).toContain(`\`${id}\``);
  });

  it('points at code and test files that exist', () => {
    const doc = read('docs/reliability-invariants.md');
    const files = [...doc.matchAll(/`((?:src|tests|scenarios|scripts)\/[A-Za-z0-9_./-]+\.ts)[^`]*`/g)].map((m) => m[1] ?? '');
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(existsSync(path.join(root, file)), file).toBe(true);
  });
});

describe('docs/scope-contract.json', () => {
  const contract = JSON.parse(read('docs/scope-contract.json')) as Record<string, unknown>;

  it('has exactly the agreed fields', () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        'projectTitle',
        'projectSubtitle',
        'projectStatus',
        'proposedRole',
        'implementedComponents',
        'proposedComponents',
        'scenarioIds',
        'deliverables',
        'outOfScope',
        'indicativeDuration',
        'indicativeContributorHours',
        'compensationStatus',
        'knownLimitations',
        'repositoryUrl',
      ].sort(),
    );
  });

  it('states the terms exactly as agreed and invents no fee', () => {
    expect(contract.projectTitle).toBe('Chain Event Reliability Sandbox');
    expect(contract.indicativeDuration).toBe('2–3 weeks');
    expect(contract.indicativeContributorHours).toBe('16–20 hours');
    expect(contract.compensationStatus).toBe('Paid, fixed-scope review. Actual fee: not yet agreed. Final terms: subject to written agreement.');
    expect(JSON.stringify(contract)).not.toMatch(/[$€£]\s?\d|\d\s?(USD|EUR|GBP)\b/);
  });

  it('lists the same scenarios the code defines', () => {
    expect(contract.scenarioIds).toEqual(SCENARIOS.map((s) => s.id));
  });

  it('only claims implemented components whose paths exist', () => {
    const components = contract.implementedComponents as Array<{ name: string; paths: string[] }>;
    expect(components.length).toBeGreaterThanOrEqual(8);
    for (const c of components) {
      expect(c.paths.length, c.name).toBeGreaterThan(0);
      for (const p of c.paths) expect(existsSync(path.join(root, p)), `${c.name}: ${p}`).toBe(true);
    }
  });

  it('has a null repository URL until publication, then a github.com URL', () => {
    const url = contract.repositoryUrl;
    expect(url === null || (typeof url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/chain-event-reliability-sandbox$/.test(url))).toBe(true);
  });
});

describe('README and docs', () => {
  const texts = ['README.md', ...readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)].map((f) => ({ file: f, text: read(f) }));
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it('only mention npm scripts that exist', () => {
    for (const { file, text } of texts) {
      for (const m of text.matchAll(/npm run (?:-s )?([a-z][a-z:-]*)/g)) {
        expect(scripts[m[1] ?? ''], `${file}: npm run ${m[1]}`).toBeDefined();
      }
    }
  });

  it('only link to files that exist', () => {
    for (const { file, text } of texts) {
      for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)\)/g)) {
        const target = path.join(root, path.dirname(file), m[1] ?? '');
        expect(existsSync(target), `${file} -> ${m[1]}`).toBe(true);
      }
    }
  });

  it('avoid promotional claims and guarantees the project cannot back up', () => {
    for (const { file, text } of texts) {
      expect(text, file).not.toMatch(/battle-tested|enterprise-grade|revolutionary|100% reliable|bulletproof|zero[- ]downtime|guaranteed to/i);
    }
  });

  it('keep the "at-least-once, not exactly-once" statement in the README', () => {
    const readme = texts.find((t) => t.file === 'README.md')?.text ?? '';
    expect(readme).toMatch(/at-least-once/);
    expect(readme).toMatch(/does not claim exactly-once/i);
  });
});
