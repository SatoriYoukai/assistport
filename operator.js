'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');
const c = require('./lib/common');
const { executeScript } = require('./lib/remote-exec');
const { operateCapability } = require('./lib/capabilities');
const { toolOperation } = require('./lib/tool-registry');
const { SupportError, failure } = require('./lib/errors');

function validate(options) {
  if (!options || typeof options.session !== 'string' || !options.session.trim()) throw failure('INVALID_ARGUMENT', 'A controller session directory is required');
  if (!['status', 'probe', 'exec', 'upload', 'download', 'revoke', 'capability', 'tool'].includes(options.action)) throw failure('INVALID_ARGUMENT', 'Action must be status, probe, exec, upload, download, revoke, capability, or tool');
  const timeout = Number(options.timeout ?? 120);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw failure('INVALID_ARGUMENT', 'Timeout must be 1..3600 seconds');
  const validPath = (value) => typeof value === 'string' && value.trim() && !/[\x00-\x1f]/.test(value);
  if (options.action === 'exec') {
    if (Boolean(options.command) === Boolean(options.file) || (options.command && (typeof options.command !== 'string' || !options.command.trim())) || (options.file && !validPath(options.file))) throw failure('INVALID_ARGUMENT', 'Specify exactly one nonempty command or UTF-8 script file');
    if (options.command && Buffer.byteLength(options.command, 'utf8') > 8 * 1024 * 1024) throw failure('INVALID_ARGUMENT', 'Script exceeds 8 MiB');
  }
  if (['upload', 'download'].includes(options.action) && (!validPath(options.local) || !validPath(options.remote))) throw failure('INVALID_ARGUMENT', 'Valid --local and --remote paths are required');
  if (options.action === 'capability' && (options.capability !== 'screenshot' || !['ensure', 'inspect', 'capture', 'stop', 'cleanup'].includes(options.operation) || (options.local !== undefined && (!validPath(options.local) || !['ensure', 'capture'].includes(options.operation))))) throw failure('INVALID_ARGUMENT', 'Only screenshot ensure, inspect, capture, stop or cleanup is supported; local output requires ensure/capture');
  if (options.action === 'tool' && (!['inspect', 'register'].includes(options.operation) || (options.operation === 'register' && !validPath(options.file)))) throw failure('INVALID_ARGUMENT', 'Tool operation must be inspect or register with a manifest file');
  return timeout;
}
function readController(root) {
  try {
    const config = c.readJson(path.join(root, 'session.json'));
    c.sessionId(config.id); c.port(config.reversePort);
    if (!Number.isFinite(Date.parse(config.expiresAt))) throw new Error('Invalid expiry');
    return config;
  } catch { throw failure('SESSION_UNAVAILABLE', 'Controller session is missing or invalid'); }
}
function requireActive(config) {
  if (config.revoked === true) throw failure('SESSION_REVOKED', 'Session expired or revoked (revoked)');
  if (!c.active(config)) throw failure('SESSION_EXPIRED', 'Session expired or revoked (expired)');
}

async function operate(options, state = {}) {
  const timeout = validate(options);
  state.completion = 'not_started';
  if (options.signal?.aborted) throw failure('OPERATION_CANCELLED', 'Operation cancelled before dispatch');
  const root = path.resolve(options.session);
  const configPath = path.join(root, 'session.json');
  const config = readController(root);
  state.sessionId = options.expectedSessionId || config.id;
  if (options.expectedSessionId && config.id !== options.expectedSessionId) throw failure('IDENTITY_MISMATCH', 'Controller session identity changed after MCP startup');
  const action = options.action;
  if (action === 'tool') {
    requireActive(config);
    try { return toolOperation(root, config, options); }
    catch (error) { throw failure('TOOL_REGISTRY_ERROR', error.message); }
  }
  if (action === 'revoke') {
    if (!config.revoked) {
      config.revoked = true; config.revokedAt = new Date().toISOString();
      try { c.writeJson(configPath, config); } catch { throw failure('LOCAL_IO_ERROR', 'Could not persist session revocation'); }
    }
    return { id: config.id, revoked: true, note: 'Receiver disconnects within one second; target-side uninstall uses Stop-Support.ps1.' };
  }
  const receiptFile = path.join(root, 'receipt.json');
  if (action === 'status') {
    let target;
    if (fs.existsSync(receiptFile)) {
      try { target = c.readJson(receiptFile); if (target.id !== config.id) throw new Error('Identity'); }
      catch { throw failure('IDENTITY_MISMATCH', 'Receipt is invalid or belongs to another session'); }
      target = { id: target.id, user: target.user, computer: target.computer, hostKey: target.hostKey, registeredAt: target.registeredAt };
    }
    return { id: config.id, active: c.active(config), expiresAt: config.expiresAt, operatorLabel: config.operatorLabel || null, authorization: config.authorization || { profile: 'legacy-unspecified', enforcement: 'none' }, registered: Boolean(target), connectivity: 'unknown', note: 'Registration is historical; use probe to verify an authenticated command now.', ...(target ? { target } : {}) };
  }
  if (action === 'probe') {
    const checkedAt = new Date().toISOString();
    if (!c.active(config)) return { id: config.id, connected: false, checkedAt, reason: 'expired_or_revoked' };
    if (!fs.existsSync(receiptFile)) return { id: config.id, connected: false, checkedAt, reason: 'not_registered' };
    const nonce = require('node:crypto').randomBytes(16).toString('hex');
    try {
      const result = await operate({ session: root, action: 'exec', command: `Write-Output '${nonce}'`, timeout: options.timeout ?? 10, signal: options.signal, expectedSessionId: options.expectedSessionId }, state);
      const connected = result.exitCode === 0 && result.stdout.trim() === nonce;
      return { id: config.id, connected, checkedAt, reason: connected ? 'authenticated_command_completed' : 'unexpected_command_result' };
    } catch (error) {
      return { id: config.id, connected: false, checkedAt, reason: 'connection_or_command_failed', failure: { code: error.code || 'OPERATION_FAILED', message: error.message, completion: error.completion || state.completion } };
    }
  }
  requireActive(config);
  const needed = { exec: 'command', upload: 'files', download: 'files', capability: 'screenshot' }[action];
  if (!config.authorization?.capabilities?.includes(needed)) throw failure('OUT_OF_SCOPE', 'Operation is outside the declared session scope');
  if (!fs.existsSync(receiptFile)) throw failure('NOT_REGISTERED', 'Target has not registered a host identity');
  let receipt, expected, privateKey, script;
  try {
    receipt = c.readJson(receiptFile);
    if (receipt.id !== config.id || typeof receipt.user !== 'string' || !receipt.user) throw new Error('Receipt mismatch');
    expected = c.key(receipt.hostKey).getPublicSSH();
  } catch { throw failure('IDENTITY_MISMATCH', 'Receipt mismatch or invalid target host key'); }
  try {
    privateKey = fs.readFileSync(path.join(root, 'control_key'));
    if (action === 'exec') {
      if (options.file && (!fs.statSync(path.resolve(options.file)).isFile() || fs.statSync(path.resolve(options.file)).size > 8 * 1024 * 1024)) throw failure('INVALID_ARGUMENT', 'Script input must be a file of at most 8 MiB');
      script = options.file ? fs.readFileSync(path.resolve(options.file), 'utf8').replace(/^\uFEFF/, '') : options.command;
      if (!script.trim() || Buffer.byteLength(script, 'utf8') > 8 * 1024 * 1024) throw failure('INVALID_ARGUMENT', 'Script must be nonempty and at most 8 MiB');
    }
    if (action === 'upload' && !fs.statSync(path.resolve(options.local)).isFile()) throw failure('INVALID_ARGUMENT', 'Upload source must be a file');
  } catch (error) { if (error instanceof SupportError) throw error; throw failure('LOCAL_IO_ERROR', 'Could not read local operation input or controller key'); }
  const conn = new Client();
  conn.on('error', () => {});
  let timer, cancel, hostRejected = false;
  const failurePromise = new Promise((_resolve, reject) => { timer = setTimeout(() => {
    const completion = state.completion;
    const error = failure('OPERATION_TIMEOUT', completion === 'not_started' ? 'Operation timed out before remote dispatch.' : 'Operation timed out; remote process completion is unknown.' + (state.stagingPath ? ' Staged script cleanup is unconfirmed: ' + state.stagingPath : ''), { completion, stagingPath: state.stagingPath });
    state.cancelled = true;
    reject(error); conn.destroy();
  }, timeout * 1000); });
  const cancellation = new Promise((_resolve, reject) => {
    cancel = () => { state.cancelled = true; reject(failure('OPERATION_CANCELLED', 'Operation cancelled; cancellation does not terminate a dispatched remote process.', { completion: state.completion })); conn.destroy(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
  const task = (async () => {
    if (state.cancelled) throw failure('OPERATION_CANCELLED', 'Operation cancelled before connection');
    await new Promise((resolve, reject) => {
      conn.once('ready', resolve); conn.once('error', reject);
      conn.connect({ host: '127.0.0.1', port: config.reversePort, username: receipt.user, privateKey,
        hostVerifier: (raw) => { const valid = c.same(raw, expected); if (!valid) hostRejected = true; return valid; },
        readyTimeout: Math.min(15000, timeout * 1000), keepaliveInterval: 15000, keepaliveCountMax: 3 });
    }).catch((error) => { conn.destroy(); throw failure(hostRejected ? 'IDENTITY_MISMATCH' : 'CONNECTION_FAILED', hostRejected ? 'Target host key does not match the pinned identity' : 'SSH connection or authentication failed: ' + error.message); });
    if (state.cancelled) throw failure('OPERATION_TIMEOUT', 'Operation deadline passed before dispatch');
    const current = readController(root);
    if (current.id !== config.id) throw failure('IDENTITY_MISMATCH', 'Controller session identity changed during connection');
    requireActive(current);
    if (action === 'exec') return executeScript(conn, script, state);
    if (action === 'capability') return operateCapability(conn, config, options, state);
    const local = path.resolve(options.local); const remote = options.remote.replace(/\\/g, '/');
    if (action === 'download') fs.mkdirSync(path.dirname(local), { recursive: true });
    return new Promise((resolve, reject) => conn.sftp((error, sftp) => {
      if (error) return reject(failure('TRANSFER_FAILED', error.message));
      state.completion = 'unknown';
      const done = (error) => { sftp.end(); if (error) reject(failure('TRANSFER_FAILED', error.message)); else { state.completion = 'completed'; resolve({ action, local, remote }); } };
      if (action === 'upload') sftp.fastPut(local, remote, done); else sftp.fastGet(remote, local, done);
    }));
  })();
  try { return await Promise.race([task, failurePromise, cancellation]); }
  catch (error) {
    if (!(error instanceof SupportError)) error = failure('OPERATION_FAILED', error.message);
    error.completion ??= state.completion;
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); conn.end(); }
}
module.exports = { operate, validate, readController };
if (require.main === module) {
  const { invoke } = require('./lib/operation');
  (async () => {
    let options;
    try {
      const a = c.args();
      if (a._.length !== 1 || Object.keys(a).some((key) => !['_', 'session', 'command', 'file', 'local', 'remote', 'capability', 'operation', 'timeout'].includes(key))) throw failure('INVALID_ARGUMENT', 'Unexpected action or option');
      options = { ...a, action: a._[0] };
    }
    catch (error) {
      const result = await invoke({}, () => { throw failure('INVALID_ARGUMENT', error.message); });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = 1; return;
    }
    const result = await invoke(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
  })().catch(() => { process.stderr.write('Could not write the operation result.\n'); process.exitCode = 1; });
}
