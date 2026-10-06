import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const pkg = read('../package.json'), lock = read('../package-lock.json');

test('版は 0.<Milestone>.<修正> の形で、package.jsonとpackage-lock.jsonで一致する', () => {
  assert.match(pkg.version, /^0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
});

test('開発文書の「バージョン」に現在の版が書かれている', () => {
  const development = readFileSync(new URL('../docs/development.md', import.meta.url), 'utf8');
  assert.ok(development.includes(`現在の版は \`${pkg.version}\``), '開発文書の現在の版がpackage.jsonと違う');
});
