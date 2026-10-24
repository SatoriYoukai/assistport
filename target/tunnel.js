'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { Client } = require('ssh2');
const { WebSocket, createWebSocketStream } = require('ws');
const c = require('../lib/common');
const { pairSocketChannel } = require('../lib/stream-pair');

async function connectTunnel(config, root) {
  if (!c.active(config)) throw new Error('Session expired or revoked');
  const conn = new Client();
  const expected = c.key(config.receiverHostKey).getPublicSSH();
  // Read local inputs before opening a transport, so a missing file cannot leak it.
  const privateKey = fs.readFileSync(path.join(root, 'tunnel_key'));
  const registration = { user: config.targetUser, computer: config.computer || '', hostKey: fs.readFileSync(path.join(root, 'target_host_key.pub'), 'utf8').trim() };
  const forwarded = new Set();
  let sock, rejectPending, failure, finished = false, resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = (error = new Error('Tunnel connection closed')) => {
    if (finished) return;
    finished = true; failure = error;
    rejectPending?.(error);
    for (const stream of forwarded) stream.destroy();
    forwarded.clear();
    conn.destroy();
    // A ws Duplex may emit end without close while its writable side remains
    // open. ssh2 then stops keepalives, so waiting only for close never retries.
    sock?.destroy();
    resolveDone();
  };
  conn.on('error', (error) => { c.log('tunnel_error', { message: error.message }); finish(error); });
  conn.once('end', () => finish(new Error('Tunnel connection ended')));
  conn.once('close', () => finish());
  conn.on('tcp connection', (info, accept, reject) => {
    if (finished || info.destIP !== '127.0.0.1' || info.destPort !== config.reversePort) return reject();
    const local = net.connect({ port: config.targetSshPort, host: '127.0.0.1', allowHalfOpen: true });
    let channel, decided = false;
    const rejectOnce = () => { if (!decided) { decided = true; reject(); } };
    forwarded.add(local);
    local.on('close', () => { forwarded.delete(local); rejectOnce(); });
    local.on('error', () => { rejectOnce(); local.destroy(); channel?.destroy(); });
    local.once('connect', () => {
      if (finished || decided) { rejectOnce(); local.destroy(); return; }
      decided = true; channel = accept(); forwarded.add(channel);
      channel.on('close', () => forwarded.delete(channel));
      pairSocketChannel(local, channel);
    });
  });
  try {
    if (config.transport === 'websocket') {
      const url = new URL(config.endpoint);
      if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid WebSocket endpoint');
      if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Public WebSocket connections require TLS');
      const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + config.webToken }, handshakeTimeout: 15000, perMessageDeflate: false });
      // Attach the stream BEFORE open: the SSH banner may share the upgrade packet.
      sock = createWebSocketStream(ws);
      sock.on('error', (error) => finish(error));
      sock.once('end', () => finish(new Error('Tunnel transport ended')));
      sock.once('close', () => finish());
      await new Promise((resolve, reject) => {
        rejectPending = reject;
        ws.once('open', resolve);
        ws.on('error', (error) => finish(error));
        ws.once('close', () => finish(new Error('WebSocket connection closed')));
      });
      rejectPending = undefined;
      if (finished || ws.readyState !== WebSocket.OPEN) throw failure || new Error('WebSocket connection closed');
    }
    await new Promise((resolve, reject) => {
      rejectPending = reject;
      if (finished) return reject(failure);
      conn.once('ready', () => {
        if (finished) return;
        conn.exec('register ' + Buffer.from(JSON.stringify(registration)).toString('base64'), (error, stream) => {
          if (finished) { stream?.destroy(); return; }
          if (error) return reject(error);
          let message = ''; let code;
          stream.on('error', reject);
          stream.stderr.on('data', (chunk) => { message += chunk.toString(); });
          stream.on('exit', (n) => { code = n; });
          stream.on('close', () => {
            if (finished) return;
            if (code !== 0) return reject(new Error(message || 'Target registration failed'));
            conn.forwardIn('127.0.0.1', config.reversePort, (error) => {
              if (finished) return;
              if (error) reject(error); else resolve();
            });
          });
          stream.resume();
        });
      });
      conn.connect({
        ...(sock ? { sock } : { host: config.receiverHost, port: config.receiverPort }),
        username: config.id, privateKey,
        hostVerifier: (raw) => c.same(raw, expected), readyTimeout: 15000,
        keepaliveInterval: 15000, keepaliveCountMax: 3
      });
    });
    rejectPending = undefined;
    if (finished) throw failure;
  } catch (error) { finish(error); throw error; }
  c.log('tunnel_ready', { id: config.id, reversePort: config.reversePort });
  return { done, close: () => finish(), client: conn };
}
if (require.main === module) {
  const a = c.args(); const root = path.resolve(a.root); const config = c.readJson(path.join(root, 'session.json'));
  (async () => {
    while (c.active(config) && !fs.existsSync(path.join(root, 'STOP'))) {
      try {
        const link = await connectTunnel(config, root);
        const timer = setInterval(() => { if (!c.active(config) || fs.existsSync(path.join(root, 'STOP'))) link.close(); }, 1000);
        await link.done; clearInterval(timer);
      } catch (error) { c.log('retry', { message: error.message }); }
      if (c.active(config) && !fs.existsSync(path.join(root, 'STOP'))) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    c.log('tunnel_stopped', { id: config.id });
  })().catch((error) => { console.error(error.message); process.exit(1); });
}
module.exports = { connectTunnel };
