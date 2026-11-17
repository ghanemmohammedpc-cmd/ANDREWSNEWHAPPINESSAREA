import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileHash } from '../desktop/installer';
import { validateArchive } from '../server/archive';
import { idSchema, safeFilename } from '../shared/schema';

const origin = new URL(process.env.PROGRAM_API_ORIGIN || '').origin;
const uploadId = idSchema.parse(process.env.UPLOAD_ID);
const repository = process.env.GITHUB_REPOSITORY || '';
const token = process.env.GITHUB_TOKEN || '', callback = process.env.PUBLISH_CALLBACK_SECRET || '';
if (!origin.startsWith('https://') || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token || !callback) throw new Error('Publisher configuration is incomplete.');
const authHeaders = { authorization: `Bearer ${token}`, 'user-agent': 'TeamRazkaProgram', accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10' };
async function api(endpoint: string, method = 'GET', body?: unknown) {
  const r = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, { method, headers: { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`GitHub request failed (${r.status}).`);
  return r.status === 204 ? null : r.json();
}
async function report(payload: unknown) {
  const r = await fetch(`${origin}/api/v1/publish/${uploadId}`, { method: 'POST', headers: { authorization: `Bearer ${callback}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Publication confirmation failed (${r.status}).`);
}
async function download(assetId: string) {
  let url = `https://api.github.com/repos/${repository}/releases/assets/${assetId}`;
  for (let n = 0; n < 6; n++) {
    const host = new URL(url).hostname;
    if (!['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(host)) throw new Error('Unsupported asset download address.');
    const response = await fetch(url, { headers: host === 'api.github.com' ? { ...authHeaders, accept: 'application/octet-stream' } : {}, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { await response.body?.cancel(); url = new URL(response.headers.get('location')!, url).toString(); continue; }
    if (!response.ok || !response.body || response.headers.get('content-type')?.includes('application/json')) throw new Error(`Asset download failed (${response.status}).`);
    return response.body;
  }
  throw new Error('Too many asset redirects.');
}
async function run() {
  const r = await fetch(`${origin}/api/v1/publish/${uploadId}`, { headers: { authorization: `Bearer ${callback}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('The upload could not be loaded.');
  const job = await r.json() as any;
  if (job.repository !== repository) throw new Error('The repository does not match.');
  safeFilename(job.filename);
  const release = await api(`/releases/${job.releaseId}`);
  if (!release.draft || release.tag_name !== `upload-${uploadId}`) throw new Error('Only the new draft created for this upload can be changed.');
  const folder = path.join(process.env.RUNNER_TEMP || '.publish', uploadId); await mkdir(folder, { recursive: true });
  const file = path.join(folder, job.filename); let bytes = 0;
  for (let n = 0; n < job.parts.length; n++) {
    const part = job.parts[n]; if (part.part_index !== n || !/^\d+$/.test(part.asset_id)) throw new Error('The upload parts are incomplete.');
    const partFile = path.join(folder, `part-${n}`);
    await pipeline(Readable.fromWeb(await download(part.asset_id) as any), createWriteStream(partFile, { flags: 'wx' }));
    if ((await stat(partFile)).size !== part.size || await fileHash(partFile) !== part.sha256) throw new Error('An upload part failed checksum verification.');
    await pipeline(createReadStream(partFile), createWriteStream(file, { flags: n ? 'a' : 'wx' })); bytes += part.size;
  }
  if (bytes !== job.size || await fileHash(file) !== job.sha256) throw new Error('The assembled ZIP failed checksum verification.');
  await validateArchive(file);
  const result = await fetch(`https://uploads.github.com/repos/${repository}/releases/${job.releaseId}/assets?name=${encodeURIComponent(job.filename)}&label=${encodeURIComponent(job.filename)}`, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/zip', 'content-length': String(bytes) }, body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(600000) } as any);
  if (!result.ok) throw new Error(`ZIP publication failed (${result.status}).`);
  const asset = await result.json() as any;
  if ((asset.name !== job.filename && asset.label !== job.filename) || asset.digest !== `sha256:${job.sha256}`) throw new Error('GitHub asset verification failed.');
  const current = await fetch(`${origin}/api/v1/publish/${uploadId}`, { headers: { authorization: `Bearer ${callback}` }, signal: AbortSignal.timeout(30000) });
  if (!current.ok) throw new Error('The upload was cancelled or is no longer awaiting publication.');
  await api(`/releases/${job.releaseId}`, 'PATCH', { draft: false });
  await report({ status: 'completed', assetId: String(asset.id) });
  for (const part of job.parts) {
    if (!release.assets.some((a: any) => String(a.id) === part.asset_id && a.name === `part-${String(part.part_index).padStart(6, '0')}`)) continue;
    await api(`/releases/assets/${part.asset_id}`, 'DELETE').catch(() => {});
  }
  console.log('Published the verified ZIP with its original filename and release title.');
}
run().catch(async error => { await report({ status: 'failed', errorCode: 'PUBLISH_FAILED' }).catch(() => {}); console.error(error instanceof Error ? error.message : 'Publication failed.'); process.exitCode = 1; });
