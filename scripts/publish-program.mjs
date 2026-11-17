import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repo = 'ghanemmohammedpc-cmd/ANDREWSNEWHAPPINESSAREA';
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const gh = process.env.GH_PATH || 'C:/Users/ghane/Documents/Codex/Tools/GitHub CLI/bin/gh.exe';
const token = execFileSync(gh, ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', windowsHide: true }).trim();
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'TeamRazkaProgram' };
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repo}${endpoint}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return response.json();
}
const tag = `program-${metadata.version}`;
const existing = await api(`/releases/tags/${tag}`);
if (existing) throw new Error('This program release already exists. No files were changed.');
const files = ['Team Razka Program Setup.exe', 'Team Razka Program.exe'];
const assets = [];
for (const filename of files) {
  const file = `release/${filename}`, info = await stat(file), hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assets.push({ filename, file, size: info.size, sha256: hash.digest('hex') });
}
const release = await api('/releases', 'POST', { tag_name: tag, name: 'Team Razka Program', body: 'BeamNG mod library for Team Razka Discord members.\n\nUse Team Razka Program Setup.exe to install, or Team Razka Program.exe for the portable version.\n\nمكتبة مودات BeamNG لأعضاء ديسكورد Team Razka. استخدم ملف Setup للتثبيت أو الملف الآخر للتشغيل المحمول.', draft: true, prerelease: false });
for (const asset of assets) {
  const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset.filename)}&label=${encodeURIComponent(asset.filename)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/vnd.microsoft.portable-executable', 'content-length': String(asset.size) }, body: createReadStream(asset.file), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(1800000) });
  if (!response.ok) throw new Error(`Program upload ${response.status}`);
  const uploaded = await response.json();
  if (uploaded.digest !== `sha256:${asset.sha256}` || uploaded.size !== asset.size) throw new Error('Program checksum did not match.');
}
const published = await api(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'true' });
console.log(published.html_url);
