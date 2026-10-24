'use strict';
const crypto = require('node:crypto');
const { SupportError } = require('./errors');

// One result contract for CLI, JavaScript callers and MCP. Keep stdout/stderr
// supplied by the remote command as data; never interpret them as instructions.
async function invoke(options, runner) {
  const start = Date.now();
  const envelope = {
    apiVersion: 1, operationId: crypto.randomUUID(), sessionId: null,
    action: typeof options?.action === 'string' ? options.action : null,
    startedAt: new Date(start).toISOString(), finishedAt: null, durationMs: 0,
    ok: false, result: null, error: null
  };
  const state = {};
  try {
    if (!runner) runner = require('../operator').operate;
    const value = await runner(options, state);
    envelope.result = value;
    if (value?.exitCode !== undefined && value.exitCode !== 0) {
      envelope.error = {
        code: value.exitCode === null ? 'REMOTE_OUTCOME_UNKNOWN' : 'REMOTE_EXIT',
        message: value.exitCode === null ? 'Remote command closed without an exit status.' : `Remote command exited with code ${value.exitCode}.`,
        completion: value.exitCode === null ? 'unknown' : 'completed'
      };
    } else if (value?.connected === false) {
      envelope.error = { code: 'PROBE_FAILED', message: 'Authenticated command probe did not succeed.', completion: 'completed' };
    } else if (options.action === 'capability' && value?.state === 'cleanup-incomplete') {
      envelope.error = { code: 'CLEANUP_INCOMPLETE', message: 'Some capability resources were retained because their ownership or content changed.', completion: 'completed' };
    } else envelope.ok = true;
  } catch (error) {
    envelope.result = error.result || null;
    envelope.error = {
      code: error instanceof SupportError ? error.code : 'OPERATION_FAILED',
      message: String(error.message || 'Operation failed'),
      completion: error.completion || state.completion || 'not_started',
      ...(error.stagingPath || state.stagingPath ? { stagingPath: error.stagingPath || state.stagingPath, cleanup: state.cleaned ? 'removed' : 'unconfirmed' } : {})
    };
  }
  envelope.sessionId = state.sessionId || null;
  envelope.finishedAt = new Date().toISOString();
  envelope.durationMs = Date.now() - start;
  return envelope;
}
module.exports = { invoke };
