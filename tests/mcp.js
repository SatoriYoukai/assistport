'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createSupportServer } = require('../mcp-server');
const { authorization } = require('../lib/authorization');
const c = require('../lib/common');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-mcp-test-'));
  const id = '0123456789abcdef';
  const config = { id, reversePort: 23022, expiresAt: new Date(Date.now() + 60000).toISOString(), authorization: authorization(), webToken: 'PRIVATE_TOKEN_FIXTURE' };
  c.writeJson(path.join(root, 'session.json'), config);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../mcp-server.js'), '--session', root], stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', (data) => { stderr += data; });
  const client = new Client({ name: 'support-tests', version: '1.0.0' });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 8); assert.equal(tools.some((tool) => /desktop|mouse|keyboard/.test(tool.name)), false);
    assert.equal(tools.find((tool) => tool.name === 'support_execute').annotations.idempotentHint, false);
    assert.equal(tools.find((tool) => tool.name === 'support_execute').annotations.destructiveHint, true);
    assert.ok(tools.every((tool) => tool.outputSchema && !Object.keys(tool.inputSchema.properties).some((key) => /session|key|token/.test(key))));
    const status = await call('support_status');
    assert.equal(status.isError, false); assert.equal(status.structuredContent.result.connectivity, 'unknown');
    assert.deepEqual(JSON.parse(status.content[0].text), status.structuredContent);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_TOKEN_FIXTURE/);
    assert.equal((await call('support_probe')).structuredContent.error.code, 'PROBE_FAILED');
    const noTarget = await call('support_execute', { command: 'Write-Output 1' });
    assert.equal(noTarget.isError, true); assert.equal(noTarget.structuredContent.error.code, 'NOT_REGISTERED');
    assert.equal((await call('support_execute', {})).structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal((await call('support_execute', { command: '1', session: 'other' })).isError, true);
    assert.equal((await call('support_execute', { command: '1', timeout: 0 })).isError, true);
    assert.equal((await call('support_tools', { operation: 'inspect' })).structuredContent.result.installed, false);
    await call('support_revoke');
    assert.equal(c.readJson(path.join(root, 'session.json')).revoked, true);
    assert.equal((await call('support_execute', { command: '1' })).structuredContent.error.code, 'SESSION_REVOKED');
    assert.equal((await call('support_status')).structuredContent.result.active, false);
    c.writeJson(path.join(root, 'session.json'), { ...config, id: 'fedcba9876543210' });
    assert.equal((await call('support_status')).structuredContent.error.code, 'IDENTITY_MISMATCH');
    assert.equal(stderr, '');
    console.log('PASS real MCP stdio handshake, tool schemas, results/errors, single-session binding and revocation');
  } finally { await client.close(); }
  try {
    c.writeJson(path.join(root, 'session.json'), config);
    let release, entered;
    const start = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const server = createSupportServer({ session: root, runner: async (options, state) => {
      state.sessionId = id;
      if (options.command === 'large') return { exitCode: 0, stdout: 'x'.repeat(1024 * 1024), stderr: '' };
      if (options.action === 'exec') { entered(); await held; return { exitCode: 0, stdout: 'done', stderr: '' }; }
      return { id, action: options.action };
    } });
    const pair = InMemoryTransport.createLinkedPair();
    const concurrent = new Client({ name: 'concurrency-test', version: '1.0.0' });
    await server.connect(pair[1]); await concurrent.connect(pair[0]);
    try {
      const active = concurrent.callTool({ name: 'support_execute', arguments: { command: '1' } });
      await start;
      const blocked = await concurrent.callTool({ name: 'support_execute', arguments: { command: '2' } });
      assert.equal(blocked.structuredContent.error.code, 'OPERATION_BUSY'); assert.equal(blocked.structuredContent.error.completion, 'not_started');
      assert.equal((await concurrent.callTool({ name: 'support_revoke', arguments: {} })).isError, false);
      release(); assert.equal((await active).isError, false);
      assert.equal((await concurrent.callTool({ name: 'support_execute', arguments: { command: '3' } })).isError, false);
      const oversized = await concurrent.callTool({ name: 'support_execute', arguments: { command: 'large' } });
      assert.equal(oversized.structuredContent.error.code, 'RESULT_LIMIT'); assert.equal(oversized.structuredContent.error.completion, 'completed');
    } finally { release(); await concurrent.close(); await server.close(); }
    c.writeJson(path.join(root, 'session.json'), { ...config, authorization: { capabilities: [] } });
    const reduced = createSupportServer({ session: root }); const pair2 = InMemoryTransport.createLinkedPair();
    const reducedClient = new Client({ name: 'scope-test', version: '1.0.0' });
    await reduced.connect(pair2[1]); await reducedClient.connect(pair2[0]);
    try { assert.deepEqual((await reducedClient.listTools()).tools.map((tool) => tool.name).sort(), ['support_probe', 'support_revoke', 'support_status', 'support_tools']); }
    finally { await reducedClient.close(); await reduced.close(); }
    console.log('PASS MCP rejects concurrent remote dispatch without queueing; revocation bypasses busy state; tool list respects declared scope');
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-mcp-test-')) throw new Error('Unsafe MCP test cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
