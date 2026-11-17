import { readFile, writeFile, rename, stat, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import sharp from 'sharp';

const directory = path.resolve('data/collection'), manifestPath = path.join(directory, 'manifest.json'), journalPath = path.join(directory, 'publication.json');
const repo = 'ghanemmohammedpc-cmd/ANDREWSNEWHAPPINESSAREA', origin = 'https://team-razka-program.team-razka-program.workers.dev';
const config = parse(await readFile('.env', 'utf8'));
const gh = process.env.GH_PATH || 'C:/Users/ghane/Documents/Codex/Tools/GitHub CLI/bin/gh.exe';
const token = execFileSync(gh, ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', windowsHide: true }).trim();
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'TeamRazkaProgram', 'x-github-api-version': '2026-03-10' };
const ownerId = config.ADMIN_DISCORD_IDS?.split(',')[0]?.trim();
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
if (!ownerId || !config.PUBLISH_CALLBACK_SECRET) throw new Error('Private publication configuration is incomplete.');
const lockPath = path.join(directory, 'publication.lock'), lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid));
let journal: Record<string, any> = {}; try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch {}
if (process.argv.includes('--retry')) for (const state of Object.values(journal)) if (state.status === 'failed') state.status = 'pending';
async function save() { await writeFile(journalPath + '.tmp', JSON.stringify(journal, null, 2)); await rename(journalPath + '.tmp', journalPath); }
async function api(endpoint: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(`https://api.github.com/repos/${repo}${endpoint}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`GitHub ${response.status}`); return response.status === 204 ? null : response.json();
}
async function releases() { const values = []; for (let page = 1; ; page++) { const batch = await api(`/releases?per_page=100&page=${page}`); values.push(...batch); if (batch.length < 100) break; } return values; }
async function importListing(item: any, release: any, asset: any) {
  let picture;
  if (item.picture) { const buffer = await readFile(item.picture), info = await sharp(buffer).metadata(); picture = { body: buffer.toString('base64'), width: info.width, height: info.height }; }
  const r = await fetch(`${origin}/api/v1/publish/import`, { method: 'POST', headers: { authorization: `Bearer ${config.PUBLISH_CALLBACK_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ ownerId, ...(item.replacesModId ? { modId: item.replacesModId } : {}), renameListing: Boolean(item.renameListing), releaseId: String(release.id), assetId: String(asset.id), filename: item.filename, size: item.size, sha256: item.sha256, metadata: item.metadata, ...(picture ? { picture } : {}) }), signal: AbortSignal.timeout(60000) });
  const result = await r.json() as any; if (!r.ok) throw new Error(`Catalog import ${r.status}: ${result.error?.code || 'failed'}`); return result.modId;
}
async function run() {
  const baseline = JSON.parse(await readFile('data/github-baseline.json', 'utf8'));
  let remote = await releases();
  const protectedIds = new Set(remote.map(r => String(r.id)));
  const initialAssetCount = remote.reduce((n, r) => n + r.assets.length, 0);
  console.log(`Found ${remote.length} existing releases and ${initialAssetCount} assets; existing files will be read only.`);
  for (;;) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const waiting = manifest.items.filter((item: any) => item.status === 'ready' && (!only || item.filename === only) && journal[item.sha256]?.status !== 'published' && journal[item.sha256]?.status !== 'failed');
    for (const item of waiting) {
      const state = journal[item.sha256] ||= { filename: item.filename, file: item.file, createdAt: Date.now(), status: 'pending' };
      try {
        const current = await stat(item.file); if (current.size !== item.size || current.mtimeMs !== item.modified) throw new Error('The local source changed after validation.');
        let release = remote.find(r => !r.draft && r.assets.some((a: any) => a.size === item.size && a.digest === `sha256:${item.sha256}`));
        let asset = release?.assets.find((a: any) => a.size === item.size && a.digest === `sha256:${item.sha256}`);
        if (!asset) {
          if (state.releaseId) { release = await api(`/releases/${state.releaseId}`); if (protectedIds.has(String(release.id)) && !state.createdByThisRun) throw new Error('An existing release cannot be changed.'); }
          else {
            const tag = `mod-${item.sha256.slice(0, 20)}`;
            const collision = await api(`/releases/tags/${tag}`); if (collision) throw new Error('A release with this tag already exists; no files were overwritten.');
            release = await api('/releases', 'POST', { tag_name: tag, name: item.metadata.name, body: item.metadata.description, draft: true, prerelease: false, make_latest: 'false' });
            Object.assign(state, { releaseId: String(release.id), createdByThisRun: true, status: 'uploading' }); await save();
          }
          asset = release.assets.find((a: any) => a.size === item.size && a.digest === `sha256:${item.sha256}`);
          if (!asset) {
            if (!release.draft || release.assets.length) throw new Error('The release already contains a different file; no files were overwritten.');
            console.log(`Uploading ${item.filename} (${Math.round(item.size / 1048576)} MB)`);
            const r = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(item.filename)}&label=${encodeURIComponent(item.filename)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip', 'content-length': String(item.size) }, body: createReadStream(item.file), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(1800000) } as any);
            if (!r.ok) throw new Error(`ZIP upload ${r.status}`); asset = await r.json();
          }
          if (asset.digest !== `sha256:${item.sha256}` || asset.size !== item.size || asset.label !== item.filename && asset.name !== item.filename) throw new Error('GitHub checksum or original filename label did not match.');
          if (release.draft) { release = await api(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'false' }); }
          remote = remote.filter(r => r.id !== release.id); remote.push(release);
        }
        state.modId = await importListing(item, release, asset);
        Object.assign(state, { assetId: String(asset.id), releaseId: String(release.id), status: 'published', completedAt: Date.now() }); await save();
        console.log(`Published ${item.filename}`);
      } catch (error) { state.status = 'failed'; state.error = error instanceof Error ? error.message : 'Publication failed.'; await save(); console.log(`Needs attention: ${item.filename}: ${state.error}`); }
    }
    if (manifest.completedAt || only) break; await delay(5000);
  }
  const existing = await api('/releases/447251428');
  const original = existing?.assets.find((a: any) => a.id === 755438824);
  if (!original || existing.name !== 'toyota camry 2005 khwyld' || original.name !== 'Camry.2005.-.KHWYLD.zip' || original.size !== 45172052 || original.digest !== 'sha256:581e2e5a0952b6caac42e3ace6131a7057f6a2f372a989e9b3f34bbc9ffe0ead') throw new Error('The protected baseline could not be verified.');
  console.log(JSON.stringify({ published: Object.values(journal).filter((s: any) => s.status === 'published').length, failed: Object.values(journal).filter((s: any) => s.status === 'failed').length, existingReleaseUnchanged: true }));
}
try { await run(); } finally { await lock.close(); await unlink(lockPath); }
