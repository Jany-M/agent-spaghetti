// A minimal ACP agent for tests: newline-delimited JSON-RPC on stdio (agentclientprotocol.com, protocol v1).
// Prompt "edit …" asks permission for an edit; "refuse" stops with refusal; anything else echoes. Arg --no-load: no session/load.
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const say = (s, t) => update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
let waiting = null;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 'p1' && waiting) { const w = waiting; waiting = null; say(w.s, `permission: ${m.result.outcome.optionId ?? m.result.outcome.outcome}`); send({ id: w.id, result: { stopReason: 'end_turn' } }); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !process.argv.includes('--no-load') }, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: `fake-${m.params.cwd ? 'cwd' : 'x'}` } });
  else if (m.method === 'session/load') { say(m.params.sessionId, 'OLD HISTORY'); send({ id: m.id, result: {} }); }
  else if (m.method === 'session/prompt') {
    const s = m.params.sessionId, text = m.params.prompt[0].text;
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Looking around', kind: 'read', status: 'pending' });
    if (text === 'refuse') return send({ id: m.id, result: { stopReason: 'refusal' } });
    if (text.startsWith('edit')) {
      waiting = { id: m.id, s };
      return send({ id: 'p1', method: 'session/request_permission', params: { sessionId: s, toolCall: { toolCallId: 'c2', title: 'Write a.txt', kind: 'edit' },
        options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    }
    say(s, `echo ${s}: `); say(s, text);
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  } else if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'nope' } });
});
