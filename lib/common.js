'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { utils } = require('ssh2');

function args(argv = process.argv.slice(2)) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      if (!/^[a-z][a-z-]*$/.test(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
      result[name] = argv[++i];
    } else result._.push(argv[i]);
  }
  return result;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function key(value) {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid SSH key');
  return parsed;
}
function same(a, b) {
  a = Buffer.from(a); b = Buffer.from(b);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function fingerprint(raw) { return 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, ''); }
function active(session, now = Date.now()) {
  const until = Date.parse(session.expiresAt);
  return session.revoked !== true && Number.isFinite(until) && until > now;
}
function port(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Port must be 1024..65535');
  return n;
}
function sessionId(value) {
  if (!/^[a-f0-9]{16}$/.test(value)) throw new Error('Invalid session ID');
  return value;
}
function readSession(stateRoot, id) {
  sessionId(id);
  const dir = path.join(stateRoot, 'sessions', id);
  const value = readJson(path.join(dir, 'session.json'));
  if (value.id !== id) throw new Error('Session ID mismatch');
  return { dir, value };
}
function wrapScript(script) {
  if (typeof script !== 'string' || !script.trim()) throw new Error('Empty PowerShell script');
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; try {\n${script}\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
}
function encodedCommand(script) { return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(wrapScript(script), 'utf16le').toString('base64'); }
function log(event, extra = {}) { process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...extra }) + '\n'); }
module.exports = { args, readJson, writeJson, key, same, fingerprint, active, port, sessionId, readSession, wrapScript, encodedCommand, log };
