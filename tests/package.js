'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { newSession } = require('../new-session');
const { readJson } = require('../lib/common');
const { authorization, operatorLabel } = require('../lib/authorization');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), "support-package-test-中文'-"));
try {
  assert.deepEqual(authorization().capabilities, ['command', 'files', 'screenshot', 'desktop']);
  assert.equal(authorization().enforcement, 'declared');
  assert.throws(() => authorization('restricted'), /Only the full/);
  assert.throws(() => operatorLabel('bad\nlabel'), /visible characters/);
  assert.throws(() => newSession({ scope: 'restricted' }), /Only the full/);
  const label = '临时技术协助';
  const result = newSession({ state: path.join(root, 'private'), bundle: path.join(root, 'bundle'), endpoint: 'https://localhost', operator: label });
  const controller = readJson(path.join(result.controllerSession, 'session.json'));
  const target = readJson(path.join(result.targetDirectory, 'session.json'));
  assert.deepEqual(target.authorization, controller.authorization);
  assert.equal(target.operatorLabel, label);
  for (const file of ['Show-SessionInfo.ps1', 'Read-SupportLog.ps1', 'Read-SupportJson.ps1', 'Manage-Capability.ps1', 'Capability.Core.ps1', 'capabilities/screenshot/Capture.ps1', 'capabilities/screenshot/Run.vbs', 'lib/stream-pair.js', 'LICENSE', 'START.cmd']) assert.ok(fs.existsSync(path.join(result.targetDirectory, file)), `Missing target bundle file: ${file}`);
  // Controller execution credentials must never be sent in the target package.
  assert.equal(fs.existsSync(path.join(result.targetDirectory, 'control_key')), false);
  assert.equal(fs.existsSync(path.join(result.targetDirectory, 'receiver_host_key')), false);
  assert.ok(target.runtimeSha256);
  assert.equal(fs.existsSync(path.join(result.targetDirectory, 'node_modules', '@modelcontextprotocol')), false);
  const load = spawnSync(path.join(result.targetDirectory, 'runtime', 'node.exe'), ['-e', "require('./target/tunnel'); require('ssh2'); require('ws');"], { cwd: result.targetDirectory, windowsHide: true, encoding: 'utf8' });
  assert.equal(load.status, 0, load.stderr);
  // Exercise the same PowerShell packaging entrypoint used for handoff. It
  // expands the FINAL ZIP and runs Bootstrap -CheckOnly in Windows PowerShell 5.
  const packaged = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../New-SupportPackage.ps1'), '-StateDirectory', path.join(root, 'private'), '-OutputDirectory', path.join(root, '交付包'), '-Endpoint', 'https://localhost', '-ReversePort', '23023', '-OperatorLabel', label], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(packaged.status, 0, packaged.stderr);
  const handoff = JSON.parse(packaged.stdout.replace(/^\uFEFF/, ''));
  assert.equal(handoff.PackageValidation, 'final-zip-windows-powershell-5.1-checkonly');
  assert.equal(readJson(path.join(handoff.ControllerSession, 'session.json')).operatorLabel, label);
  assert.ok(fs.existsSync(handoff.TargetZIP));
  assert.equal(fs.existsSync(path.join(root, 'private', 'validation', handoff.Session)), false);
  console.log('PASS final ZIP extracted and checked by Windows PowerShell 5.1; Chinese label/paths, native UTF8 stdout and validation cleanup');
  console.log('PASS default full-assistance declaration, label validation, package helpers/license and private key separation');
} finally {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('support-package-test-')) throw new Error('Unsafe package test cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
}
