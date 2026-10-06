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

test('READMEの「バージョン」に現在の版が書かれている', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`現在の版は \`${pkg.version}\``), 'READMEの現在の版がpackage.jsonと違う');
});
