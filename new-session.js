'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { utils } = require('ssh2');
const c = require('./lib/common');
const policy = require('./lib/authorization');
const { copyTargetDependencies } = require('./lib/target-runtime');

function makeKey(file) {
  let pair;
  // Validate serialization before persistence; some generated OpenSSH keys
  // have failed round-trip parsing in the pinned dependency/runtime pairing.
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = utils.generateKeyPairSync('ed25519');
    try {
      if (c.same(c.key(candidate.private).getPublicSSH(), c.key(candidate.public).getPublicSSH())) { pair = candidate; break; }
    } catch {}
  }
  if (!pair) throw new Error('Could not generate a parseable matching SSH key pair');
  fs.writeFileSync(file, pair.private, { mode: 0o600 });
  fs.writeFileSync(file + '.pub', pair.public + '\n', { mode: 0o600 });
  return pair.public;
}
function initState(root) {
  root = path.resolve(root);
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  if (!fs.existsSync(path.join(root, 'receiver_host_key'))) makeKey(path.join(root, 'receiver_host_key'));
  return root;
}
function newSession(options) {
  const authorization = policy.authorization(options.scope);
  const operatorLabel = policy.operatorLabel(options.operator);
  const root = initState(options.state);
  const id = options.id ? c.sessionId(options.id) : crypto.randomBytes(8).toString('hex');
  const reversePort = c.port(options['reverse-port'] || 23022);
  const targetSshPort = c.port(options['target-port'] || 22022);
  const hours = Number(options.hours || 4);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Lifetime must be >0 and <=24 hours');
  const transport = options.transport || 'websocket';
  const endpoint = options.endpoint;
  let receiverHost, receiverPort;
  if (transport === 'websocket') {
    const url = new URL(endpoint);
    if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Endpoint must be an HTTPS/WSS origin without credentials, path, query or fragment');
    if (['http:', 'ws:'].includes(url.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Public endpoints require HTTPS/WSS');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = '/tunnel/' + id;
    options.endpoint = url.toString();
  } else if (transport === 'tcp') {
    receiverHost = options.host;
    if (typeof receiverHost !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(receiverHost) || receiverHost.startsWith('-')) throw new Error('Invalid receiver host');
    receiverPort = c.port(options.port || 22222);
  } else throw new Error('Transport must be websocket or tcp');
  const bundle = path.resolve(options.bundle);
  if (fs.existsSync(bundle)) throw new Error('Target staging directory already exists');
  const node = path.resolve(options.node || process.execPath);
  if (!fs.existsSync(node)) throw new Error('Node runtime not found');
  // Prevent accidentally assigning a second live session the same reverse port.
  for (const item of fs.readdirSync(path.join(root, 'sessions'))) {
    if (!/^[a-f0-9]{16}$/.test(item)) continue;
    const existing = c.readSession(root, item).value;
    if (c.active(existing) && existing.reversePort === reversePort) throw new Error('Reverse port belongs to another active session');
  }
  const dir = path.join(root, 'sessions', id);
  if (fs.existsSync(dir)) throw new Error('Session already exists');
  fs.mkdirSync(dir);
  const controlPublicKey = makeKey(path.join(dir, 'control_key'));
  makeKey(path.join(dir, 'tunnel_key'));
  const receiverHostKey = fs.readFileSync(path.join(root, 'receiver_host_key.pub'), 'utf8').trim();
  const config = { version: 1, id, transport, endpoint: options.endpoint,
    operatorLabel, authorization,
    receiverHost, receiverPort, reversePort, targetSshPort,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + hours * 3600000).toISOString(),
    webToken: crypto.randomBytes(32).toString('base64url'), receiverHostKey, controlPublicKey, revoked: false };
  // Persist before copying inputs so the PowerShell wrapper can revoke a
  // failed partial package, and later session enumeration stays readable.
  c.writeJson(path.join(dir, 'session.json'), config);
  fs.mkdirSync(bundle, { recursive: true });
  for (const name of ['Bootstrap.ps1', 'Run-Support.ps1', 'Stop-Support.ps1', 'Show-SessionInfo.ps1', 'Manage-Capability.ps1', 'Capability.Core.ps1', 'TARGET-README.txt', 'Diagnose-Support.ps1', 'Read-SupportLog.ps1', 'Read-SupportJson.ps1', 'Read-SupportSsh.ps1', 'RETRY.cmd']) fs.copyFileSync(path.join(__dirname, 'target', name), path.join(bundle, name));
  if (options.openssh) {
    const source = path.resolve(options.openssh);
    const manifest = path.join(source, 'manifest.json');
    if (!fs.existsSync(manifest) || !fs.existsSync(path.join(source, 'sshd.exe'))) throw new Error('Portable SSH directory must include its manifest and daemon');
    fs.cpSync(source, path.join(bundle, 'openssh'), { recursive: true });
    config.portableSshManifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
  }
  c.writeJson(path.join(dir, 'session.json'), config);
  fs.cpSync(path.join(__dirname, 'target', 'capabilities'), path.join(bundle, 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'target')); fs.copyFileSync(path.join(__dirname, 'target', 'tunnel.js'), path.join(bundle, 'target', 'tunnel.js'));
  fs.mkdirSync(path.join(bundle, 'lib'));
  fs.copyFileSync(path.join(__dirname, 'lib', 'common.js'), path.join(bundle, 'lib', 'common.js'));
  fs.copyFileSync(path.join(__dirname, 'lib', 'stream-pair.js'), path.join(bundle, 'lib', 'stream-pair.js'));
  copyTargetDependencies(__dirname, path.join(bundle, 'node_modules'));
  fs.cpSync(path.join(__dirname, 'licenses'), path.join(bundle, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(bundle, 'LICENSE'));
  fs.mkdirSync(path.join(bundle, 'runtime'));
  fs.copyFileSync(node, path.join(bundle, 'runtime', 'node.exe'));
  config.runtimeSha256 = crypto.createHash('sha256').update(fs.readFileSync(node)).digest('hex');
  c.writeJson(path.join(bundle, 'session.json'), config);
  fs.copyFileSync(path.join(dir, 'tunnel_key'), path.join(bundle, 'tunnel_key'));
  fs.writeFileSync(path.join(bundle, 'START.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Bootstrap.ps1"\r\npause\r\n');
  return { id, controllerSession: dir, targetDirectory: bundle, expiresAt: config.expiresAt, reversePort, transport, endpoint: config.endpoint, operatorLabel, authorization };
}
if (require.main === module) {
  const a = c.args();
  try { if (a._[0] === 'init') console.log(JSON.stringify({ stateRoot: initState(a.state) }));
    else console.log(JSON.stringify(newSession(a), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { initState, newSession, makeKey };
