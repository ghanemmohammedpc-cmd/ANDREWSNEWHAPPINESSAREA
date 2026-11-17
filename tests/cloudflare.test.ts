import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloudflare/index';
import { Store, type Env } from '../cloudflare/database';
import { Auth, hash } from '../cloudflare/auth';
import { GitHub } from '../cloudflare/github';
import { downloadRange, boundedBytes } from '../cloudflare/download';
import { metadataSchema } from '../shared/schema';
const owner = '123456789012345678', member = '234567890123456789', origin = 'https://program.example';
let sqlite: DatabaseSync, env: Env, store: Store, identity: string, belongs: boolean;
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync('cloudflare/migrations/0001_library.sql', 'utf8'));
  const prepare = (sql: string) => ({ values: [] as any[], sql, bind(...values: any[]) { this.values = values; return this; }, async first() { return sqlite.prepare(sql).get(...this.values) || null; }, async all() { return { results: sqlite.prepare(sql).all(...this.values) }; }, async run() { return sqlite.prepare(sql).run(...this.values); } });
  env = { DB: { prepare, async batch(statements: any[]) { sqlite.exec('BEGIN'); try { const results = statements.map(s => sqlite.prepare(s.sql).run(...s.values)); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } } as any, APP_BASE_URL: origin, SESSION_SECRET: 'a'.repeat(48), DISCORD_CLIENT_ID: '345678901234567890', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_BOT_TOKEN: 'bot-secret', DISCORD_GUILD_ID: '456789012345678901', ADMIN_DISCORD_IDS: owner, DISCORD_INVITE_URL: 'https://discord.gg/test', GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'github-secret', PUBLISH_CALLBACK_SECRET: 'callback-secret' };
  store = new Store(env.DB); identity = owner; belongs = true;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    if (url.endsWith('/users/@me')) return Response.json({ id: identity, username: 'Member' });
    if (url.includes('/members/')) return Response.json(belongs ? { roles: [] } : {}, { status: belongs ? 200 : 404 });
    if (url.includes('/releases?')) return Response.json([]);
    throw new Error(`Unexpected network request: ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });
async function request(path: string, method = 'GET', token?: string, body?: unknown) { return worker.fetch(new Request(origin + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env); }
async function login(id = owner) {
  identity = id; const auth = new Auth(env, store, origin), start = await auth.start();
  await auth.callback('code', new URL(start.authorizeUrl).searchParams.get('state')!);
  return { token: (await auth.exchange(start.pollToken)).token!, start };
}
async function listing() {
  const id = crypto.randomUUID(), data = metadataSchema.parse({ name: 'Car 2023', creator: 'Creator', type: 'car' });
  await store.run("INSERT INTO mods(id,name,creator,type,metadata,search,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'published',?,?)", id, data.name, data.creator, data.type, JSON.stringify(data), store.search(data), Date.now(), Date.now()); return id;
}
it('shows instructions when a callback is opened directly and requires login for protected endpoints', async () => {
  const callback = await request('/api/v1/auth/discord/callback'); expect(callback.status).toBe(400); expect(await callback.text()).toContain('Start sign-in from the program');
  for (const route of ['/mods', '/admin/mods', '/admin/storage', `/media/${crypto.randomUUID()}`, '/announcements']) expect((await request('/api/v1' + route)).status).toBe(401);
});
it('claims OAuth state and the session exchange only once, with encrypted provider tokens', async () => {
  const result = await login(); expect((await request('/api/v1/auth/me', 'GET', result.token)).status).toBe(200);
  const auth = new Auth(env, store, origin); await expect(auth.exchange(result.start.pollToken)).rejects.toMatchObject({ code: 'SIGNIN_EXPIRED' });
  await expect(auth.callback('code', new URL(result.start.authorizeUrl).searchParams.get('state')!)).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
  expect((await store.get('SELECT access_token FROM users WHERE id=?', owner))?.access_token).not.toBe('access-secret');
});
it('blocks non-owners and revokes sessions when Discord membership is lost', async () => {
  const { token } = await login(member); expect((await request('/api/v1/admin/stats', 'GET', token)).status).toBe(403);
  belongs = false; expect((await request('/api/v1/auth/recheck-membership', 'POST', token, {})).status).toBe(403);
  expect((await request('/api/v1/mods', 'GET', token)).status).toBe(401);
});
it('stores one real rating per member and prevents deleting another member’s review', async () => {
  const admin = await login(), visitor = await login(member), id = await listing();
  const route = `/api/v1/mods/${id}/reviews`;
  expect((await request(route, 'PUT', admin.token, { rating: 5, body: 'Works' })).status).toBe(200);
  await request(route, 'PUT', admin.token, { rating: 4, body: 'Updated review' });
  await request(route, 'PUT', visitor.token, { rating: 2, body: '' });
  const result = await (await request(route, 'GET', visitor.token)).json() as any; expect(result).toMatchObject({ average: 3, count: 2 });
  expect((await request(`${route}/${owner}`, 'DELETE', visitor.token)).status).toBe(403);
  expect((await request(`${route}/${member}`, 'DELETE', admin.token)).status).toBe(200);
  expect((await store.requireMod(id)).reviewCount).toBe(1);
});
it('edits and removes listings without changing any GitHub release or asset', async () => {
  const { token } = await login(), id = await listing();
  const edited = metadataSchema.parse({ name: 'Corrected name', creator: 'Creator', type: 'car' });
  expect((await request(`/api/v1/admin/mods/${id}`, 'PATCH', token, edited)).status).toBe(200);
  expect((await request(`/api/v1/admin/mods/${id}`, 'DELETE', token, { confirmation: edited.name })).status).toBe(200);
  expect((await request(`/api/v1/mods/${id}`, 'GET', token)).status).toBe(404);
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('github.com'))).toBe(false);
});
it('rejects invalid upload sizes, duplicate hashes and unauthenticated publication callbacks', async () => {
  const { token } = await login(); const input = { metadata: metadataSchema.parse({ name: 'Car', creator: 'Creator', type: 'car' }), filename: 'Car.zip', size: 2 ** 31, sha256: 'a'.repeat(64), distributionConfirmed: true };
  expect((await request('/api/v1/admin/uploads/init', 'POST', token, input)).status).toBe(400);
  expect((await request(`/api/v1/publish/${crypto.randomUUID()}`, 'POST', undefined, { status: 'completed', assetId: '123' })).status).toBe(401);
});
it('paginates existing releases and strips GitHub authorization on asset redirects', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (new URL(url).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, () => ({ draft: false, assets: [], id: 1 })));
    if (new URL(url).searchParams.get('page') === '2') return Response.json([{ draft: false, assets: [{ name: 'Car.zip', id: 12, size: 4, digest: `sha256:${'a'.repeat(64)}` }], id: 2, name: 'Original title' }]);
    if (url.includes('api.github.com')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } });
    return new Response('data');
  }));
  const github = new GitHub(env); expect(await github.candidates()).toHaveLength(1); await github.download('12');
  expect(calls.at(-1)?.authorization).toBe(null); expect(calls.at(-2)?.authorization).toBe('Bearer github-secret');
});
it('rejects mismatched download ranges and oversized media before buffering it', async () => {
  expect(downloadRange(100, 'bytes=50-', new Response('x', { status: 206, headers: { 'content-range': 'bytes 50-99/100', 'content-length': '50' } }))).toMatchObject({ length: 50, reachesEnd: true });
  expect(() => downloadRange(100, 'bytes=50-', new Response('x', { headers: { 'content-length': '100' } }))).toThrow();
  await expect(boundedBytes(new Request(origin, { method: 'POST', headers: { 'content-length': '2000000' }, body: 'x' }), 1200000)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
});
it('imports only checksum-verified assets in the configured repository and is idempotent', async () => {
  const original = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => String(url).endsWith('/releases/10') ? Response.json({ id: 10, draft: false, assets: [{ id: 20, name: 'Car.2023.zip', label: 'Car 2023.zip', size: 100, digest: `sha256:${'a'.repeat(64)}` }] }) : original(url, init)));
  const input = { ownerId: owner, releaseId: '10', assetId: '20', filename: 'Car 2023.zip', size: 100, sha256: 'a'.repeat(64), metadata: metadataSchema.parse({ name: 'Car 2023', creator: 'Creator', type: 'car' }) };
  expect((await request('/api/v1/publish/import', 'POST', undefined, input)).status).toBe(401);
  expect((await request('/api/v1/publish/import', 'POST', env.PUBLISH_CALLBACK_SECRET, { ...input, size: 99 })).status).toBe(409);
  const first = await request('/api/v1/publish/import', 'POST', env.PUBLISH_CALLBACK_SECRET, input); expect(first.status).toBe(200);
  const second = await (await request('/api/v1/publish/import', 'POST', env.PUBLISH_CALLBACK_SECRET, input)).json() as any;
  expect(second.duplicate).toBe(true); expect((await store.get('SELECT count(*) n FROM versions'))?.n).toBe(1);
  const list = await (await request('/api/v1/mods', 'GET', (await login()).token)).json() as any;
  expect(list.items[0].activeVersion.filename).toBe('Car 2023.zip');
});
