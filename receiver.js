'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { Server } = require('ssh2');
const { WebSocketServer, createWebSocketStream } = require('ws');
const c = require('./lib/common');
const { pairSocketChannel } = require('./lib/stream-pair');

async function startReceiver(options) {
  const stateRoot = path.resolve(options.stateRoot);
  const hostKey = fs.readFileSync(path.join(stateRoot, 'receiver_host_key'));
  const peers = new Set();
  const upgrades = new Set();
  const sockets = new Set();
  const listeners = new Map();
  const ssh = new Server({ hostKeys: [hostKey], readyTimeout: 15000 }, (peer) => {
    peers.add(peer);
    let session, expiry, closed = false;
    let authFailures = 0;
    const owned = new Set();
    peer.on('error', () => {});
    peer.on('authentication', (ctx) => {
      try {
        const current = c.readSession(stateRoot, ctx.username);
        if (!c.active(current.value) || ctx.method !== 'publickey') throw new Error('Unauthorized');
        const allowed = c.key(fs.readFileSync(path.join(current.dir, 'tunnel_key.pub')));
        if (ctx.key.algo !== allowed.type || !c.same(ctx.key.data, allowed.getPublicSSH()) ||
            (ctx.signature && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)) throw new Error('Unauthorized');
        session = current; ctx.accept();
      } catch {
        ctx.reject(['publickey']); if (++authFailures >= 3) peer.end();
      }
    });
    const valid = () => !closed && session && c.active(c.readSession(stateRoot, session.value.id).value);
    peer.on('ready', () => c.log('target_authenticated', { id: session.value.id }));
    // No shell, SFTP, direct forwarding, PTY, or agent forwarding on the controller.
    peer.on('tcpip', (_accept, reject) => reject());
    peer.on('session', (accept, reject) => {
      try { if (!valid()) return reject(); } catch { return reject(); }
      const channel = accept();
      channel.on('pty', (_accept, reject) => reject());
      channel.on('shell', (_accept, reject) => reject());
      channel.on('subsystem', (_accept, reject) => reject());
      channel.on('exec', (accept, reject, info) => {
        // This is metadata registration, never execution of a supplied command.
        if (!/^register [A-Za-z0-9+/=]{1,12000}$/.test(info.command)) return reject();
        let stream;
        try {
          if (!valid()) return reject();
          const data = JSON.parse(Buffer.from(info.command.slice(9), 'base64').toString('utf8'));
          if (typeof data.user !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(data.user)) throw new Error('Unsupported Windows local user name');
          if (typeof data.hostKey !== 'string' || data.hostKey.length > 2048 || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(data.hostKey.trim())) throw new Error('Invalid host key');
          const parsed = c.key(data.hostKey.trim());
          const receiptPath = path.join(session.dir, 'receipt.json');
          const receipt = {
            id: session.value.id, user: data.user.toLowerCase(),
            computer: String(data.computer || '').replace(/[\x00-\x1f]/g, '').slice(0, 128),
            hostKey: data.hostKey.trim(), fingerprint: c.fingerprint(parsed.getPublicSSH()),
            registeredAt: new Date().toISOString()
          };
          if (fs.existsSync(receiptPath)) {
            const previous = c.readJson(receiptPath);
            if (previous.user !== receipt.user || previous.hostKey !== receipt.hostKey) throw new Error('Previously registered target identity changed');
          } else c.writeJson(receiptPath, receipt);
          stream = accept(); stream.write('REGISTERED\n'); stream.exit(0); stream.end();
          c.log('target_registered', { id: receipt.id, computer: receipt.computer, fingerprint: receipt.fingerprint });
        } catch (error) {
          stream ||= accept(); stream.stderr.write(error.message + '\n'); stream.exit(1); stream.end();
        }
      });
    });
    peer.on('request', (accept, reject, name, info) => {
      try {
        if (!valid() || name !== 'tcpip-forward' || info.bindAddr !== '127.0.0.1' || info.bindPort !== session.value.reversePort || !fs.existsSync(path.join(session.dir, 'receipt.json')) || listeners.has(info.bindPort)) return reject?.();
        const listener = net.createServer({ allowHalfOpen: true }, (socket) => {
          if (closed) { socket.destroy(); return; }
          owned.add(socket);
          socket.on('error', () => {});
          socket.on('close', () => owned.delete(socket));
          peer.forwardOut('127.0.0.1', info.bindPort, socket.remoteAddress, socket.remotePort, (error, channel) => {
            if (error) return socket.destroy();
            channel.on('error', () => socket.destroy());
            if (closed || socket.destroyed) { channel.destroy(); socket.destroy(); return; }
            owned.add(channel); channel.on('close', () => owned.delete(channel));
            pairSocketChannel(socket, channel);
          });
        });
        listener.once('error', () => { listener.close(); if (!closed) reject?.(); });
        listener.listen(info.bindPort, '127.0.0.1', () => {
          if (closed) { listener.close(); return; }
          listeners.set(info.bindPort, { listener, peer }); accept?.();
          c.log('reverse_listener_ready', { id: session.value.id, address: '127.0.0.1', port: info.bindPort });
        });
      } catch { reject?.(); }
    });
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(expiry);
      peers.delete(peer);
      for (const socket of owned) socket.destroy(); owned.clear();
      for (const [number, item] of listeners) if (item.peer === peer) { item.listener.close(); listeners.delete(number); }
    };
    peer.on('close', cleanup);
    peer.on('end', cleanup);
    expiry = setInterval(() => {
      try { if (session && !valid()) { cleanup(); peer.end(); } }
      catch { cleanup(); peer.end(); }
    }, 1000);
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const web = http.createServer((req, res) => {
    // Public health response contains no identifiers or target information.
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(req.url === '/health' ? 'temporary-support\n' : 'not found\n');
  });
  web.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  web.on('upgrade', (req, socket, head) => {
    try {
      const match = /^\/tunnel\/([a-f0-9]{16})$/.exec(req.url);
      if (!match || req.headers.origin) throw new Error('Unauthorized');
      const current = c.readSession(stateRoot, match[1]);
      if (!c.active(current.value) || !c.same(req.headers.authorization || '', 'Bearer ' + current.value.webToken)) throw new Error('Unauthorized');
      // Bound unauthenticated/incomplete connections as well as active peers.
      if (upgrades.size >= 16) throw new Error('Capacity');
      ws.handleUpgrade(req, socket, head, (connection) => {
        upgrades.add(connection); connection.on('close', () => upgrades.delete(connection));
        connection.on('error', () => {});
        const stream = createWebSocketStream(connection);
        stream.remoteAddress = socket.remoteAddress; stream.remotePort = socket.remotePort;
        stream.remoteFamily = socket.remoteFamily; stream.on('error', () => {});
        // ws can end only its readable side on close. Once its buffered SSH
        // messages are consumed, destroy it so ssh2 also releases the peer.
        stream.once('end', () => stream.destroy());
        ssh.injectSocket(stream);
      });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { web.once('error', reject); web.listen(Number(options.httpPort ?? 20246), options.httpBind || '127.0.0.1', resolve); });
  let directPort = null;
  if (options.directPort) await new Promise((resolve, reject) => { ssh.once('error', reject); ssh.listen(Number(options.directPort), options.directBind || '::', () => { directPort = ssh.address().port; resolve(); }); });
  const addresses = { httpPort: web.address().port, directPort };
  c.log('receiver_ready', addresses);
  return {
    addresses,
    async close() {
      for (const peer of peers) peer.end();
      for (const item of listeners.values()) item.listener.close(); listeners.clear();
      for (const connection of upgrades) connection.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => web.close(resolve)); ws.close();
      if (directPort) await new Promise((resolve) => ssh.close(resolve));
    }
  };
}
if (require.main === module) {
  const a = c.args();
  startReceiver({ stateRoot: a.state, httpPort: a['http-port'], directPort: a['direct-port'], directBind: a['direct-bind'], httpBind: '127.0.0.1' })
    .then((receiver) => {
      let closing = false;
      const stop = () => { if (closing) return; closing = true; receiver.close().then(() => process.exit(0)); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    }).catch((error) => { console.error(error.message); process.exit(1); });
}
module.exports = { startReceiver };
