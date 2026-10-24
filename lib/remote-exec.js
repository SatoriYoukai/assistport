'use strict';
const crypto = require('node:crypto');
const c = require('./common');
const { failure } = require('./errors');

function runCommand(conn, command, state = {}) {
  return new Promise((resolve, reject) => {
    if (state.cancelled) return reject(failure('OPERATION_TIMEOUT', 'Operation deadline passed before dispatch'));
    state.completion = 'unknown';
    conn.exec(command, (error, stream) => {
      if (error) return reject(failure('TRANSPORT_ERROR', error.message));
      let stdout = '', stderr = '', code = null, signal = null, bytes = 0;
      const capture = (chunk, output) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) {
          reject(failure('OUTPUT_LIMIT', 'Output exceeded 4 MiB; save large output to a file instead.', { completion: 'unknown', result: { exitCode: code, signal, stdout, stderr } }));
          stream.close(); return;
        }
        if (output === 'stdout') stdout += chunk; else stderr += chunk;
      };
      stream.setEncoding('utf8'); stream.stderr.setEncoding('utf8');
      stream.on('data', (chunk) => capture(chunk, 'stdout'));
      stream.stderr.on('data', (chunk) => capture(chunk, 'stderr'));
      stream.on('error', (error) => reject(failure('TRANSPORT_ERROR', error.message, { completion: 'unknown', result: { exitCode: code, signal, stdout, stderr } })));
      stream.on('exit', (n, sig) => { code = n; signal = sig || null; });
      stream.on('close', () => { state.completion = Number.isInteger(code) ? 'completed' : 'unknown'; resolve({ exitCode: code, signal, stdout, stderr }); });
    });
  });
}
const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
const getSftp = (conn) => new Promise((resolve, reject) => conn.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));

async function executeScript(conn, script, state) {
  const inline = c.encodedCommand(script);
  if (Buffer.byteLength(script, 'utf8') > 8 * 1024 * 1024) throw new Error('Script exceeds 8 MiB');
  if (inline.length <= 6000) return { ...await runCommand(conn, inline, state), execution: { mode: 'inline' } };

  // The remote account owns its staging directory. Remove inherited access
  // BEFORE writing any script contents; public session packages contain no code.
  const name = 'temporary-support-command-' + crypto.randomBytes(16).toString('hex');
  const prepare = `$p=Join-Path ([IO.Path]::GetTempPath()) '${name}'; if(Test-Path -LiteralPath $p){throw 'Staging directory already exists'}; $d=New-Item -ItemType Directory -Path $p; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($u); foreach($s in @($u,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))){$r=New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)}; $d.SetAccessControl($a); Write-Output $d.FullName`;
  const prepared = await runCommand(conn, c.encodedCommand(prepare), state);
  if (prepared.exitCode !== 0) throw new Error('Remote staging setup failed: ' + prepared.stderr);
  const directory = prepared.stdout.trim();
  // Never execute or delete a path simply because an arbitrary stdout said so.
  if (!/^[a-zA-Z]:[\\/]/.test(directory) || /[\x00-\x1f]/.test(directory) || directory.replace(/\\/g, '/').split('/').at(-1) !== name) throw new Error('Unexpected staging directory');
  const remotePath = directory.replace(/\\/g, '/') + '/command.ps1';
  state.stagingPath = remotePath;
  const payload = Buffer.from('\uFEFF' + c.wrapScript(script), 'utf8');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  let sftp;
  let result;
  try {
    state.completion = 'unknown';
    sftp = await getSftp(conn);
    await new Promise((resolve, reject) => sftp.writeFile(remotePath, payload, { flag: 'wx' }, (error) => error ? reject(error) : resolve()));
    const launcher = `if(([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes(${quote(remotePath)}))).Replace('-','')) -ne '${digest}'){throw 'Staged script hash mismatch'}; $global:LASTEXITCODE=0; & ${quote(remotePath)}; exit $LASTEXITCODE`;
    result = await runCommand(conn, c.encodedCommand(launcher), state);
  } finally {
    // Keep cleanup on the existing connection. Never reconnect/replay commands
    // automatically after a timeout or transport failure.
    if (sftp) {
      const remove = (method, p) => new Promise((resolve) => sftp[method](p, (error) => resolve(!error || error.code === 2)));
      try { state.cleaned = await remove('unlink', remotePath) && await remove('rmdir', directory.replace(/\\/g, '/')); }
      catch { state.cleaned = false; }
      sftp.end();
    }
  }
  return { ...result, execution: { mode: 'staged', cleanup: state.cleaned ? 'removed' : 'unconfirmed', ...(state.cleaned ? {} : { stagingPath: remotePath }) } };
}
module.exports = { executeScript, runCommand };
