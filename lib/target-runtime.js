'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Node 22's native cpSync directory path can mis-encode Unicode Windows
// destinations. Keep names in the JS filesystem APIs for every copied entry.
function copyDirectory(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  const relative = path.relative(source, destination);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw new Error('Cannot copy a directory inside itself');
  if (!fs.lstatSync(source).isDirectory()) throw new Error('Bundle source must be a regular directory');
  function copyEntry(from, to) {
    const stat = fs.lstatSync(from);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Bundle inputs must contain only regular files and directories');
    let existing;
    try { existing = fs.lstatSync(to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing?.isSymbolicLink()) throw new Error('Bundle destination must not contain symbolic links');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) copyEntry(path.join(from, name), path.join(to, name));
    } else fs.copyFileSync(from, to);
  }
  copyEntry(source, destination);
}

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
    copyDirectory(directory, path.join(destination, relative));
    for (const dep of Object.keys(pkg.dependencies || {})) copy(dep, manifest);
    for (const dep of Object.keys(pkg.optionalDependencies || {})) copy(dep, manifest, true);
  }
  for (const name of ['ssh2', 'ws']) copy(name, path.join(project, 'package.json'));
  return seen.size;
}
module.exports = { copyDirectory, copyTargetDependencies };
