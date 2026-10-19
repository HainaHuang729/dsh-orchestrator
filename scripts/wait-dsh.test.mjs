import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpTransport, waitForSession } from './wait-dsh.mjs';

const sessionId = 'session-fake';
const fresh = [
  { role: 'assistant', seq: 5, text: 'old' },
  { role: 'user', seq: 6, text: 'new task' },
  { role: 'assistant', seq: 7, text: 'progress' },
  { role: 'assistant', seq: 8, time: 1234, text: 'finished' },
];

function fake(states, messages = fresh) {
  let clock = 0, index = 0;
  const calls = [];
  return {
    calls,
    async run(options = {}) {
      return waitForSession({ sessionId, afterSeq: 5, timeoutMs: 50, pollMs: 10, requestTimeoutMs: 10, ...options }, async (name, args, { signal }) => {
        assert(signal instanceof AbortSignal);
        calls.push({ name, args });
        if (name === 'session_messages') return { messages };
        assert.equal(name, 'session_list');
        assert.equal(args.limit, 200);
        const state = states[Math.min(index++, states.length - 1)];
        if (state instanceof Error) throw state;
        return { sessions: [{ sessionId: 'other-session', running: false }, ...(state === null ? [] : [{ sessionId, running: state }])] };
      }, { now: () => clock, sleep: async ms => { clock += ms; } });
    },
  };
}

test('running then two idle observations returns only the final fresh assistant', async () => {
  const transport = fake([true, false, false]);
  const result = await transport.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.result.text, 'finished');
  assert.equal(result.promptSeq, 6);
  assert.equal(result.polls, 3);
  assert.equal(transport.calls.filter(call => call.name === 'session_messages').length, 1);
});

test('initial idle/start race resets the consecutive idle count', async () => {
  const transport = fake([false, true, false, false]);
  const result = await transport.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.polls, 4);
  assert.deepEqual(transport.calls.map(call => call.name), ['session_list', 'session_list', 'session_list', 'session_list', 'session_messages']);
});

test('runtime user injections do not replace the original task prompt marker', async () => {
  const transport = fake([true, false, false], [
    { role: 'assistant', seq: 5, text: 'old' },
    { role: 'user', seq: 8, text: 'actual task' },
    { role: 'assistant', seq: 20, text: 'working' },
    { role: 'user', seq: 100, text: 'runtime context' },
    { role: 'user', seq: 200, text: 'skills and time' },
    { role: 'user', seq: 335, text: 'permission reminder' },
    { role: 'assistant', seq: 400, text: 'finished task' },
  ]);
  const result = await transport.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.promptSeq, 8);
  assert.equal(result.result.seq, 400);
  assert.equal(result.result.text, 'finished task');
});

test('still running at timeout remains pending with session identity', async () => {
  const transport = fake([true]);
  const result = await transport.run({ timeoutMs: 25 });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.lastRunning, true);
  assert.equal(result.elapsedMs, 25);
  assert(transport.calls.every(call => call.name === 'session_list'));
});

test('an old assistant response after idle is never completion of this prompt', async () => {
  const transport = fake([false], fresh.slice(0, 2));
  const result = await transport.run();
  assert.equal(result.status, 'pending');
  assert.equal(result.detail, 'no_new_assistant_after_prompt');
  assert.equal(result.result, undefined);
});

test('network errors never turn into successful completion', async () => {
  const transport = fake([new Error('network unavailable')]);
  const result = await transport.run();
  assert.equal(result.status, 'pending');
  assert.equal(result.lastError, 'network unavailable');
  assert.equal(result.detail, 'observation_error');
});

test('missing exact session does not accept an unrelated idle session', async () => {
  const result = await fake([null]).run();
  assert.equal(result.status, 'pending');
  assert.equal(result.detail, 'session_not_in_first_200');
});

test('an observation error interrupts idle confirmation', async () => {
  const transport = fake([false, new Error('temporary'), false, false]);
  const result = await transport.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.polls, 3);
  assert.equal(transport.calls.filter(call => call.name === 'session_messages').length, 1);
});

test('HTTP client initializes, parses SSE, and calls only read-only tools', async () => {
  const requests = [];
  const call = createMcpTransport({ token: 'fake-test-token', fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    assert(request.signal instanceof AbortSignal);
    assert.equal(request.headers.Authorization, 'Bearer fake-test-token');
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: JSON.stringify({ sessions: [] }) }] };
    return new Response(body.id === undefined ? '' : `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200, headers: { 'mcp-session-id': 'fake-http-session' } });
  } });
  assert.deepEqual(await call('session_list', { limit: 200 }, { signal: AbortSignal.timeout(1000) }), { sessions: [] });
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'notifications/initialized', 'tools/call']);
  await assert.rejects(() => call('session_prompt', {}, { signal: AbortSignal.timeout(1000) }), /Read-only/);
});
