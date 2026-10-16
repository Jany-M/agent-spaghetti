import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, redact } from '@agent-spaghetti/sdk';

test('repo scan flags tokens, uri passwords and private LAN ips', () => {
  assert.deepEqual(scanText('x ghp_' + 'a'.repeat(36), 'repo'), ['github-token']);
  assert.deepEqual(scanText('mongodb+srv://user:pw@host/db', 'repo'), ['uri-with-password']);
  assert.deepEqual(scanText('http://192.168.117.1:1234', 'repo'), ['private-lan-ip']);
  assert.deepEqual(scanText('http://192.0.2.10:1234 127.0.0.1 nothing', 'repo'), []);
});
test('runtime scan ignores LAN ips (endpoints are legitimate at runtime)', () => {
  assert.deepEqual(scanText('http://192.168.1.5:1234', 'always'), []);
});
test('redact masks secret values and secret-named keys, deeply, without mutating', () => {
  const src = { a: 'ok', token: 'abc', nested: [{ url: 'https://u:pw@h/x' }, 'sk_' + 'b'.repeat(24)], Authorization: 'Bearer z' };
  const out = redact(src);
  assert.deepEqual(out, { a: 'ok', token: '[redacted]', nested: [{ url: '[redacted]' }, '[redacted]'], Authorization: '[redacted]' });
  assert.equal(src.token, 'abc');
});
