'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { operateCapability } = require('../lib/capabilities');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-cap-client-test-'));
async function run() {
  const config = { id: '0123456789abcdef', authorization: { capabilities: ['screenshot'] } };
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=', 'base64');
  const output = path.join(root, 'capture.png');
  const response = { sessionId: config.id, capability: 'screenshot', state: 'ready', file: `D:/RelocatedProgramData/CodexTemporarySupport/${config.id}/capability-state/screenshot/captures/${'ab'.repeat(16)}.png`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1 };
  let execs = 0;
  const conn = {
    exec(command, callback) {
      execs++;assert.ok(command.length < 8191);
      const stream = new PassThrough();stream.stderr = new PassThrough();callback(null, stream);
      process.nextTick(() => { stream.write(JSON.stringify(response));stream.emit('exit', 0);stream.destroy(); });
    },
    sftp(callback) { callback(null, { fastGet(remote, local, done) { assert.equal(remote, response.file);fs.writeFileSync(local, bytes);done(); }, end() {} }); }
  };
  const options = { capability: 'screenshot', operation: 'capture', local: output };
  const captured = await operateCapability(conn, config, options, {});
  assert.equal(captured.local, output);assert.deepEqual(fs.readFileSync(output), bytes);
  response.sha256 = '00'.repeat(32);
  await assert.rejects(operateCapability(conn, config, options, {}), /hash mismatch/);
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
  response.file = response.file.replace('/capability-state/', '/../capability-state/');
  await assert.rejects(operateCapability(conn, config, options, {}), /Unexpected capture path/);
  const before = execs;
  await assert.rejects(operateCapability(conn, { ...config, authorization: { capabilities: [] } }, options, {}), /outside/);
  await assert.rejects(operateCapability(conn, config, { ...options, capability: 'other' }, {}), /Only the built-in/);
  assert.equal(execs, before);
  console.log('PASS screenshot client routing, relocated path validation, download hash and preservation on corruption');
}
run().catch((error) => { console.error(error);process.exitCode = 1; }).finally(() => {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-cap-client-test-')) throw new Error('Unsafe client test cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
});
