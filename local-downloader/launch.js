'use strict';

/**
 * Used by the double-click launchers:
 *   1. pulls the latest version from GitHub (when this folder is a git clone),
 *   2. installs or updates npm dependencies when needed,
 *   3. starts the server and opens the browser.
 *
 * Every step is best-effort: if updating fails (offline, local edits, git not
 * installed), the app still starts with the version already on disk.
 * Set LOCAL_DOWNLOADER_NO_UPDATE=1 to skip the update check.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const isWindows = process.platform === 'win32';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    // npm is a .cmd script on Windows, which needs a shell. Arguments are
    // fixed strings, never user input.
    shell: isWindows && command === 'npm',
    ...options,
  });
}

function updateFromGit() {
  if (process.env.LOCAL_DOWNLOADER_NO_UPDATE === '1') return;

  const inside = run('git', ['rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0) return; // not a clone, or git missing

  const before = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  process.stdout.write('  Checking for updates... ');
  const pull = run('git', ['pull', '--ff-only', '--quiet'], {
    timeout: 60 * 1000,
    // Never sit waiting for a password prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  if (pull.error || pull.status !== 0) {
    console.log('skipped (could not reach GitHub or the folder has local changes).');
    const reason = `${pull.stderr || ''}`.trim();
    if (reason) console.log(`  ${reason.split('\n')[0]}`);
    return;
  }
  const after = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  console.log(before === after ? 'up to date.' : 'updated to the latest version.');
}

function needsInstall() {
  const marker = path.join(ROOT, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(marker)) return true;
  const installedAt = fs.statSync(marker).mtimeMs;
  return ['package.json', 'package-lock.json'].some((file) => {
    const full = path.join(ROOT, file);
    return fs.existsSync(full) && fs.statSync(full).mtimeMs > installedAt;
  });
}

function installDependencies() {
  if (!needsInstall()) return true;
  console.log('  Installing dependencies...');
  // `npm ci` installs exactly what package-lock.json lists and never edits
  // it, so the folder stays clean for the next `git pull`.
  const command = fs.existsSync(path.join(ROOT, 'package-lock.json')) ? 'ci' : 'install';
  const result = run('npm', [command, '--no-fund', '--no-audit', '--loglevel=error'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('\n  npm install failed. Check your internet connection and try again.');
    return false;
  }
  return true;
}

console.log('');
updateFromGit();
if (!installDependencies()) process.exit(1);

process.argv.push('--open');
require('./server.js');
