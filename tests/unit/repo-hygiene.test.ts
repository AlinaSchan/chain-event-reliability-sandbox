import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results']);
const TEXT_FILE = /\.(ts|js|mjs|json|md|yml|yaml|sql|txt|example)$|(^|\/)\.(gitignore|gitattributes|env\.example)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEXT_FILE.test(full.replaceAll('\\', '/')) && name !== 'package-lock.json') yield full;
  }
}

const files = [...walk(root)].map((full) => ({ rel: path.relative(root, full).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') }));

describe('repository hygiene', () => {
  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it('contains nothing shaped like a secret', () => {
    const patterns: Array<[string, RegExp]> = [
      ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
      ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
      ['API secret key', /\bsk-[A-Za-z0-9]{20,}\b/],
      ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
      ['private key assigned a 32-byte hex value', /(private|secret)[ _-]?key\W{0,8}0x[0-9a-fA-F]{64}/i],
      ['mnemonic assignment', /(mnemonic|seed phrase)\W{0,6}(\w+\s){11,}/i],
    ];
    for (const { rel, text } of files) {
      for (const [name, re] of patterns) expect(re.test(text), `${rel}: ${name}`).toBe(false);
    }
  });

  it('only embeds credentials in connection URLs that are the documented local placeholders', () => {
    const allowed = new Set(['sandbox:sandbox', 'unused:unused', 'nobody:nothing']);
    for (const { rel, text } of files) {
      for (const m of text.matchAll(/\b(?:postgres(?:ql)?|redis|mysql|mongodb):\/\/([^\s:@/'"`]+):([^\s@/'"`]+)@/g)) {
        expect(allowed.has(`${m[1]}:${m[2]}`), `${rel}: ${m[0]}`).toBe(true);
      }
    }
  });

  it('carries no vendor or tool attribution in code, docs or configuration', () => {
    // Built from pieces so this file does not match itself.
    const banned = [['cla', 'ude'].join(''), ['anthro', 'pic'].join(''), ['Co-Authored', 'By'].join('-')].map((w) => new RegExp(w, 'i'));
    for (const { rel, text } of files) {
      for (const re of banned) expect(re.test(text), `${rel}: ${re.source}`).toBe(false);
    }
  });

  it('uses only loopback addresses and documented placeholders for hosts', () => {
    for (const { rel, text } of files) {
      if (rel === 'package.json') continue;
      for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) {
        const host = m[0].replace(/^https?:\/\//, '');
        const ok = /^(127\.0\.0\.1|localhost|github\.com|logos\.co|docs\.github\.com|www\.postgresql\.org|redis\.io|opensource\.org|ethereum\.org|eips\.ethereum\.org)$/.test(host);
        expect(ok, `${rel}: ${m[0]}`).toBe(true);
      }
    }
  });
});
