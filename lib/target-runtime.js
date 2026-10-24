'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Copy only the installed dependency closure needed by the target tunnel.
// Keep npm's relative layout, original package metadata and license files.
function copyTargetDependencies(project, destination) {
  const modules = path.join(project, 'node_modules');
  const seen = new Set();
  function copy(name, parent, optional = false) {
    const resolve = createRequire(parent);
    let entry;
    try { entry = resolve.resolve(name); } catch (error) { if (optional && error.code === 'MODULE_NOT_FOUND') return; throw error; }
    let directory = path.dirname(entry);
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) break;
      directory = path.dirname(directory);
    }
    const relative = path.relative(modules, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Target runtime dependency must be installed inside node_modules');
    if (seen.has(directory)) return;
    seen.add(directory);
    const manifest = path.join(directory, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.cpSync(directory, path.join(destination, relative), { recursive: true });
    for (const dep of Object.keys(pkg.dependencies || {})) copy(dep, manifest);
    for (const dep of Object.keys(pkg.optionalDependencies || {})) copy(dep, manifest, true);
  }
  for (const name of ['ssh2', 'ws']) copy(name, path.join(project, 'package.json'));
  return seen.size;
}
module.exports = { copyTargetDependencies };
