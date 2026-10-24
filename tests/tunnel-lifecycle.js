'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client, Server, utils } = require('ssh2');
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws');
const { connectTunnel } = require('../target/tunnel');
const { startReceiver } = require('../receiver');
const c = require('../lib/common');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, label, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label, ms = 1500) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(label + ' timed out'); await delay(10); }
}
function keyPair() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    try { if (c.same(c.key(pair.private).getPublicSSH(), c.key(pair.public).getPublicSSH())) return pair; } catch {}
  }
  throw new Error('Fixture key generation failed');
}

// All endpoints, keys and peers in this file belong to disposable local fixtures.
async function fixture(mode = 'normal') {
  const hostKey = keyPair();
  const sockets = new Set(), streams = new Set(), peers = new Set(), websockets = [];
  const ssh = new Server({ hostKeys: [hostKey.private] }, (peer) => {
    peers.add(peer); peer.on('error', () => {});
    const ws = peer._sock.fixtureWebSocket;
    peer.on('authentication', (ctx) => {
      if (mode === 'before-ready') ws.close(1000); else ctx.accept();
    });
    peer.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept) => {
        const stream = accept(); stream.on('error', () => {});
        if (mode === 'register') ws.close(1000);
        else { stream.exit(0); stream.end(); }
      });
    });
    peer.on('request', (accept, _reject, name) => {
      if (name !== 'tcpip-forward') return;
      if (mode === 'forward') ws.close(1000);
      else {
        accept();
        if (mode === 'cli-reconnect' && websockets.indexOf(ws) === 0) setTimeout(() => ws.close(1000), 50);
      }
    });
  });
  const web = http.createServer();
  web.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  web.on('upgrade', (req, socket, head) => {
    if (mode === 'before-open') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      websockets.push(ws); ws.on('error', () => {});
      const stream = createWebSocketStream(ws);
      stream.fixtureWebSocket = ws; stream.on('error', () => {}); streams.add(stream);
      ssh.injectSocket(stream);
    });
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `ws://127.0.0.1:${web.address().port}`, hostKey: hostKey.public, websockets,
    get peer() { return [...peers].at(-1); },
    async close() {
      for (const peer of peers) peer._sock.destroy();
      for (const stream of streams) stream.destroy();
      for (const ws of websockets) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => web.close(resolve));
    }
  };
}

async function rawHalfClose(f) {
  const ws = new WebSocket(f.endpoint);
  const sock = createWebSocketStream(ws); sock.on('error', () => {});
  const client = new Client(); client.on('error', () => {});
  let ended = false, closed = false;
  client.on('end', () => { ended = true; }); client.on('close', () => { closed = true; });
  try {
    await bounded(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), 'raw WS open');
    await bounded(new Promise((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject);
      client.connect({ sock, username: 'fixture', keepaliveInterval: 50, keepaliveCountMax: 1 });
    }), 'raw SSH ready');
    f.websockets.at(-1).close(1000);
    await until(() => ended, 'raw SSH end');
    await delay(200);
    assert.equal(closed, false);
    assert.equal(sock.destroyed, false);
    assert.equal(sock.readable, false);
    assert.equal(sock.writable, true);
  } finally { client.destroy(); sock.destroy(); ws.terminate(); }
}

async function bridgeCases(f, config, root) {
  const locals = [];
  const target = net.createServer((socket) => {
    locals.push(socket); socket.on('error', () => {});
    const chunks = []; let length = 0;
    socket.on('data', (data) => {
      if (data.toString() === 'RESET') socket.resetAndDestroy();
      else { chunks.push(data); length += data.length; if (length === 192 * 1024) socket.end(Buffer.concat(chunks)); }
    });
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  let link;
  const forward = () => new Promise((resolve, reject) => f.peer.forwardOut('127.0.0.1', config.reversePort, '127.0.0.1', 40000, (error, channel) => error ? reject(error) : resolve(channel)));
  try {
    link = await bounded(connectTunnel({ ...config, targetSshPort: target.address().port }, root), 'bridge connect');
    const reset = await bounded(forward(), 'reset channel'); reset.on('error', () => {}); reset.resume();
    const resetClosed = new Promise((resolve) => reset.once('close', resolve));
    reset.write('RESET');
    await bounded(resetClosed, 'local reset closes accepted channel');
    const nonce = Buffer.alloc(192 * 1024, 0x37);
    const echo = await bounded(forward(), 'channel after reset'); echo.on('error', () => {});
    const chunks = [];
    echo.on('data', (chunk) => chunks.push(chunk));
    echo.once('end', () => echo.end());
    const echoClosed = new Promise((resolve) => echo.once('close', resolve));
    echo.write(nonce);
    await bounded(echoClosed, 'normal EOF closes channel', 3000);
    assert.deepEqual(Buffer.concat(chunks), nonce);
    const cancelled = await bounded(forward(), 'cancel channel'); cancelled.on('error', () => {}); cancelled.resume();
    await until(() => locals.length === 3, 'cancel target accepted');
    cancelled.destroy();
    await until(() => locals[2].destroyed, 'channel close destroys local socket');
  } finally {
    link?.close(); if (link) await link.done;
    for (const socket of locals) socket.destroy();
    await new Promise((resolve) => target.close(resolve));
  }
}

async function cliReconnect(f, config, root) {
  c.writeJson(path.join(root, 'session.json'), config);
  const child = spawn(process.execPath, [path.join(__dirname, '../target/tunnel.js'), '--root', root], { windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const readyCount = () => stdout.split('\n').filter((line) => { try { return JSON.parse(line).event === 'tunnel_ready'; } catch { return false; } }).length;
  try {
    await until(() => readyCount() >= 2, 'CLI reconnect after graceful WS close', 9000);
    assert.ok(f.websockets.length >= 2);
    assert.equal(stderr, '');
    fs.writeFileSync(path.join(root, 'STOP'), 'fixture stop');
    assert.equal(await bounded(exit, 'CLI stop', 2500), 0);
    assert.equal(stdout.includes('tunnel_stopped'), true);
  } finally { if (child.exitCode === null) { child.kill(); await exit; } }
}

async function availablePort(port = 0) {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => { const bound = server.address().port; server.close(() => resolve(bound)); });
  });
}
async function waitForReleasedPort(port) {
  await bounded((async () => { while (!(await availablePort(port))) await delay(10); })(), 'receiver listener release');
}

async function slowRead(socket, onEnd) {
  const hash = crypto.createHash('sha256'); let bytes = 0, timer;
  socket.pause();
  const closed = new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      bytes += chunk.length; hash.update(chunk); socket.pause();
      timer = setTimeout(() => socket.resume(), 2);
    });
    socket.once('end', () => { onEnd?.(); });
    socket.once('close', () => resolve({ bytes, hash: hash.digest('hex') }));
  });
  timer = setTimeout(() => socket.resume(), 500);
  try { return await bounded(closed, '8MiB slow TCP transfer', 12000); }
  finally { clearTimeout(timer); }
}

async function largePayloadCases(port, payload, uploadResult) {
  const expected = crypto.createHash('sha256').update(payload).digest('hex');
  const download = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  try {
    const result = await slowRead(download, () => download.end());
    assert.deepEqual(result, { bytes: payload.length, hash: expected });
  } finally { download.destroy(); }
  const upload = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  const chunks = []; upload.on('data', (chunk) => chunks.push(chunk));
  try {
    const closed = new Promise((resolve, reject) => { upload.once('close', resolve); upload.once('error', reject); });
    upload.end(payload);
    await bounded(closed, '8MiB slow upload and response after TCP EOF', 12000);
    assert.equal(Buffer.concat(chunks).toString(), 'UPLOAD_OK');
    assert.deepEqual(await uploadResult, { bytes: payload.length, hash: expected });
  } finally { upload.destroy(); }
}

async function receiverCases() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-receiver-lifecycle-'));
  const id = '0123456789abcdef', dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const receiverKey = keyPair(), tunnelKey = keyPair(), targetKey = keyPair();
  fs.writeFileSync(path.join(root, 'receiver_host_key'), receiverKey.private);
  fs.writeFileSync(path.join(dir, 'tunnel_key'), tunnelKey.private);
  fs.writeFileSync(path.join(dir, 'tunnel_key.pub'), tunnelKey.public);
  fs.writeFileSync(path.join(dir, 'target_host_key.pub'), targetKey.public);
  const config = { id, targetUser: 'fixture', transport: 'websocket', webToken: 'local-fixture-only', reversePort: await availablePort(), targetSshPort: 22022,
    receiverHostKey: receiverKey.public, expiresAt: new Date(Date.now() + 30000).toISOString() };
  c.writeJson(path.join(dir, 'session.json'), config);
  const receiver = await startReceiver({ stateRoot: root, httpPort: 0 });
  config.endpoint = `ws://127.0.0.1:${receiver.addresses.httpPort}/tunnel/${id}`;
  const ws = new WebSocket(config.endpoint, { headers: { Authorization: 'Bearer ' + config.webToken } });
  const sock = createWebSocketStream(ws); sock.on('error', () => {});
  const client = new Client(); client.on('error', () => {});
  const payload = crypto.randomBytes(8 * 1024 * 1024), locals = [];
  let sequence = 0, resolveUpload, rejectUpload;
  const uploadResult = new Promise((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; });
  const target = net.createServer({ allowHalfOpen: true }, (socket) => {
    locals.push(socket); socket.on('error', () => {});
    if (++sequence === 1) socket.end(payload);
    else {
      // The reader delays every chunk and only responds after incoming EOF.
      // This exceeds ssh2's 2MiB window and exercises both forwarding bridges.
      const hash = crypto.createHash('sha256'); let bytes = 0, timer;
      socket.pause();
      socket.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); socket.pause(); timer = setTimeout(() => socket.resume(), 2); });
      socket.once('end', () => { clearTimeout(timer); resolveUpload({ bytes, hash: hash.digest('hex') }); socket.end('UPLOAD_OK'); });
      socket.once('error', rejectUpload);
      socket.once('close', () => clearTimeout(timer));
      timer = setTimeout(() => socket.resume(), 500);
    }
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  config.targetSshPort = target.address().port;
  let link;
  try {
    await bounded(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), 'receiver WS open');
    await bounded(new Promise((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject);
      client.connect({ sock, username: id, privateKey: tunnelKey.private, hostVerifier: (key) => c.same(key, c.key(receiverKey.public).getPublicSSH()), readyTimeout: 1000 });
    }), 'receiver SSH ready');
    await bounded(new Promise((resolve, reject) => {
      const registration = { user: 'fixture', computer: 'fixture', hostKey: targetKey.public };
      client.exec('register ' + Buffer.from(JSON.stringify(registration)).toString('base64'), (error, stream) => {
        if (error) return reject(error);
        let code; stream.on('error', reject); stream.on('exit', (value) => { code = value; });
        stream.on('close', () => code === 0 ? resolve() : reject(new Error('Fixture registration failed'))); stream.resume();
      });
    }), 'receiver registration');
    await bounded(new Promise((resolve, reject) => client.forwardIn('127.0.0.1', config.reversePort, (error) => error ? reject(error) : resolve())), 'receiver forward');
    assert.equal(await availablePort(config.reversePort), false);
    const wsClosed = new Promise((resolve) => ws.once('close', resolve));
    ws.close(1000);
    await bounded(wsClosed, 'receiver graceful WS close');
    await waitForReleasedPort(config.reversePort);
    // This raw client intentionally has no tunnel.js finish handler. Its WS
    // read end must still make the real receiver free its own peer and timer.
    link = await bounded(connectTunnel(config, dir), 'real receiver reconnect');
    assert.equal(await availablePort(config.reversePort), false);
    await largePayloadCases(config.reversePort, payload, uploadResult);
    // Drop the outer transport with another transfer still under backpressure.
    // Cleanup must remain safe after ssh2 has already cleaned up its protocol.
    const active = net.connect({ port: config.reversePort, host: '127.0.0.1', allowHalfOpen: true });
    active.on('error', () => {});
    const activeClosed = new Promise((resolve) => active.once('close', resolve));
    active.write(payload);
    await until(() => sequence === 3, 'active transfer target accepted');
    await delay(20); link.client._sock.destroy();
    await bounded(link.done, 'active transport drop completes link');
    await bounded(activeClosed, 'active transport drop closes operator socket');
    await waitForReleasedPort(config.reversePort);
    link = await bounded(connectTunnel(config, dir), 'receiver reconnect after active transport drop');
    link.close(); await bounded(link.done, 'receiver final link close');
    await waitForReleasedPort(config.reversePort);
  } finally {
    link?.close(); client.destroy(); sock.destroy(); ws.terminate();
    await bounded(receiver.close(), 'receiver close');
    for (const socket of locals) socket.destroy();
    await new Promise((resolve) => target.close(resolve));
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-receiver-lifecycle-')) throw new Error('Unsafe receiver fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('PASS real receiver graceful WS close releases listener and permits reconnect');
  console.log('PASS real receiver and target preserve 8MiB in both directions with paused slow readers and EOF response');
  console.log('PASS dropping WS during a backpressured transfer cleans active streams and permits reconnect');
  // Natural process exit is checked by the parent; no forced exit or unref.
}

async function receiverChild() {
  const child = spawn(process.execPath, [__filename, '--receiver-child'], { windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    assert.equal(await bounded(exit, 'receiver fixture natural exit', 30000), 0, stderr);
    assert.match(stdout, /PASS real receiver graceful WS close releases listener and permits reconnect/);
    assert.match(stdout, /PASS real receiver and target preserve 8MiB in both directions/);
    assert.equal(stderr, '');
  } finally { if (child.exitCode === null) { child.kill(); await exit; } }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-tunnel-lifecycle-'));
  const targetKey = keyPair(), tunnelKey = keyPair();
  fs.writeFileSync(path.join(root, 'target_host_key.pub'), targetKey.public);
  fs.writeFileSync(path.join(root, 'tunnel_key'), tunnelKey.private);
  const base = { id: 'fixture', targetUser: 'fixture', reversePort: 23022, targetSshPort: 22022, transport: 'websocket', webToken: 'fixture-only', expiresAt: new Date(Date.now() + 120000).toISOString() };
  try {
    let f = await fixture();
    try {
      await rawHalfClose(f);
      const config = { ...base, endpoint: f.endpoint, receiverHostKey: f.hostKey };
      const link = await bounded(connectTunnel(config, root), 'established link');
      f.websockets.at(-1).close(1000);
      await bounded(link.done, 'graceful WS close completes done');
      assert.equal(link.client._sock.destroyed, true);
      link.close();
      console.log('PASS real WS half-close reproduces end without close; tunnel cleanup completes done');
    } finally { await f.close(); }
    for (const mode of ['before-open', 'before-ready', 'register', 'forward']) {
      f = await fixture(mode);
      try {
        await assert.rejects(bounded(connectTunnel({ ...base, endpoint: f.endpoint, receiverHostKey: f.hostKey }, root), mode), /closed|ended|hang up|disconnect/i);
        console.log('PASS connection rejects promptly on ' + mode + ' disconnect');
      } finally { await f.close(); }
    }
    f = await fixture();
    try { await bridgeCases(f, { ...base, endpoint: f.endpoint, receiverHostKey: f.hostKey }, root); console.log('PASS accepted-channel reset/close cleanup and next channel with final payload integrity'); }
    finally { await f.close(); }
    f = await fixture('cli-reconnect');
    try { await cliReconnect(f, { ...base, endpoint: f.endpoint, receiverHostKey: f.hostKey }, root); console.log('PASS real CLI reconnects after remote graceful WS close and stops cleanly'); }
    finally { await f.close(); }
    await receiverChild();
    console.log('PASS real receiver disconnect/reconnect fixture exits naturally without live timers');
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-tunnel-lifecycle-')) throw new Error('Unsafe fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('ALL TUNNEL LIFECYCLE TESTS PASSED');
}
(process.argv.includes('--receiver-child') ? receiverCases() : main()).catch((error) => { console.error(error); process.exitCode = 1; });
