import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { firstNumber, programOf, levelsOf, parseJson, pick, samePath, validate, wildcard, type Integration } from '@agent-spaghetti/sdk';

const schema = createRequire(import.meta.url)('@agent-spaghetti/sdk/manifest.schema.json');

test('json helpers', () => {
  assert.equal(pick({ a: { b: [1, { c: 2 }] } }, 'a.b.1.c'), 2);
  assert.equal(pick({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(parseJson('{bad'), undefined);
  assert.equal(firstNumber({ x: 'n', y: 5, z: 6 }, ['x', 'y', 'z']), 5);
});
test('wildcard and samePath', () => {
  assert.ok(wildcard('LM Studio*', 'lm studio 0.4.26'));
  assert.ok(!wildcard('Cursor*', 'My Cursor'));
  assert.ok(wildcard('a.b', 'A.B') && !wildcard('a.b', 'axb'));
  assert.ok(samePath('C:\\Apps\\X\\', 'c:/apps/x', 'windows'));
  assert.ok(!samePath('/home/u/A', '/home/u/a', 'linux'));
});
test('programOf: the tool\'s own program by name (any extension); never an app or extension folder found alongside', () => {
  const det = { installs: [{ path: 'C:/Apps/Kilo', via: 'installed' as const }, { path: 'C:/u/.vscode/extensions/kilocode.kilo-code-1', via: 'path' as const },
    { path: 'C:\\u\\AppData\\Local\\KiloDesktop\\app-1\\resources\\kilo\\win\\bin\\kilo.exe', via: 'path' as const }] };
  assert.match(programOf(det, 'kilo')!, /kilo\.exe$/);
  assert.equal(programOf(det, 'cline'), undefined);
  assert.equal(programOf({ installs: [{ path: '/usr/bin/x', via: 'bin' }] }), '/usr/bin/x');
});
const ok = { manifest: 1, id: 'x-y', name: 'X', roles: ['backend'], detect: { http: { port: 1, path: '/v1' }, paths: { linux: ['~/x'] }, version: { from: 'installed' } } };
test('manifest schema accepts a valid manifest and reports each error with its path', () => {
  assert.deepEqual(validate(schema, ok), []);
  assert.deepEqual(validate(schema, { ...ok, id: undefined }).length >= 1, true);
  assert.match(validate(schema, { ...ok, extra: 1 }).join(), /\/extra: unknown field/);
  assert.match(validate(schema, { ...ok, id: 'Bad Id' }).join(), /\/id: must match/);
  assert.match(validate(schema, { ...ok, detect: { http: { port: 'x', path: '/' } } }).join(), /\/detect\/http\/port: expected integer/);
  assert.match(validate(schema, { ...ok, detect: { version: { nope: 1 } } }).join(), /\/detect\/version: does not match/);
});
test('levels are derived; drive only once the engine exists', () => {
  const be: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'b', name: 'B', roles: ['backend'], models: { list: 'data', id: 'id' }, speaks: { openai: { port: 1, base: '/v1' } } } };
  assert.deepEqual(levelsOf(be, { openai: false, acp: false }), ['detect', 'observe']);
  assert.deepEqual(levelsOf(be, { openai: true, acp: false }), ['detect', 'observe', 'drive']);
  const cl: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'c', name: 'C', roles: ['client'], speaks: { mcpClient: { config: 'x', key: 'k' } } } };
  assert.deepEqual(levelsOf(cl, { openai: true, acp: true }), ['detect', 'client']);
  assert.deepEqual(levelsOf({ ...cl, module: { async inspect(_e, b) { return b; } } }, { openai: false, acp: false }), ['detect', 'observe', 'client']);
});
