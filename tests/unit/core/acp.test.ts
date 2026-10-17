// The ACP engine against a real process speaking the protocol (tests/fixtures/acp/agent.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { localEnvironment } from '../../../packages/core/src/env/local.ts';
import { acpRun, permissionChoice } from '../../../packages/core/src/engine/acp.ts';

const AGENT = fileURLToPath(new URL('../../fixtures/acp/agent.mjs', import.meta.url));
const env = localEnvironment();
async function run(req: Partial<RunRequest>, ...flags: string[]) {
  const out: RunEvent[] = [];
  for await (const e of acpRun(env, process.execPath, [AGENT, ...flags], { target: 'fake', task: 'hi', ...req }, { signal: new AbortController().signal })) out.push(e);
  return out;
}
test('ACP: initialize → session/new → prompt; text chunks, tool calls, the session id, end_turn → done', async () => {
  assert.deepEqual(await run({}), [{ type: 'session', id: 'fake-cwd' }, { type: 'tool', name: 'read', summary: 'Looking around' },
    { type: 'text', text: 'echo fake-cwd: ' }, { type: 'text', text: 'hi' }, { type: 'done', result: 'echo fake-cwd: hi' }]);
});
test('ACP: a session is continued with session/load (its replayed history is skipped); agents without it refuse', async () => {
  assert.deepEqual((await run({ session: 's9' })).filter(e => e.type !== 'tool').at(-1), { type: 'done', result: 'echo s9: hi' });
  assert.deepEqual(await run({ session: 's9' }, '--no-load'), [{ type: 'error', message: 'this agent cannot continue a session (no session/load)' }]);
});
test('ACP: edits are allowed only with a folder and an editing kind; other stop reasons are errors', async () => {
  const denied = await run({ task: 'edit it' });
  assert.deepEqual([denied.at(-1)!.type, denied.find(e => e.type === 'text')], ['done', { type: 'text', text: 'permission: no' }]);
  assert.deepEqual((await run({ task: 'edit it', cwd: process.cwd(), kind: 'code-edit' })).find(e => e.type === 'text'), { type: 'text', text: 'permission: yes' });
  assert.deepEqual((await run({ task: 'refuse' })).at(-1), { type: 'error', message: 'the agent stopped: refusal' });
  assert.equal(permissionChoice({}, 'read', [{ optionId: 'a', kind: 'allow_always' }]), 'a');
  assert.equal(permissionChoice({}, 'execute', [{ optionId: 'a', kind: 'allow_once' }]), null, 'no reject option: cancelled');
});
test('ACP: a program that is not there is an error, not a hang', async () => {
  await assert.rejects(async () => { for await (const _ of acpRun(env, 'no-such-acp-agent', [], { target: 'x', task: 'hi' }, { signal: new AbortController().signal })); }, /exited with 127/);
});
