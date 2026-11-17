import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index';
import { readConfig } from '../server/config';
import { HubError, metadataSchema } from '../shared/schema';
import type { DiscordProvider } from '../server/auth';
import { fileHash } from '../desktop/installer';
import { temporary, cleanup, zipFile } from './fixtures';

const owner = '123456789012345678', visitor = '234567890123456789';
let folder = '', member = true, roles = ['access'], identity = owner;
let server: Awaited<ReturnType<typeof createApp>>;
const discord: DiscordProvider = {
  async exchange() { return { access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600 }; },
  async refresh() { return { access_token: 'test-access-token-new', refresh_token: 'test-refresh-token-new', expires_in: 3600 }; },
  async identity() { return { id: identity, username: 'Member', global_name: 'Member', avatar: null }; },
  async membership() { if (!member) throw new HubError('NOT_A_MEMBER', 'Join Team Razka first.', 403); return { roles }; },
  async revoke() {},
};
async function login(userId = owner) {
  identity = userId;
  const start = (await server.app.inject('/api/v1/auth/discord/start')).json();
  const state = new URL(start.authorizeUrl).searchParams.get('state');
  const callback = await server.app.inject({ url: '/api/v1/auth/discord/callback', query: { code: 'test-code', state: state! } });
  const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/desktop/exchange', payload: { pollToken: start.pollToken } });
  return { callback, exchange, start, headers: { authorization: `Bearer ${exchange.json().token}` } };
}
beforeEach(async () => {
  folder = await temporary(); member = true; roles = ['access']; identity = owner;
  const config = readConfig({ DATA_DIR: folder, SESSION_SECRET: 'a'.repeat(48), DISCORD_CLIENT_ID: '345678901234567890', DISCORD_CLIENT_SECRET: 'test-client-secret', DISCORD_BOT_TOKEN: 'test-bot-token', DISCORD_GUILD_ID: '456789012345678901', DISCORD_REQUIRED_ROLE_ID: 'access', ADMIN_DISCORD_IDS: owner });
  server = await createApp({ config, discord, quiet: true });
});
afterEach(async () => { await server.app.close(); await cleanup(folder); });

describe('Discord access control', () => {
  it('requires a session for every catalog, media, download and owner route', async () => {
    const id = randomUUID();
    const routes = [
      ['GET', '/api/v1/mods'], ['GET', '/api/v1/mods/favorites'], ['GET', `/api/v1/mods/${id}`], ['GET', `/api/v1/mods/${id}/versions`], ['GET', '/api/v1/announcements'], ['GET', `/api/v1/media/${id}`],
      ['POST', `/api/v1/mods/${id}/download-ticket`], ['GET', `/api/v1/downloads/${id}/file`], ['POST', `/api/v1/downloads/${id}/complete`],
      ['GET', '/api/v1/admin/stats'], ['GET', '/api/v1/admin/mods'], ['PATCH', `/api/v1/admin/mods/${id}`], ['DELETE', `/api/v1/admin/mods/${id}`],
      ['POST', '/api/v1/admin/uploads/init'], ['GET', `/api/v1/admin/uploads/${id}`], ['POST', `/api/v1/admin/uploads/${id}/cancel`], ['PUT', `/api/v1/admin/uploads/${id}/file`],
      ['GET', '/api/v1/admin/media'], ['POST', '/api/v1/admin/media'], ['GET', '/api/v1/admin/audit'], ['GET', '/api/v1/admin/storage'], ['GET', '/api/v1/admin/imports/github'], ['GET', '/api/v1/admin/announcements'], ['POST', '/api/v1/admin/announcements'],
    ];
    for (const [method, url] of routes) {
      const response = await server.app.inject({ method: method as 'GET', url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await server.app.inject('/api/v1/config/public')).json().name).toBe('TEAM RAZKA PROGRAM');
    expect((await server.app.inject('/api/v1/auth/local')).statusCode).toBe(404);
  });
  it('uses a single-use OAuth exchange and exposes no provider credentials', async () => {
    const result = await login(); expect(result.callback.statusCode).toBe(200);
    expect(result.callback.body).toContain('Team Razka Program');
    const me = await server.app.inject({ url: '/api/v1/auth/me', headers: result.headers });
    expect(me.statusCode).toBe(200); expect(me.json()).toMatchObject({ id: owner, admin: true, mode: 'discord' });
    expect(me.body).not.toContain('test-access-token'); expect(me.body).not.toContain('test-refresh-token'); expect(me.body).not.toContain('sessionHash');
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/auth/desktop/exchange', payload: { pollToken: result.start.pollToken } })).statusCode).toBe(401);
  });
  it('does not issue sessions to non-members or members without the required role', async () => {
    member = false; const nonmember = await login(); expect(nonmember.callback.statusCode).toBe(403); expect(nonmember.exchange.statusCode).toBe(403);
    expect(server.store.get('SELECT count(*) n FROM sessions')?.n).toBe(0);
    member = true; roles = []; const missingRole = await login(); expect(missingRole.exchange.json().error.code).toBe('ROLE_REQUIRED');
    expect(server.store.get('SELECT count(*) n FROM sessions')?.n).toBe(0);
  });
  it('revokes sessions after a failed membership recheck and blocks owner actions for normal members', async () => {
    const result = await login(visitor);
    expect((await server.app.inject({ url: '/api/v1/admin/stats', headers: result.headers })).statusCode).toBe(403);
    member = false;
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/auth/recheck-membership', headers: result.headers })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/v1/mods', headers: result.headers })).statusCode).toBe(401);
  });
  it('automatically checks membership again after one minute and revokes all sessions for a removed member', async () => {
    const first = await login(visitor), second = await login(visitor);
    server.store.run('UPDATE users SET verified_at=? WHERE id=?', Date.now() - 61000, visitor); member = false;
    expect((await server.app.inject({ url: '/api/v1/mods', headers: first.headers })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/v1/mods', headers: second.headers })).statusCode).toBe(401);
  });
  it('rejects forged OAuth state and disallowed origins', async () => {
    const callback = await server.app.inject({ url: '/api/v1/auth/discord/callback', query: { code: 'test-code', state: 'forged-state-that-was-not-issued' } });
    expect(callback.statusCode).toBe(400); expect(server.store.get('SELECT count(*) n FROM sessions')?.n).toBe(0);
    const origin = await server.app.inject({ url: '/api/v1/mods', headers: { origin: 'https://untrusted.example' } });
    expect(origin.statusCode).toBe(403);
  });
});

describe('real upload and download flow', () => {
  it('removes the stored object and refuses publication if owner membership is lost during an upload', async () => {
    const auth = await login(); const source = path.join(folder, 'source.zip'); await zipFile(source);
    const bytes = await readFile(source), sha256 = await fileHash(source);
    const input = { metadata: metadataSchema.parse({ name: 'Test', creator: 'Creator', type: 'car' }), filename: 'Test.zip', size: bytes.length, sha256, distributionConfirmed: true, publish: true };
    const init = (await server.app.inject({ method: 'POST', url: '/api/v1/admin/uploads/init', headers: auth.headers, payload: input })).json();
    const put = server.storage.put.bind(server.storage);
    server.storage.put = async (...args) => { const key = await put(...args); member = false; return key; };
    const response = await server.app.inject({ method: 'PUT', url: init.path, headers: { ...auth.headers, 'content-type': 'application/zip' }, payload: bytes });
    expect(response.statusCode).toBe(403); expect(server.store.get('SELECT count(*) n FROM mods')?.n).toBe(0);
    expect(await readdir(path.join(folder, 'objects'))).toEqual([]);
  });
  it('preserves names, scans a real ZIP, binds downloads to the user session and counts completion once', async () => {
    const auth = await login();
    const source = path.join(folder, 'source.zip'); await zipFile(source);
    const bytes = await readFile(source), sha256 = await fileHash(source);
    const filename = 'Toyota Camry 2005 - KHWYLD.zip';
    const metadata = metadataSchema.parse({ name: 'Toyota Camry 2005 - KHWYLD', creator: 'KHWYLD', type: 'car' });
    const init = await server.app.inject({ method: 'POST', url: '/api/v1/admin/uploads/init', headers: auth.headers, payload: { metadata, filename, size: bytes.length, sha256, version: '1', publish: true, distributionConfirmed: true } });
    expect(init.statusCode).toBe(200);
    const uploaded = await server.app.inject({ method: 'PUT', url: init.json().path, headers: { ...auth.headers, 'content-type': 'application/zip' }, payload: bytes });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const mod = uploaded.json().mod;
    expect(mod.name).toBe(metadata.name); expect(mod.creator).toBe('KHWYLD'); expect(mod.activeVersion.filename).toBe(filename);
    expect(JSON.stringify(mod)).not.toContain('storage_key');
    const ticket = (await server.app.inject({ method: 'POST', url: `/api/v1/mods/${mod.id}/download-ticket`, headers: auth.headers })).json();
    const other = await login(visitor);
    expect((await server.app.inject({ url: ticket.path, headers: other.headers })).statusCode).toBe(401);
    const download = await server.app.inject({ url: ticket.path, headers: auth.headers });
    expect(download.statusCode).toBe(200); expect(download.rawPayload.equals(bytes)).toBe(true);
    expect(download.headers['content-disposition']).toContain(encodeURIComponent(filename));
    const complete = { method: 'POST' as const, url: `/api/v1/downloads/${ticket.id}/complete`, headers: auth.headers, payload: { result: 'completed', sha256 } };
    expect((await server.app.inject(complete)).statusCode).toBe(200); expect((await server.app.inject(complete)).statusCode).toBe(200);
    expect(server.store.requireMod(mod.id).downloads).toBe(1);
    const duplicate = await server.app.inject({ method: 'POST', url: '/api/v1/admin/uploads/init', headers: auth.headers, payload: { metadata, filename: 'Renamed file.zip', size: bytes.length, sha256, distributionConfirmed: true } });
    expect(duplicate.statusCode).toBe(409); expect(duplicate.json().error.code).toBe('DUPLICATE_MOD');
    const favorites = await server.app.inject({ url: '/api/v1/mods/favorites', query: { ids: mod.id, q: 'KHWYLD' }, headers: auth.headers });
    expect(favorites.json().items.map((item: { id: string }) => item.id)).toEqual([mod.id]);
  });
});
