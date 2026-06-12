// Builds the Chrome Web Store release zip: runtime files only, no docs, tools,
// tests, git metadata, or store assets. Output: dist/steady-<version>.zip
//
// Usage: node tools/package.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const out = join(ROOT, 'dist', `steady-${manifest.version}.zip`);

const INCLUDE = [
  'manifest.json',
  'LICENSE',
  'onboarding.html',
  'onboarding.js',
  'src',
  'popup',
  'icons',
  'assets',
];

for (const entry of INCLUDE) {
  if (!existsSync(join(ROOT, entry))) {
    console.error(`missing: ${entry}`);
    process.exit(1);
  }
}

mkdirSync(join(ROOT, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, ...INCLUDE, '-x', '*.DS_Store'], {
  cwd: ROOT,
  stdio: 'inherit',
});
console.log(`\nwrote ${out}`);
