// End-to-end check against a real Pi binary (npm Pi, Pi-Bolt, ...), whose docs wording may differ from
// any npm build. Runs the host in RPC mode with an isolated agent dir and a fake openai-completions server,
// and asserts on what the provider actually receives: ordinary -> /pi -> ordinary, plain and with an
// earlier extension that forces a prompt composed from Pi's native rendering.
// Usage: node tests/host-e2e.mjs <pi binary> [extra pi args...]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [bin, ...extra] = process.argv.slice(2);
if (!bin) { console.error('Usage: node tests/host-e2e.mjs <pi binary> [extra pi args...]'); process.exit(2); }
const slim = resolve(dirname(fileURLToPath(import.meta.url)), '../extensions/remove-pi-docs.ts');
const DOCS_HEADER = 'Pi documentation (read only';

// Loaded before slim, like an extension that composes its own prompt from Pi's rendering.
const FORCE_EXTENSION = `export default function (pi) {
  pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '\\n\\nFORCED_TAIL' }));
}\n`;

async function run(force) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = o => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'offline', ...o })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-slim-host-agent-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pi-slim-host-cwd-'));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'offline',
    models: [{ id: 'offline', name: 'offline', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024 }],
  } } }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const forceExt = join(agentDir, 'force-prompt.ts');
  writeFileSync(forceExt, FORCE_EXTENSION);
  const args = [...extra, '--mode', 'rpc', '--no-session', '--no-extensions', '-ns', '-np', '-nc', '--no-themes',
    ...(force ? ['-e', forceExt] : []), '-e', slim, '--provider', 'fake', '--model', 'offline'];
  const child = spawn(bin, args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', line => {
    let record; try { record = JSON.parse(line); } catch { return; }
    for (const w of [...waiters]) if (w.match(record)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(record); }
  });
  const waitFor = match => new Promise((resolve, reject) => {
    waiters.push({ match, resolve });
    setTimeout(() => reject(new Error(`host timed out; stderr:\n${stderr}`)), 30000).unref();
  });
  const sent = [];
  try {
    for (const [i, message] of ['ordinary one', '/pi explain extensions', 'ordinary two'].entries()) {
      const before = requests.length;
      const response = waitFor(r => r.type === 'response' && r.id === `p${i}`);
      const settled = waitFor(r => r.type === 'agent_settled'); // /pi is handled, then submits its own run
      child.stdin.write(JSON.stringify({ id: `p${i}`, type: 'prompt', message }) + '\n');
      const r = await response;
      assert.notEqual(r.success, false, `prompt failed: ${JSON.stringify(r)}`);
      await settled;
      sent.push({ message, requests: requests.slice(before).map(q => JSON.stringify(q.messages)) });
    }
  } finally {
    child.kill();
    server.close();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
  const label = force ? 'forced prompt' : 'plain';
  for (const { message, requests: reqs } of sent) {
    assert.equal(reqs.length, 1, `${label}: ${message} sent ${reqs.length} requests`);
    const text = reqs[0];
    assert.equal(text.includes(DOCS_HEADER), message.startsWith('/pi '), `${label}: docs ${message.startsWith('/pi ') ? 'missing from' : 'leaked into'} "${message}"`);
    assert.ok(!text.includes('pi-slim:'), `${label}: internal marker leaked into "${message}"`);
    if (force) assert.ok(text.includes('FORCED_TAIL'), `${label}: forced prompt lost in "${message}"`);
  }
  console.log(`ok ${label}: ordinary clean, /pi keeps docs, next ordinary clean`);
}

await run(false);
await run(true);
