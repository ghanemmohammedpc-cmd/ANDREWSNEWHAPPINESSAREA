import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = fileURLToPath(new URL('..', import.meta.url));
const build = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
build.on('exit', code => {
  if (code) { process.exitCode = code; return; }
  const electron = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true });
  electron.on('exit', status => { process.exitCode = status || 0; });
  process.once('SIGINT', () => electron.kill());
});
