import { HubError, safeFilename } from '../shared/schema';
import type { Env } from './database';
export const chunkSize = 32 * 1024 * 1024;
export class GitHub {
  constructor(public env: Env) { if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) throw new HubError('STORAGE_NOT_CONFIGURED', 'GitHub is not configured.', 503); }
  headers(extra: Record<string, string> = {}) { return { accept: 'application/vnd.github+json', authorization: `Bearer ${this.env.GITHUB_TOKEN}`, 'x-github-api-version': '2026-03-10', 'user-agent': 'TeamRazkaProgram', ...extra }; }
  async request(path: string, init: RequestInit = {}) {
    if (path !== '' && !path.startsWith('/') || path.includes('..')) throw new HubError('INVALID_ASSET', 'Unsupported GitHub request.');
    const r = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}${path}`, { ...init, headers: this.headers(Object.fromEntries(new Headers(init.headers))), redirect: 'error', signal: init.signal || AbortSignal.timeout(25000) });
    if (!r.ok) throw new HubError('STORAGE_UNAVAILABLE', `GitHub could not complete this request (${r.status}).`, 502);
    return r;
  }
  async json(path: string, method = 'GET', body?: unknown): Promise<any> {
    const r = await this.request(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return r.status === 204 ? null : r.json();
  }
  async candidates() {
    const releases = [];
    for (let page = 1; page <= 100; page++) { const batch = await this.json(`/releases?per_page=100&page=${page}`); releases.push(...batch); if (batch.length < 100) break; }
    return releases.filter((r: any) => !r.draft).flatMap((release: any) => release.assets.filter((a: any) => a.name.toLowerCase().endsWith('.zip')).map((a: any) => ({ assetId: a.id, releaseId: release.id, filename: a.name, size: a.size, sha256: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : null, releaseTitle: release.name || release.tag_name })));
  }
  async createUpload(id: string, title: string, description: string) { return this.json('/releases', 'POST', { tag_name: `upload-${id}`, name: title, body: description, draft: true, prerelease: false }); }
  async uploadPart(releaseId: string, index: number, body: ReadableStream<Uint8Array>, size: number) {
    const name = `part-${String(index).padStart(6, '0')}`;
    const r = await fetch(`https://uploads.github.com/repos/${this.env.GITHUB_REPOSITORY}/releases/${releaseId}/assets?name=${name}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/octet-stream', 'content-length': String(size) }), body, duplex: 'half', redirect: 'error' } as RequestInit);
    if (!r.ok) throw new HubError('STORAGE_UNAVAILABLE', `GitHub did not accept this upload part (${r.status}).`, 502);
    return r.json() as Promise<{ id: number; size: number; digest?: string }>;
  }
  async dispatch(id: string) { await this.json('/actions/workflows/publish-mod.yml/dispatches', 'POST', { ref: 'main', inputs: { upload_id: id } }); }
  async asset(id: string) {
    if (!/^\d+$/.test(id)) throw new HubError('INVALID_ASSET', 'Invalid asset identifier.');
    const asset = await this.json(`/releases/assets/${id}`); safeFilename(asset.name); return asset;
  }
  async download(id: string, range?: string) {
    if (!/^\d+$/.test(id)) throw new HubError('INVALID_ASSET', 'Invalid asset identifier.');
    let url = `https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/releases/assets/${id}`;
    for (let i = 0; i < 6; i++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new HubError('UNSAFE_DOWNLOAD', 'GitHub returned an unsupported download address.', 502);
      const headers: Record<string, string> = parsed.hostname === 'api.github.com' ? this.headers({ accept: 'application/octet-stream' }) : { 'user-agent': 'TeamRazkaProgram' };
      if (range) headers.range = range;
      const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { await r.body?.cancel(); url = new URL(r.headers.get('location')!, url).toString(); continue; }
      if (!r.ok || !r.body || r.headers.get('content-type')?.includes('application/json')) throw new HubError('STORAGE_UNAVAILABLE', 'GitHub could not stream the file.', 502);
      return r;
    }
    throw new HubError('STORAGE_UNAVAILABLE', 'GitHub returned too many redirects.', 502);
  }
}
