import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile, writeFile, readFile, cp } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
loadEnv({ quiet: true });
await mkdir('dist/desktop', { recursive: true });
await mkdir('dist/server', { recursive: true });
await bundle({ entryPoints: ['desktop/main.ts', 'desktop/preload.ts'], outdir: 'dist/desktop', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: false });
await bundle({ entryPoints: ['server/index.ts', 'server/bot.ts'], outdir: 'dist/server', outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm', sourcemap: false });
await copyFile('server/migrations.sql', 'dist/server/migrations.sql');
await writeFile('dist/desktop/connection.json', JSON.stringify({ serverUrl: process.env.PUBLIC_API_BASE_URL || '' }));
await viteBuild();
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/package', { recursive: true });
await writeFile('dist/package/package.json', JSON.stringify({ name: metadata.name, productName: metadata.productName, version: metadata.version, description: metadata.description, author: metadata.author, main: metadata.main, private: true }));
for (const name of ['desktop', 'renderer']) await cp(`dist/${name}`, `dist/package/dist/${name}`, { recursive: true });
await cp('assets', 'dist/package/assets', { recursive: true });
if (process.platform === 'win32') {
  await mkdir('dist/setup', { recursive: true });
  execFileSync(path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/target:winexe', `/out:${path.join(root, 'dist', 'setup', 'Discord Setup.exe')}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', path.join(root, 'scripts', 'setup-discord.cs')], { windowsHide: true, stdio: 'inherit' });
}
console.log('Built the desktop app and backend.');
