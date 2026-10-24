'use strict';
function authorization(scope = 'full') {
  if (scope !== 'full') throw new Error('Only the full assistance scope is currently implemented');
  return { profile: 'full', capabilities: ['command', 'files', 'screenshot', 'desktop'], enforcement: 'declared', extensionDeployment: 'within-session' };
}
function operatorLabel(value = 'Support operator') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Operator label must be 1..80 visible characters');
  return value.trim();
}
module.exports = { authorization, operatorLabel };
