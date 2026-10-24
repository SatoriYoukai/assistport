'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { normalizeTool } = require('../lib/tool-registry');
const { operate } = require('../operator');
const c = require('../lib/common');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-tool-test-'));
async function run() {
  const manifest = { id: 'reviewed-helper', version: '1.0.0', source: { url: 'https://example.org/releases/helper.zip', sha256: 'ab'.repeat(32) }, capabilities: ['command'], review: { by: 'Example operator', evidence: 'Reviewed official source and publisher; example fixture only.' }, cleanup: 'Stop owned instances and remove files whose recorded hashes match.' };
  const allowed = ['command', 'files', 'screenshot', 'desktop'];
  assert.equal(normalizeTool(manifest, allowed).id, manifest.id);
  assert.throws(() => normalizeTool({ ...manifest, capabilities: ['microphone'] }, allowed), /exceed/);
  assert.throws(() => normalizeTool({ ...manifest, cleanup: '' }, allowed), /cleanup/);
  assert.throws(() => normalizeTool({ ...manifest, source: { ...manifest.source, sha256: '' } }, allowed), /SHA-256/);
  assert.throws(() => normalizeTool({ ...manifest, source: { ...manifest.source, url: 'https://user:secret@example.org/file' } }, allowed), /credentials/);
  assert.throws(() => normalizeTool({ ...manifest, id: '../escape' }, allowed), /identifier/);
  const config = { id: '0123456789abcdef', reversePort: 23022, expiresAt: new Date(Date.now() + 60000).toISOString(), authorization: { capabilities: allowed } };
  c.writeJson(path.join(root, 'session.json'), config);
  const file = path.join(root, 'manifest.json');c.writeJson(file, manifest);
  const first = await operate({ session: root, action: 'tool', operation: 'register', file });
  assert.equal(first.installed, false);assert.equal(first.verification, 'review-recorded-artifact-not-downloaded');
  assert.deepEqual((await operate({ session: root, action: 'tool', operation: 'register', file })).tool, first.tool);
  assert.equal((await operate({ session: root, action: 'tool', operation: 'inspect' })).tools.length, 1);
  c.writeJson(file, { ...manifest, version: '2.0.0' });
  await assert.rejects(operate({ session: root, action: 'tool', operation: 'register', file }), /registration changed/);
  c.writeJson(path.join(root, 'session.json'), { ...config, revoked: true });
  await assert.rejects(operate({ session: root, action: 'tool', operation: 'inspect' }), /revoked/);
  console.log('PASS external tool provenance registry: required evidence/hash/cleanup, scope, immutable registration and expiry; no download/installation');
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-tool-test-')) throw new Error('Unsafe registry test cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
});
