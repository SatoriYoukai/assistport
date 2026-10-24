'use strict';
const fs = require('node:fs');
const path = require('node:path');
const c = require('./common');

function normalizeTool(input, allowed) {
  if (!input || !/^[a-z][a-z0-9-]{1,63}$/.test(input.id || '')) throw new Error('Tool id must be a simple lowercase identifier');
  const visible = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
  if (!visible(input.version, 80)) throw new Error('A pinned tool version is required');
  const url = new URL(input.source?.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Tool source must be an HTTPS URL without credentials, query, or fragment');
  if (!/^[a-f0-9]{64}$/.test(input.source?.sha256 || '')) throw new Error('Tool artifact SHA-256 is required');
  if (!Array.isArray(input.capabilities) || !input.capabilities.length || input.capabilities.some((value) => !allowed.includes(value))) throw new Error('Tool capabilities exceed the session declaration');
  if (!visible(input.review?.by, 80) || !visible(input.review?.evidence, 1000) || !visible(input.cleanup, 2000)) throw new Error('Tool review evidence and cleanup procedure are required');
  return { id: input.id, version: input.version, source: { url: url.toString(), sha256: input.source.sha256 }, capabilities: [...new Set(input.capabilities)].sort(), review: { by: input.review.by, evidence: input.review.evidence }, cleanup: input.cleanup };
}
function toolOperation(root, config, options) {
  const directory = path.join(root, 'tools');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Tool registry refuses symlinks');
  if (options.operation === 'register') {
    const tool = normalizeTool(c.readJson(path.resolve(options.file)), config.authorization?.capabilities || []);
    const filename = path.join(directory, tool.id + '.json');
    if (fs.existsSync(filename)) {
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Tool registry refuses symlinks');
      if (JSON.stringify(c.readJson(filename)) !== JSON.stringify(tool)) throw new Error('Tool registration changed; use a new id for another version or source');
    } else c.writeJson(filename, tool);
    return { status: 'registered', installed: false, verification: 'review-recorded-artifact-not-downloaded', tool };
  }
  if (options.operation === 'inspect') {
    const entries = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^[a-z][a-z0-9-]{1,63}\.json$/.test(name)) : [];
    const tools = entries.map((name) => {
      const filename = path.join(directory, name);
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Tool registry refuses symlinks');
      return c.readJson(filename);
    });
    return { installed: false, note: 'Source/review registry only; external deployment adapters are not implemented.', tools };
  }
  throw new Error('Tool operation must be register or inspect');
}
module.exports = { normalizeTool, toolOperation };
