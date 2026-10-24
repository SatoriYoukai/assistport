'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { executeScript } = require('./remote-exec');
const c = require('./common');
const { failure } = require('./errors');

async function operateCapability(conn, config, options, state) {
  if (options.capability !== 'screenshot') throw new Error('Only the built-in screenshot capability is implemented');
  if (!['ensure', 'inspect', 'capture', 'stop', 'cleanup'].includes(options.operation)) throw new Error('Capability operation must be ensure, inspect, capture, stop, or cleanup');
  c.sessionId(config.id);
  if (!config.authorization?.capabilities?.includes('screenshot')) throw failure('OUT_OF_SCOPE', 'Screenshot is outside the declared session scope');
  const script = `& (Join-Path $env:ProgramData 'CodexTemporarySupport\\${config.id}\\Manage-Capability.ps1') -SessionId '${config.id}' -Operation '${options.operation}' -Capability screenshot`;
  const result = await executeScript(conn, script, state);
  if (result.exitCode !== 0) throw failure('CAPABILITY_FAILED', result.stderr.trim() || 'Capability operation failed', { completion: 'unknown' });
  let value;
  try { value = JSON.parse(result.stdout.trim()); } catch { throw failure('INVALID_REMOTE_RESULT', 'Capability returned invalid JSON', { completion: 'unknown' }); }
  if (!value || typeof value !== 'object' || (['capture', 'ensure'].includes(options.operation) && (value.sessionId !== config.id || value.capability !== 'screenshot' || value.state !== 'ready' || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width <= 0 || value.height <= 0 || value.width * value.height > 64000000))) throw failure('INVALID_REMOTE_RESULT', 'Invalid screenshot verification result', { completion: 'unknown' });
  if (options.local && ['capture', 'ensure'].includes(options.operation)) {
    // ProgramData can be relocated: bind the returned path to its session and
    // fixed capability suffix, rather than assuming it is always on C:.
    const suffix = `/CodexTemporarySupport/${config.id}/capability-state/screenshot/captures/`;
    const remote = String(value.file || '').replace(/\\/g, '/');
    if (!/^[A-Za-z]:\//.test(remote) || /[\x00-\x1f]/.test(remote) || remote.split('/').some((part) => part === '.' || part === '..') || !remote.includes(suffix) || !/^[a-f0-9]{32}\.png$/.test(remote.slice(remote.lastIndexOf('/') + 1))) throw new Error('Unexpected capture path');
    if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Missing screenshot integrity hash');
    const local = path.resolve(options.local);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const temporary = local + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      await new Promise((resolve, reject) => conn.sftp((error, sftp) => {
        if (error) return reject(error);
        sftp.fastGet(remote, temporary, (error) => { sftp.end(); error ? reject(error) : resolve(); });
      }));
      if (fs.statSync(temporary).size > 256 * 1024 * 1024) throw new Error('Screenshot exceeded the 256 MiB artifact limit');
      if (crypto.createHash('sha256').update(fs.readFileSync(temporary)).digest('hex') !== value.sha256) throw failure('INTEGRITY_MISMATCH', 'Downloaded screenshot hash mismatch');
      fs.renameSync(temporary, local);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { ...value, local };
  }
  return value;
}
module.exports = { operateCapability };
