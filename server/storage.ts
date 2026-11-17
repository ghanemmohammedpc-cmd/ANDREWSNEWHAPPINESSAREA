import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createSign, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { Config } from './config';
import { HubError } from '../shared/schema';

export type StoredStream = { stream: Readable; size: number; total: number; status: number; contentRange?: string };
export interface Storage {
  kind: string;
  put(file: string, key: string, filename: string, progress?: (bytes: number) => void, signal?: AbortSignal): Promise<string>;
  open(key: string, range?: string): Promise<StoredStream>;
  remove(key: string): Promise<void>;
  check(): Promise<{ available: boolean; uploads: boolean; visibility: string }>;
}
export function parseRange(range: string | undefined, size: number) {
  if (!range) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) throw new HubError('INVALID_RANGE', 'This download range is not supported.', 416);
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) throw new HubError('INVALID_RANGE', 'This download range is outside the file.', 416);
  return { start, end };
}
export class LocalStorage implements Storage {
  kind = 'local';
  constructor(public folder: string) {}
  private target(key: string) {
    if (!/^[a-f0-9-]{36}\.zip$/.test(key)) throw new HubError('INVALID_ASSET', 'This storage asset is not valid.');
    return path.join(this.folder, key);
  }
  async put(file: string, key: string, _filename?: string, progress?: (bytes: number) => void, signal?: AbortSignal) {
    signal?.throwIfAborted(); await mkdir(this.folder, { recursive: true }); const target = this.target(key);
    const input = createReadStream(file); let bytes = 0; input.on('data', chunk => { bytes += chunk.length; progress?.(bytes); });
    let owned = false; const output = createWriteStream(target, { flags: 'wx' }); output.once('open', () => { owned = true; });
    try { await pipeline(input, output, { signal }); return key; }
    catch (error) { if (owned) await unlink(target).catch(() => {}); throw error; }
  }
  async open(key: string, range?: string) {
    const file = this.target(key), info = await stat(file).catch(() => { throw new HubError('ASSET_MISSING', 'This file is no longer available.', 404); });
    const selected = parseRange(range, info.size);
    return { stream: createReadStream(file, selected || {}), total: info.size, size: selected ? selected.end - selected.start + 1 : info.size, status: selected ? 206 : 200, contentRange: selected ? `bytes ${selected.start}-${selected.end}/${info.size}` : undefined };
  }
  async remove(key: string) { await unlink(this.target(key)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
  async check() { await mkdir(this.folder, { recursive: true }); return { available: true, uploads: true, visibility: 'private-server-storage' }; }
}
const githubHeaders = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'TeamRazkaProgram' };
export class GithubStorage implements Storage {
  kind = 'github-releases'; private token = ''; private expires = 0;
  constructor(private config: Config) { if (!/^[\w.-]+\/[\w.-]+$/.test(config.githubRepository)) throw new Error('GITHUB_REPOSITORY is not valid.'); }
  async credential() {
    if (this.token && this.expires > Date.now() + 60000) return this.token;
    const c = this.config;
    if (!c.githubAppId || !c.githubInstallationId || !c.githubPrivateKeyPath) throw new HubError('STORAGE_NOT_CONFIGURED', 'The owner needs to connect GitHub uploads.', 503);
    const now = Math.floor(Date.now() / 1000), head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: c.githubAppId })).toString('base64url');
    const signer = createSign('RSA-SHA256'); signer.update(`${head}.${body}`); const signature = signer.sign(readFileSync(c.githubPrivateKeyPath)).toString('base64url');
    const response = await fetch(`https://api.github.com/app/installations/${c.githubInstallationId}/access_tokens`, { method: 'POST', headers: { ...githubHeaders, authorization: `Bearer ${head}.${body}.${signature}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new HubError('STORAGE_UNAVAILABLE', 'GitHub could not authorize the upload.', 502);
    const data = await response.json() as any; this.token = data.token; this.expires = Date.parse(data.expires_at); return this.token;
  }
  async request(endpoint: string, options: RequestInit = {}, privileged = true) {
    const response = await fetch(`https://api.github.com/repos/${this.config.githubRepository}${endpoint}`, { ...options, headers: { ...githubHeaders, ...(privileged ? { authorization: `Bearer ${await this.credential()}` } : {}), ...(options.headers || {}) }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new HubError('STORAGE_UNAVAILABLE', `GitHub could not complete the request (${response.status}).`, 502);
    return response;
  }
  async candidates() {
    const releases = await (await this.request('/releases?per_page=100', {}, false)).json() as any[];
    return releases.flatMap(release => release.assets.filter((asset: any) => asset.name.toLowerCase().endsWith('.zip')).map((asset: any) => ({ assetId: asset.id, releaseId: release.id, filename: asset.name, size: asset.size, sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null, releaseTitle: release.name || release.tag_name })));
  }
  async put(file: string, key: string, filename: string, progress?: (bytes: number) => void, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const info = await stat(file);
    if (info.size >= 2 * 1024 ** 3) throw new HubError('FILE_TOO_LARGE', 'GitHub release assets must be smaller than 2 GiB.');
    const tag = `mod-${key.replace(/\.zip$/, '')}`;
    const release = await (await this.request('/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag_name: tag, name: filename.replace(/\.zip$/i, ''), draft: false, prerelease: false }) })).json() as any;
    try {
      signal?.throwIfAborted(); const stream = createReadStream(file); let bytes = 0; stream.on('data', chunk => { bytes += chunk.length; progress?.(bytes); });
      const url = new URL(`https://uploads.github.com/repos/${this.config.githubRepository}/releases/${release.id}/assets`); url.searchParams.set('name', filename);
      const response = await fetch(url, { method: 'POST', headers: { ...githubHeaders, authorization: `Bearer ${await this.credential()}`, 'content-type': 'application/zip', 'content-length': String(info.size) }, body: stream as any, duplex: 'half', signal } as any);
      if (!response.ok) throw new HubError('STORAGE_UNAVAILABLE', 'GitHub did not accept the ZIP upload.', 502);
      const asset = await response.json() as any; return `github:${asset.id}`;
    } catch (error) {
      await this.request(`/releases/${release.id}`, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }
  async open(key: string, range?: string) {
    const id = /^github:(\d+)$/.exec(key)?.[1]; if (!id) throw new HubError('INVALID_ASSET', 'The storage asset is not valid.');
    const asset = await (await this.request(`/releases/assets/${id}`, {}, false)).json() as any;
    const total = Number(asset.size), selected = parseRange(range, total); let url = asset.browser_download_url as string;
    let response: Response | undefined;
    for (let step = 0; step < 6; step++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new HubError('UNSAFE_DOWNLOAD', 'The storage provider returned an unsupported download address.', 502);
      response = await fetch(url, { headers: selected ? { range: `bytes=${selected.start}-${selected.end}` } : {}, redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { url = new URL(response.headers.get('location')!, url).toString(); continue; }
      break;
    }
    if (!response?.ok || !response.body || selected && response.status !== 206) throw new HubError('STORAGE_UNAVAILABLE', 'The mod file could not be downloaded.', 502);
    return { stream: Readable.fromWeb(response.body as any), total, size: Number(response.headers.get('content-length') || (selected ? selected.end - selected.start + 1 : total)), status: response.status, contentRange: response.headers.get('content-range') || undefined };
  }
  async remove(key: string) { const id = /^github:(\d+)$/.exec(key)?.[1]; if (!id) throw new HubError('INVALID_ASSET', 'The storage asset is not valid.'); await this.request(`/releases/assets/${id}`, { method: 'DELETE' }); }
  async check() { await this.request('', {}, false); return { available: true, uploads: Boolean(this.config.githubAppId && this.config.githubInstallationId && this.config.githubPrivateKeyPath), visibility: 'public-github-release' }; }
}
export class PrivateStorage implements Storage {
  kind = 's3'; client: S3Client;
  constructor(private config: Config) {
    if (!config.s3Bucket || !config.s3AccessKeyId || !config.s3SecretAccessKey) throw new Error('S3 storage credentials are required.');
    if (config.s3Endpoint && new URL(config.s3Endpoint).protocol !== 'https:') throw new Error('S3_ENDPOINT requires HTTPS.');
    this.client = new S3Client({ endpoint: config.s3Endpoint || undefined, region: config.s3Region, credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }, forcePathStyle: Boolean(config.s3Endpoint) });
  }
  async put(file: string, key: string, _filename: string, progress?: (bytes: number) => void, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const stream = createReadStream(file); let bytes = 0; stream.on('data', chunk => { bytes += chunk.length; progress?.(bytes); });
    await this.client.send(new PutObjectCommand({ Bucket: this.config.s3Bucket, Key: key, Body: stream, ContentLength: (await stat(file)).size, ContentType: 'application/zip' }), { abortSignal: signal }); return key;
  }
  async open(key: string, range?: string) {
    if (range && !/^bytes=\d+-\d*$/.test(range)) throw new HubError('INVALID_RANGE', 'This download range is not supported.', 416);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: key, Range: range }));
    if (!response.Body) throw new HubError('ASSET_MISSING', 'This file is no longer available.', 404);
    const total = response.ContentRange ? Number(response.ContentRange.split('/')[1]) : Number(response.ContentLength);
    return { stream: response.Body as Readable, total, size: Number(response.ContentLength), status: response.ContentRange ? 206 : 200, contentRange: response.ContentRange };
  }
  async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key })); }
  async check() { await this.client.send(new HeadBucketCommand({ Bucket: this.config.s3Bucket })); return { available: true, uploads: true, visibility: 'private-object-storage' }; }
}
export function createStorage(config: Config): Storage {
  if (config.storageDriver === 'github-releases') return new GithubStorage(config);
  if (config.storageDriver === 's3') return new PrivateStorage(config);
  if (config.storageDriver !== 'local') throw new Error('STORAGE_DRIVER must be local, github-releases or s3.');
  return new LocalStorage(path.join(config.dataDir, 'objects'));
}
