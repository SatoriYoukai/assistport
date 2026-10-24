'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { invoke } = require('../lib/operation');
const { failure } = require('../lib/errors');
const c = require('../lib/common');
const { authorization } = require('../lib/authorization');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-api-test-'));
  const config = { id: '0123456789abcdef', reversePort: 23022, expiresAt: new Date(Date.now() + 60000).toISOString(), authorization: authorization(), webToken: 'DO_NOT_EXPOSE_SECRET' };
  c.writeJson(path.join(root, 'session.json'), config);
  const call = (options) => invoke({ session: root, ...options });
  try {
    const status = await call({ action: 'status' });
    assert.equal(status.ok, true); assert.equal(status.sessionId, config.id); assert.equal(status.result.registered, false);
    assert.doesNotMatch(JSON.stringify(status), /DO_NOT_EXPOSE_SECRET/);
    assert.match(status.operationId, /^[a-f0-9-]{36}$/); assert.ok(status.durationMs >= 0);
    assert.equal((await call({ action: 'probe' })).error.code, 'PROBE_FAILED');
    assert.equal((await call({ action: 'exec', command: 'Write-Output 1' })).error.code, 'NOT_REGISTERED');
    for (const options of [
      { action: 'invalid' }, { action: 'exec' }, { action: 'exec', command: 'x', file: 'x' },
      { action: 'exec', command: ' ' }, { action: 'exec', command: 4 },
      { action: 'upload', local: 'x', remote: 'bad\npath' }, { action: 'download' },
      { action: 'capability', capability: 'desktop', operation: 'ensure' },
      { action: 'capability', capability: 'screenshot', operation: 'inspect', local: 'x.png' },
      { action: 'tool', operation: 'register' }, { action: 'status', timeout: '0' }
    ]) assert.equal((await call(options)).error.code, 'INVALID_ARGUMENT', JSON.stringify(options));
    c.writeJson(path.join(root, 'session.json'), { ...config, authorization: { capabilities: [] } });
    assert.equal((await call({ action: 'exec', command: 'x' })).error.code, 'OUT_OF_SCOPE');
    c.writeJson(path.join(root, 'session.json'), { ...config, expiresAt: new Date(0).toISOString() });
    assert.equal((await call({ action: 'exec', command: 'x' })).error.code, 'SESSION_EXPIRED');
    c.writeJson(path.join(root, 'session.json'), config);
    const first = await call({ action: 'revoke' }); const second = await call({ action: 'revoke' });
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal((await call({ action: 'exec', command: 'x' })).error.code, 'SESSION_REVOKED');
    assert.equal((await call({ action: 'status' })).result.active, false);
    const nonzero = await invoke({ action: 'exec' }, () => ({ exitCode: 7, stdout: 'before failure', stderr: 'reason' }));
    assert.equal(nonzero.ok, false); assert.equal(nonzero.error.code, 'REMOTE_EXIT'); assert.equal(nonzero.error.completion, 'completed'); assert.equal(nonzero.result.stdout, 'before failure');
    const unknown = await invoke({ action: 'exec' }, () => ({ exitCode: null, stdout: '', stderr: '' }));
    assert.equal(unknown.error.code, 'REMOTE_OUTCOME_UNKNOWN'); assert.equal(unknown.error.completion, 'unknown');
    const timed = await invoke({ action: 'exec' }, (_options, state) => { state.sessionId = config.id; state.completion = 'unknown'; state.stagingPath = 'C:/example/command.ps1'; throw failure('OPERATION_TIMEOUT', 'timeout'); });
    assert.equal(timed.error.completion, 'unknown'); assert.equal(timed.error.cleanup, 'unconfirmed'); assert.equal(timed.sessionId, config.id);
    const cleanup = await invoke({ action: 'capability' }, () => ({ state: 'cleanup-incomplete' }));
    assert.equal(cleanup.error.code, 'CLEANUP_INCOMPLETE'); assert.equal(cleanup.result.state, 'cleanup-incomplete');
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal((await call({ action: 'exec', command: 'x', signal: cancelled.signal })).error.code, 'OPERATION_CANCELLED');
    const cli = spawnSync(process.execPath, [path.join(__dirname, '../operator.js'), 'exec', '--session'], { encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 1); assert.equal(cli.stderr, ''); assert.equal(JSON.parse(cli.stdout).error.code, 'INVALID_ARGUMENT');
    console.log('PASS API envelope, early validation, scope/expiry/revocation, retained remote errors, unknown completion, cancellation and CLI JSON');
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-api-test-')) throw new Error('Unsafe API test cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
