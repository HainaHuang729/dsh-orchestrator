import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function createMcpTransport({ token, endpoint = 'http://127.0.0.1:8790/mcp', fetchImpl = fetch }) {
  const url = new URL(endpoint);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'DSH endpoint must be loopback');
  assert(['http:', 'https:'].includes(url.protocol), 'DSH endpoint must use HTTP');
  let session, protocol, nextId = 0;
  async function rpc(method, params, signal, notification = false) {
    const id = notification ? undefined : ++nextId;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
    if (session) headers['Mcp-Session-Id'] = session;
    if (protocol) headers['MCP-Protocol-Version'] = protocol;
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal });
    session = response.headers.get('mcp-session-id') ?? session;
    if (!response.ok) throw new Error(`DSH HTTP ${response.status}`);
    const body = await response.text();
    if (notification) return;
    const messages = body.trim().startsWith('{') ? [JSON.parse(body)] : body.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      return data ? [JSON.parse(data)] : [];
    });
    const message = messages.find(value => value.id === id);
    assert(message, 'DSH RPC response missing matching id');
    if (message.error) throw new Error(`DSH RPC: ${message.error.message ?? message.error.code}`);
    assert(Object.hasOwn(message, 'result'), 'DSH RPC response missing result');
    return message.result;
  }
  return async function callTool(name, args, { signal }) {
    // This helper only observes; never send work or cancel a running turn.
    assert(['session_list', 'session_messages'].includes(name), 'Read-only DSH tool required');
    if (!protocol) {
      const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-local-wait', version: '1' } }, signal);
      protocol = initialized.protocolVersion;
      assert(typeof protocol === 'string', 'DSH protocol version missing');
      await rpc('notifications/initialized', {}, signal, true);
    }
    const result = await rpc('tools/call', { name, arguments: args }, signal);
    if (result.isError) throw new Error(`DSH ${name} returned an error`);
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert(text, `DSH ${name} returned no JSON text`);
    return JSON.parse(text);
  };
}

export async function waitForSession({ sessionId, afterSeq, timeoutMs = 1_800_000, pollMs = 10_000, requestTimeoutMs = 10_000 }, callTool, { now = Date.now, sleep = delay } = {}) {
  assert(typeof sessionId === 'string' && sessionId.trim(), 'sessionId is required');
  assert(Number.isSafeInteger(afterSeq) && afterSeq >= -1, 'afterSeq must be the last session seq before this prompt (or -1 for empty)');
  for (const [key, value] of Object.entries({ timeoutMs, pollMs, requestTimeoutMs })) assert(Number.isSafeInteger(value) && value > 0, `${key} must be positive milliseconds`);
  const started = now(), deadline = started + timeoutMs;
  let idleSamples = 0, polls = 0, lastRunning = null, detail = 'not_observed', lastError;
  async function call(name, args) {
    const remaining = deadline - now();
    assert(remaining > 0, 'Wait deadline reached');
    return callTool(name, args, { signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)) });
  }
  while (now() < deadline) {
    try {
      const snapshot = await call('session_list', { limit: 200 });
      polls += 1;
      assert(Array.isArray(snapshot.sessions), 'DSH session_list returned no sessions array');
      const session = snapshot.sessions.find(value => value.sessionId === sessionId);
      if (!session) {
        idleSamples = 0;
        lastRunning = null;
        detail = 'session_not_in_first_200';
      } else {
        assert(typeof session.running === 'boolean', 'DSH session running state missing');
        lastRunning = session.running;
        idleSamples = session.running ? 0 : idleSamples + 1;
        detail = session.running ? 'running' : 'confirming_idle';
        if (idleSamples >= 2) {
          const transcript = await call('session_messages', { sessionId, limit: 500 });
          assert(Array.isArray(transcript.messages), 'DSH transcript messages missing');
          const messages = transcript.messages;
          for (const message of messages) assert(Number.isSafeInteger(message.seq) && message.seq >= 0, 'DSH transcript seq missing');
          // shortcut: MCP omits request identity; require one sender until it exposes a turn/request ID.
          const prompt = messages.filter(message => message.role === 'user' && message.seq > afterSeq).sort((a, b) => a.seq - b.seq).at(0);
          const assistant = prompt && messages.filter(message => message.role === 'assistant' && message.seq > prompt.seq && typeof message.text === 'string' && message.text.trim()).sort((a, b) => a.seq - b.seq).at(-1);
          if (assistant && now() < deadline) return { status: 'completed', sessionId, afterSeq, promptSeq: prompt.seq, result: { seq: assistant.seq, time: assistant.time, text: assistant.text }, polls, elapsedMs: now() - started };
          detail = prompt ? 'no_new_assistant_after_prompt' : 'prompt_not_visible_after_baseline';
        }
      }
    } catch (error) {
      idleSamples = 0;
      lastError = String(error.message ?? error).slice(0, 500);
      detail = 'observation_error';
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  return { status: 'pending', reason: 'timeout', sessionId, afterSeq, lastRunning, detail, ...(lastError ? { lastError } : {}), polls, elapsedMs: now() - started };
}

async function main() {
  const [sessionId, ...args] = process.argv.slice(2);
  const options = { sessionId };
  const flags = { '--after-seq': 'afterSeq', '--timeout-ms': 'timeoutMs', '--poll-ms': 'pollMs', '--request-timeout-ms': 'requestTimeoutMs' };
  for (let i = 0; i < args.length; i += 2) {
    assert(flags[args[i]] && args[i + 1] !== undefined, `Unknown or incomplete argument: ${args[i]}`);
    options[flags[args[i]]] = Number(args[i + 1]);
  }
  const token = readFileSync(join(homedir(), '.dsh', 'dsh-as-mcp', 'token'), 'utf8').trim();
  assert(token, 'DSH token file is empty');
  const result = await waitForSession(options, createMcpTransport({ token }));
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'completed' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ status: 'error', sessionId: process.argv[2] ?? null, error: String(error.message ?? error).slice(0, 500) }));
    process.exitCode = 1;
  });
}
