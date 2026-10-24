'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Server, Client, utils } = require('ssh2');
const { WebSocket } = require('ws');
const { startReceiver } = require('../receiver');
const { connectTunnel } = require('../target/tunnel');
const { operate } = require('../operator');
const { initState, makeKey } = require('../new-session');
const { invoke } = require('../lib/operation');
const { Client: McpClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const c = require('../lib/common');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function refused(port) {
  return new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(false); }); s.on('error', () => resolve(true)); });
}
function fixturePath(filesRoot, name) {
  const root = fs.realpathSync.native(filesRoot);
  const requested = path.resolve(root, name);
  let resolved;
  try { resolved = fs.realpathSync.native(requested); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // OPEN may create command.ps1, but PowerShell already created its parent.
    // Resolve that existing parent to expand Windows 8.3 aliases and junctions.
    resolved = path.join(fs.realpathSync.native(path.dirname(requested)), path.basename(requested));
  }
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Path outside fixture');
  return resolved;
}
async function fakeTarget(hostKey, publicKey, filesRoot) {
  const clients = new Set(); const allowed = c.key(publicKey);
  const server = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, (client) => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.username === 'testuser' && ctx.method === 'publickey' && c.same(ctx.key.data, allowed.getPublicSSH()) && (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept(); else ctx.reject(['publickey']);
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        const match = /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(info.command);
        if (!match) return reject();
        if (info.command.length > 8191) return reject();
        const stream = accept();
        const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', match[1]], { windowsHide: true, env: { ...process.env, TEMP: filesRoot, TMP: filesRoot } });
        proc.stdout.pipe(stream, { end: false }); proc.stderr.pipe(stream.stderr, { end: false });
        proc.on('close', (code) => { stream.exit(code); stream.end(); }); proc.on('error', () => { stream.exit(1); stream.end(); });
        stream.on('close', () => { if (proc.exitCode === null) proc.kill(); });
      });
      session.on('sftp', (accept) => {
        const sftp = accept(); const handles = new Map(); let next = 0;
        const file = (name) => fixturePath(filesRoot, name);
        const ok = 0, failure = 4, eof = 1;
        const attrs = (p) => { const s = fs.statSync(p); return { mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) }; };
        sftp.on('OPEN', (req, name, flags) => { try { const mode = flags & 2 ? (flags & 32 ? 'wx' : 'w+') : 'r'; const fd = fs.openSync(file(name), mode); const h = Buffer.from(String(++next)); handles.set(h.toString(), fd); sftp.handle(req, h); } catch { sftp.status(req, failure); } });
        sftp.on('WRITE', (req, handle, offset, data) => { try { fs.writeSync(handles.get(handle.toString()), data, 0, data.length, offset); sftp.status(req, ok); } catch { sftp.status(req, failure); } });
        sftp.on('READ', (req, handle, offset, length) => { try { const buffer = Buffer.alloc(length); const n = fs.readSync(handles.get(handle.toString()), buffer, 0, length, offset); n ? sftp.data(req, buffer.subarray(0, n)) : sftp.status(req, eof); } catch { sftp.status(req, failure); } });
        sftp.on('CLOSE', (req, handle) => { try { fs.closeSync(handles.get(handle.toString())); handles.delete(handle.toString()); sftp.status(req, ok); } catch { sftp.status(req, failure); } });
        sftp.on('STAT', (req, name) => { try { sftp.attrs(req, attrs(file(name))); } catch { sftp.status(req, failure); } });
        sftp.on('FSTAT', (req, handle) => { try { const s = fs.fstatSync(handles.get(handle.toString())); sftp.attrs(req, { size: s.size, mode: s.mode }); } catch { sftp.status(req, failure); } });
        sftp.on('REMOVE', (req, name) => { try { fs.unlinkSync(file(name)); sftp.status(req, ok); } catch { sftp.status(req, failure); } });
        sftp.on('RMDIR', (req, name) => { try { fs.rmdirSync(file(name)); sftp.status(req, ok); } catch { sftp.status(req, failure); } });
        sftp.on('end', () => { for (const fd of handles.values()) { try { fs.closeSync(fd); } catch {} } });
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, async close() { for (const client of clients) client.end(); await new Promise((resolve) => server.close(resolve)); } };
}
async function run() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-support-test-中文'-"));
  assert.equal(fixturePath(scratch, 'fixture-new-file'), path.join(fs.realpathSync.native(scratch), 'fixture-new-file'));
  assert.throws(() => fixturePath(scratch, '..'), /outside fixture/);
  assert.throws(() => fixturePath(scratch, path.join(scratch + '-other', 'escape')), /ENOENT|outside fixture/);
  const root = process.env.SUPPORT_EXTERNAL_STATE ? path.resolve(process.env.SUPPORT_EXTERNAL_STATE) : scratch;
  initState(root);
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(root, 'sessions', id); fs.mkdirSync(dir);
  const control = makeKey(path.join(dir, 'control_key')); makeKey(path.join(dir, 'tunnel_key')); makeKey(path.join(dir, 'target_host_key'));
  const reversePort = await freePort();
  const config = { id, transport: 'websocket', targetUser: 'testuser', computer: 'fixture', reversePort,
    authorization: require('../lib/authorization').authorization(),
    webToken: crypto.randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 120000).toISOString(), revoked: false,
    receiverHostKey: fs.readFileSync(path.join(root, 'receiver_host_key.pub'), 'utf8').trim() };
  c.writeJson(path.join(dir, 'session.json'), config);
  const target = await fakeTarget(path.join(dir, 'target_host_key'), control, scratch);
  const directPort = await freePort();
  const receiver = process.env.SUPPORT_EXTERNAL_STATE
    ? { addresses: { httpPort: c.readJson(path.join(root, 'receiver-processes.json')).httpPort }, close: async () => {} }
    : await startReceiver({ stateRoot: root, httpPort: 0, directPort, directBind: '127.0.0.1' });
  let link;
  try {
    const testEndpoint = process.env.SUPPORT_TEST_ENDPOINT;
    config.endpoint = (testEndpoint ? testEndpoint.replace(/^https:/, 'wss:') : `ws://127.0.0.1:${receiver.addresses.httpPort}`) + '/tunnel/' + id;
    // An optional public test origin must point to this receiver's HTTP port.
    config.targetSshPort = target.port;
    const bad = new WebSocket(`ws://127.0.0.1:${receiver.addresses.httpPort}/tunnel/${id}`);
    const unauthorized = await new Promise((resolve) => { bad.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); bad.terminate(); }); bad.on('error', () => {}); });
    assert.equal(unauthorized, 401); console.log('PASS unauthorized WebSocket rejected');
    link = await connectTunnel(config, dir);
    assert.equal((await operate({ session: dir, action: 'status' })).registered, true);
    assert.equal((await operate({ session: dir, action: 'status' })).connectivity, 'unknown');
    assert.equal((await operate({ session: dir, action: 'probe' })).connected, true);
    link.close();
    await link.done;
    for (let attempt = 0; attempt < 40 && !(await refused(reversePort)); attempt++) await sleep(50);
    assert.equal((await operate({ session: dir, action: 'status' })).registered, true);
    assert.equal((await operate({ session: dir, action: 'probe' })).connected, false);
    link = await connectTunnel(config, dir);
    assert.equal((await operate({ session: dir, action: 'probe' })).connected, true);
    console.log('PASS historical registration remains distinct from live authenticated probe and reconnect');
    const blackholeSockets = new Set();
    const blackhole = net.createServer((socket) => { blackholeSockets.add(socket); socket.on('close', () => blackholeSockets.delete(socket)); });
    await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const currentConfig = c.readJson(path.join(dir, 'session.json'));
    c.writeJson(path.join(dir, 'session.json'), { ...currentConfig, reversePort: blackhole.address().port });
    try {
      const begin = Date.now();
      const cli = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, '../operator.js'), 'exec', '--session', dir, '--command', 'Write-Output 1', '--timeout', '1'], { windowsHide: true });
        let stderr = '', stdout = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('error', reject); child.on('close', (exitCode) => resolve({ exitCode, stderr, result: JSON.parse(stdout) }));
      });
      assert.equal(cli.exitCode, 1); assert.match(cli.result.error.message, /timed out/i);
      assert.equal(cli.result.error.code, 'OPERATION_TIMEOUT'); assert.equal(cli.result.error.completion, 'not_started');
      assert.doesNotMatch(cli.stderr, /Unhandled|node:events|throw er/);
      assert.ok(Date.now() - begin < 4000);
    } finally {
      c.writeJson(path.join(dir, 'session.json'), currentConfig);
      for (const socket of blackholeSockets) socket.destroy();
      await new Promise((resolve) => blackhole.close(resolve));
    }
    console.log('PASS total timeout bounds a stalled SSH handshake with no uncaught error');
    const result = await operate({ session: dir, action: 'exec', command: "Write-Output '中文结果'; Write-Output (6*7)" });
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /中文结果/); assert.match(result.stdout, /42/);
    console.log('PASS authenticated reverse SSH and real PowerShell Unicode command');
    const mcp = new McpClient({ name: 'ssh-integration', version: '1.0.0' });
    const mcpTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../mcp-server.js'), '--session', dir], stderr: 'pipe' });
    let mcpStderr = ''; mcpTransport.stderr.on('data', (data) => { mcpStderr += data; });
    try {
      await mcp.connect(mcpTransport);
      const probe = await mcp.callTool({ name: 'support_probe', arguments: {} });
      assert.equal(probe.structuredContent.result.connected, true);
      const executed = await mcp.callTool({ name: 'support_execute', arguments: { command: "Write-Output 'MCP 中文结果'; exit 7" } });
      assert.equal(executed.isError, true); assert.equal(executed.structuredContent.error.code, 'REMOTE_EXIT');
      assert.equal(executed.structuredContent.error.completion, 'completed');
      assert.equal(executed.structuredContent.result.exitCode, 7); assert.match(executed.structuredContent.result.stdout, /MCP 中文结果/);
      const timed = await mcp.callTool({ name: 'support_execute', arguments: { command: 'Start-Sleep -Seconds 10', timeout: 1 } });
      assert.equal(timed.structuredContent.error.code, 'OPERATION_TIMEOUT'); assert.equal(timed.structuredContent.error.completion, 'unknown');
      assert.equal(mcpStderr, '');
    } finally { await mcp.close(); }
    const cancelled = new AbortController();
    const cancelling = invoke({ session: dir, action: 'exec', command: 'Start-Sleep -Seconds 10', signal: cancelled.signal });
    const cancelTimer = setTimeout(() => cancelled.abort(), 700);
    try { const cancelledResult = await cancelling; assert.equal(cancelledResult.error.code, 'OPERATION_CANCELLED'); assert.equal(cancelledResult.error.completion, 'unknown'); }
    finally { clearTimeout(cancelTimer); }
    console.log('PASS MCP -> reverse SSH -> real PowerShell, Unicode/exit status, unknown timeout and dispatch cancellation');
    const large = "# 中文脚本内容\n".repeat(2500) + "Write-Output '大脚本中文结果'; Write-Output $PSScriptRoot";
    assert.ok(c.encodedCommand(large).length > 8191);
    const localScript = path.join(scratch, '中文脚本.ps1'); fs.writeFileSync(localScript, large, 'utf8');
    const staged = await operate({ session: dir, action: 'exec', file: localScript });
    assert.equal(staged.exitCode, 0); assert.match(staged.stdout, /大脚本中文结果/);
    assert.equal(staged.execution.mode, 'staged'); assert.equal(staged.execution.cleanup, 'removed');
    assert.equal(fs.readdirSync(scratch).filter((name) => name.startsWith('temporary-support-command-')).length, 0);
    const stagedFailure = await operate({ session: dir, action: 'exec', command: large + "\nthrow 'large fixture failure'" });
    assert.equal(stagedFailure.exitCode, 1); assert.match(stagedFailure.stderr, /large fixture failure/);
    assert.equal(stagedFailure.execution.cleanup, 'removed');
    const stagedExit = await operate({ session: dir, action: 'exec', command: large + '\nexit 7' });
    assert.equal(stagedExit.exitCode, 7); assert.equal(stagedExit.execution.cleanup, 'removed');
    console.log('PASS oversized Unicode scripts, failure/explicit exit and staging cleanup');
    const started = Date.now();
    await assert.rejects(operate({ session: dir, action: 'exec', command: large + '\nStart-Sleep -Seconds 10', timeout: 2 }), /timed out.*completion is unknown.*cleanup is unconfirmed/i);
    assert.ok(Date.now() - started < 4000);
    console.log('PASS staged timeout reports unknown completion and cleanup without replay');
    const error = await operate({ session: dir, action: 'exec', command: "throw 'fixture failure'" });
    assert.equal(error.exitCode, 1); assert.match(error.stderr, /fixture failure/); console.log('PASS remote failure and exit code captured');
    const binary = crypto.randomBytes(170000); const local = path.join(scratch, 'upload.bin'); const downloaded = path.join(scratch, 'download.bin'); fs.writeFileSync(local, binary);
    await operate({ session: dir, action: 'upload', local, remote: 'remote.bin' });
    await operate({ session: dir, action: 'download', local: downloaded, remote: 'remote.bin' });
    assert.deepEqual(fs.readFileSync(downloaded), binary); console.log('PASS binary SFTP upload/download integrity');
    await new Promise((resolve, reject) => link.client.forwardIn('0.0.0.0', reversePort + 1, (error) => error ? resolve() : reject(new Error('Wildcard forward was accepted'))));
    console.log('PASS unrestricted reverse listener denied');
    await new Promise((resolve, reject) => link.client.exec('whoami', (error) => error ? resolve() : reject(new Error('Controller shell was accepted'))));
    console.log('PASS controller command execution denied');
    const receipt = c.readJson(path.join(dir, 'receipt.json'));
    const other = utils.generateKeyPairSync('ed25519'); c.writeJson(path.join(dir, 'receipt.json'), { ...receipt, hostKey: other.public });
    await assert.rejects(operate({ session: dir, action: 'exec', command: 'whoami' }), /verification|host/i);
    c.writeJson(path.join(dir, 'receipt.json'), receipt); console.log('PASS target host-key mismatch denied');
    const wrong = { ...config, receiverHostKey: other.public };
    // Receiver only permits one forward at a time; host verification fails before that point.
    await assert.rejects(connectTunnel(wrong, dir), /verification|host/i); console.log('PASS receiver host-key mismatch denied');
    const closed = link.done;
    await operate({ session: dir, action: 'revoke' });
    await Promise.race([closed, sleep(4000).then(() => { throw new Error('Revocation did not close tunnel'); })]);
    assert.equal(await refused(reversePort), true);
    await assert.rejects(operate({ session: dir, action: 'exec', command: 'whoami' }), /revoked/);
    assert.equal((await operate({ session: dir, action: 'probe' })).reason, 'expired_or_revoked');
    await assert.rejects(connectTunnel(config, dir)); console.log('PASS revocation drops tunnel/listener and denies reconnect');
    // Restore a fresh session, prove the direct-TCP transport too.
    config.revoked = false;
    if (!process.env.SUPPORT_EXTERNAL_STATE) { config.transport = 'tcp'; config.receiverHost = '127.0.0.1'; config.receiverPort = directPort; }
    c.writeJson(path.join(dir, 'session.json'), config);
    link = await connectTunnel(config, dir);
    assert.equal((await operate({ session: dir, action: 'exec', command: 'Write-Output 123' })).exitCode, 0);
    console.log(process.env.SUPPORT_EXTERNAL_STATE ? 'PASS public WebSocket reconnect' : 'PASS direct TCP reverse SSH transport');
    const updated = c.readJson(path.join(dir, 'session.json')); updated.expiresAt = new Date(Date.now() - 1).toISOString(); c.writeJson(path.join(dir, 'session.json'), updated);
    await Promise.race([link.done, sleep(4000).then(() => { throw new Error('Expiry did not close tunnel'); })]);
    assert.equal(await refused(reversePort), true); console.log('PASS expiry disconnects active session');
  } finally {
    link?.close();
    const last = c.readJson(path.join(dir, 'session.json')); last.revoked = true; c.writeJson(path.join(dir, 'session.json'), last);
    await receiver.close(); await target.close();
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(scratch)) !== tempRoot || !path.basename(scratch).startsWith('temporary-support-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log('ALL INTEGRATION TESTS PASSED');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
