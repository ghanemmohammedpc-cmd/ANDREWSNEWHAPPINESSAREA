import { config as loadEnv } from 'dotenv';
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, unlink, statfs } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { HubError, idSchema, metadataSchema, querySchema, safeFilename, uploadSchema, type ModMetadata } from '../shared/schema';
import { readConfig, type Config } from './config';
import { Auth, type DiscordProvider } from './auth';
import { Store } from './store';
import { createStorage, GithubStorage, LocalStorage, PrivateStorage, type Storage } from './storage';
import { validateArchive } from './archive';

const bodyId = (request: FastifyRequest) => idSchema.parse((request.params as any).id);
loadEnv({ quiet: true });
const unlinkTemporary = (file: string) => unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
export async function createApp(options: { config: Config; discord?: DiscordProvider; storage?: Storage; migrationSql?: string; quiet?: boolean }) {
  const config = options.config, store = new Store(config.dataDir, options.migrationSql), auth = new Auth(config, store, options.discord);
  const storage = options.storage || createStorage(config);
  const app = Fastify({ bodyLimit: 1024 * 1024, requestTimeout: 0, logger: options.quiet ? false : { level: 'info', serializers: { req: request => ({ method: request.method, url: request.url.split('?')[0], id: request.id }) } } });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.addContentTypeParser(['application/octet-stream', 'application/zip', 'image/png', 'image/jpeg', 'image/webp'], (_req, payload, done) => done(null, payload));
  app.addHook('onRequest', async request => {
    const origin = request.headers.origin;
    if (origin && origin !== config.baseUrl) throw new HubError('FORBIDDEN_ORIGIN', 'This request is not allowed.', 403);
  });
  app.addHook('onSend', async (_req, reply) => { reply.header('x-content-type-options', 'nosniff'); reply.header('cache-control', 'no-store'); reply.header('referrer-policy', 'no-referrer'); });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof HubError;
    const code = known ? error.code : error instanceof ZodError ? 'INVALID_INPUT' : 'REQUEST_FAILED';
    const status = known ? error.status : error instanceof ZodError ? 400 : (error as any).statusCode === 429 ? 429 : 500;
    if (status >= 500) request.log.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    reply.status(status).send({ error: { code, message: known ? error.message : error instanceof ZodError ? 'Check the entered details.' : status === 429 ? 'Please wait a moment before trying again.' : 'The request could not be completed.', requestId: request.id } });
  });
  const temporaryDir = path.join(config.dataDir, 'temporary'), mediaDir = path.join(config.dataDir, 'media');
  await mkdir(temporaryDir, { recursive: true }); await mkdir(mediaDir, { recursive: true });
  const activeUploads = new Map<string, AbortController>();
  function providerFor(stored: string) {
    const separator = stored.indexOf('|'); const kind = separator < 0 ? storage.kind : stored.slice(0, separator); const key = separator < 0 ? stored : stored.slice(separator + 1);
    const provider = kind === storage.kind ? storage : kind === 'local' ? new LocalStorage(path.join(config.dataDir, 'objects')) : kind === 'github-releases' ? new GithubStorage(config) : kind === 's3' ? new PrivateStorage(config) : null;
    if (!provider) throw new HubError('STORAGE_UNAVAILABLE', 'The storage connection is not available.', 503);
    return { provider, key };
  }
  app.get('/api/v1/health', async () => ({ ok: true }));
  app.get('/api/v1/config/public', async () => ({ name: 'TEAM RAZKA PROGRAM', inviteUrl: config.inviteUrl, discordConfigured: config.discordConfigured, membershipVerification: 'bot', maxUploadBytes: 2 * 1024 ** 3 }));
  app.get('/api/v1/auth/discord/start', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async () => auth.start());
  app.get('/api/v1/auth/discord/callback', async (request, reply) => {
    const query = z.object({ code: z.string().min(1).max(2048), state: z.string().min(20).max(128), iss: z.string().optional() }).parse(request.query);
    try {
      await auth.callback(query.code, query.state, query.iss);
      reply.type('text/html').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'").send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>Team Razka Program</title><body style="background:#101014;color:#f4f2f3;font:18px Tahoma;padding:64px"><h1>تم تسجيل الدخول</h1><p>ارجع لتطبيق Team Razka Program. تقدر تقفل هذه الصفحة.</p></body></html>');
    } catch (error) {
      reply.status(error instanceof HubError ? error.status : 503).type('text/html').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'").send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>Team Razka Program</title><body style="background:#101014;color:#f4f2f3;font:18px Tahoma;padding:64px"><h1>تعذّر التحقق</h1><p>ارجع للتطبيق لمعرفة التفاصيل. تأكد أنك عضو في سيرفر Team Razka.</p></body></html>');
    }
  });
  app.post('/api/v1/auth/desktop/exchange', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async request => auth.exchange(z.object({ pollToken: z.string().min(40).max(100) }).parse(request.body).pollToken));
  app.get('/api/v1/auth/me', async request => { const user = await auth.require(request); const { sessionHash: _hash, authenticatedAt: _at, ...publicUser } = user; return publicUser; });
  app.post('/api/v1/auth/recheck-membership', async request => { const user = await auth.require(request, false, true); const { sessionHash: _hash, authenticatedAt: _at, ...publicUser } = user; return publicUser; });
  app.post('/api/v1/auth/logout', async request => { await auth.logout(request); return { ok: true }; });
  app.get('/api/v1/mods', async request => { await auth.require(request); return store.list(querySchema.parse(request.query)); });
  app.get('/api/v1/mods/brands', async request => { await auth.require(request); return store.all("SELECT DISTINCT trim(coalesce(json_extract(metadata,'$.manufacturer'),'')) brand FROM mods WHERE deleted_at IS NULL AND status='published' AND type='car' ORDER BY brand COLLATE NOCASE").map(row => row.brand); });
  app.get('/api/v1/mods/favorites', async request => {
    await auth.require(request); const query = request.query as Record<string, string>;
    const ids = z.array(idSchema).max(500).parse(query.ids ? query.ids.split(',') : []);
    return store.list(querySchema.parse(query), false, ids);
  });
  app.get('/api/v1/mods/:id', async request => { const user = await auth.require(request); return store.requireMod(bodyId(request), user.admin); });
  app.get('/api/v1/mods/:id/versions', async request => { const user = await auth.require(request); const id = bodyId(request); store.requireMod(id, user.admin); return store.all('SELECT * FROM versions WHERE mod_id=? ORDER BY created_at DESC', id).map(row => store.version(row)); });
  app.post('/api/v1/mods/:id/reports', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const user = await auth.require(request, false, true), id = bodyId(request), mod = store.requireMod(id, user.admin);
    if (mod.type !== 'car') throw new HubError('INVALID_REPORT', 'Select a car to report.');
    const input = z.object({ body: z.string().trim().min(5).max(2000) }).parse(request.body), now = Date.now();
    const previous = store.get("SELECT id FROM reports WHERE mod_id=? AND user_id=? AND status='open'", id, user.id), reportId = previous?.id || randomUUID();
    store.run("INSERT INTO reports VALUES(?,?,?,?,'open',?,?) ON CONFLICT(mod_id,user_id) WHERE status='open' DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at", reportId, id, user.id, input.body, now, now); return { id: reportId, status: 'open' };
  });
  app.get('/api/v1/admin/reports', async request => { await auth.require(request, true); return store.all('SELECT r.*,m.name mod_name,u.name reporter_name FROM reports r JOIN mods m ON m.id=r.mod_id JOIN users u ON u.id=r.user_id ORDER BY r.status ASC,r.updated_at DESC LIMIT 200'); });
  app.patch('/api/v1/admin/reports/:id', async request => {
    const user = await auth.require(request, true, true), id = bodyId(request), input = z.object({ status: z.enum(['open', 'resolved']) }).parse(request.body);
    if (!store.get('SELECT id FROM reports WHERE id=?', id)) throw new HubError('NOT_FOUND', 'The report is not available.', 404);
    store.run('UPDATE reports SET status=?,updated_at=? WHERE id=?', input.status, Date.now(), id); store.audit(user.id, 'review_report', id, { status: input.status }); return { ok: true };
  });
  app.get('/api/v1/mods/:id/reviews', async request => {
    const user = await auth.require(request), id = bodyId(request); store.requireMod(id, user.admin);
    const summary = store.get('SELECT count(*) count,avg(rating) average FROM reviews WHERE mod_id=?', id);
    return { average: summary?.average ?? null, count: Number(summary?.count || 0), items: store.all('SELECT r.user_id AS userId,u.name,r.rating,r.body,r.created_at AS createdAt,r.updated_at AS updatedAt FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.mod_id=? ORDER BY r.updated_at DESC LIMIT 100', id) };
  });
  app.put('/api/v1/mods/:id/reviews', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const user = await auth.require(request, false, true), id = bodyId(request); store.requireMod(id, user.admin);
    const input = z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).default('') }).parse(request.body), now = Date.now();
    store.run('INSERT INTO reviews VALUES(?,?,?,?,?,?) ON CONFLICT(mod_id,user_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,updated_at=excluded.updated_at', id, user.id, input.rating, input.body, now, now); return { ok: true };
  });
  app.delete('/api/v1/mods/:id/reviews/:userId', async request => {
    const user = await auth.require(request, false, true), id = bodyId(request); store.requireMod(id, user.admin);
    const author = z.string().regex(/^\d{15,22}$/).parse((request.params as any).userId);
    if (author !== user.id && !user.admin) throw new HubError('FORBIDDEN', 'You can only remove your own review.', 403);
    store.run('DELETE FROM reviews WHERE mod_id=? AND user_id=?', id, author); return { ok: true };
  });
  app.get('/api/v1/announcements', async request => { await auth.require(request); return store.all('SELECT * FROM announcements WHERE published_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY published_at DESC LIMIT 10', Date.now(), Date.now()); });
  app.get('/api/v1/media/:id', async (request, reply) => {
    await auth.require(request); const media = store.get('SELECT * FROM media WHERE id=?', bodyId(request));
    if (!media) throw new HubError('NOT_FOUND', 'The picture is not available.', 404);
    reply.type(media.mime).header('cache-control', 'private, max-age=3600'); return reply.send(createReadStream(path.join(mediaDir, media.key)));
  });
  app.post('/api/v1/mods/:id/download-ticket', async request => {
    const user = await auth.require(request, false, true); const mod = store.requireMod(bodyId(request), user.admin);
    if (!mod.activeVersion) throw new HubError('ASSET_MISSING', 'This mod has no downloadable file.', 404);
    const ticket = randomUUID(), expiresAt = Date.now() + 30 * 60000;
    store.run('INSERT INTO download_tickets(id,session_hash,user_id,mod_id,version_id,expires_at) VALUES(?,?,?,?,?,?)', ticket, user.sessionHash, user.id, mod.id, mod.activeVersion.id, expiresAt);
    return { id: ticket, expiresAt, path: `/api/v1/downloads/${ticket}/file`, version: mod.activeVersion };
  });
  app.get('/api/v1/downloads/:id/file', async (request, reply) => {
    const user = await auth.require(request); const ticket = store.get('SELECT * FROM download_tickets WHERE id=? AND session_hash=? AND expires_at>? AND completed_at IS NULL', bodyId(request), user.sessionHash, Date.now());
    if (!ticket) throw new HubError('DOWNLOAD_EXPIRED', 'This download expired. Start it again.', 401);
    const version = store.get('SELECT * FROM versions WHERE id=?', ticket.version_id);
    if (!version) throw new HubError('ASSET_MISSING', 'This file is no longer available.', 404);
    const { provider, key } = providerFor(version.storage_key); const asset = await provider.open(key, request.headers.range);
    if (asset.total !== version.size) { asset.stream.destroy(); throw new HubError('ASSET_CHANGED', 'This file changed. Ask the owner to publish a new version.', 409); }
    reply.status(asset.status).type('application/zip').header('content-length', asset.size).header('accept-ranges', 'bytes').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(version.filename)}`);
    if (asset.contentRange) reply.header('content-range', asset.contentRange);
    let bytes = 0; asset.stream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    asset.stream.on('end', () => store.run('UPDATE download_tickets SET transferred_at=?,bytes=bytes+? WHERE id=?', Date.now(), bytes, ticket.id));
    return reply.send(asset.stream);
  });
  app.post('/api/v1/downloads/:id/complete', async request => {
    const user = await auth.require(request); const input = z.object({ result: z.enum(['completed', 'failed', 'cancelled']), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), errorCode: z.string().max(60).optional() }).parse(request.body);
    const ticket = store.get('SELECT t.*,v.sha256 FROM download_tickets t JOIN versions v ON v.id=t.version_id WHERE t.id=? AND t.session_hash=?', bodyId(request), user.sessionHash);
    if (!ticket) throw new HubError('NOT_FOUND', 'The download is not available.', 404);
    if (input.result === 'completed' && (!ticket.transferred_at || input.sha256 !== ticket.sha256)) throw new HubError('CHECKSUM_MISMATCH', 'The downloaded file has not been verified.', 409);
    if (!ticket.completed_at) store.run('UPDATE download_tickets SET result=?,error_code=?,completed_at=? WHERE id=?', input.result, input.errorCode || null, Date.now(), ticket.id);
    return { ok: true };
  });
  app.get('/api/v1/admin/stats', async request => { await auth.require(request, true, true); return store.stats(); });
  app.get('/api/v1/admin/mods', async request => { await auth.require(request, true); return store.list(querySchema.parse(request.query), true); });
  app.patch('/api/v1/admin/mods/:id', async request => {
    const user = await auth.require(request, true, true), id = bodyId(request), metadata = metadataSchema.parse(request.body);
    const result = store.updateMod(id, metadata); store.audit(user.id, 'edit_mod', id); return result;
  });
  app.post('/api/v1/admin/mods/:id/:action', async request => {
    const user = await auth.require(request, true, true); const { id, action } = z.object({ id: idSchema, action: z.enum(['publish', 'unpublish']) }).parse(request.params);
    const mod = store.requireMod(id, true); if (action === 'publish' && !mod.activeVersion) throw new HubError('ASSET_MISSING', 'Upload a ZIP before publishing this mod.');
    store.run('UPDATE mods SET status=?,updated_at=? WHERE id=?', action === 'publish' ? 'published' : 'draft', Date.now(), id); store.audit(user.id, action, id); return store.requireMod(id, true);
  });
  app.delete('/api/v1/admin/mods/:id', async request => {
    const user = await auth.require(request, true, true); const mod = store.requireMod(bodyId(request), true);
    const input = z.object({ confirmation: z.string() }).parse(request.body); if (input.confirmation !== mod.name) throw new HubError('CONFIRMATION_REQUIRED', 'Confirm the mod name before removing the listing.');
    if (Date.now() - user.authenticatedAt > 600000) throw new HubError('REAUTH_REQUIRED', 'Sign in with Discord again before deleting a listing.', 401);
    store.run("UPDATE mods SET deleted_at=?,status='draft',updated_at=? WHERE id=?", Date.now(), Date.now(), mod.id); store.audit(user.id, 'delete_listing', mod.id, { filesRetained: true }); return { ok: true, filesRetained: true };
  });
  app.post('/api/v1/admin/uploads/init', async request => {
    const user = await auth.require(request, true, true); const input = uploadSchema.parse(request.body); safeFilename(input.filename);
    if (store.get('SELECT v.id FROM versions v JOIN mods m ON m.id=v.mod_id WHERE v.sha256=? AND m.deleted_at IS NULL LIMIT 1', input.sha256)) throw new HubError('DUPLICATE_MOD', 'This ZIP is already in the library.', 409);
    if (storage.kind === 'github-releases' && input.size >= 2 * 1024 ** 3) throw new HubError('FILE_TOO_LARGE', 'GitHub release assets must be smaller than 2 GiB.');
    if (input.modId) store.requireMod(input.modId, true);
    if (input.metadata.thumbnailId && !store.get('SELECT id FROM media WHERE id=?', input.metadata.thumbnailId)) throw new HubError('INVALID_IMAGE', 'Select an uploaded thumbnail.');
    const disk = await statfs(config.dataDir); if (disk.bavail * disk.bsize < input.size * 2 + 100 * 1024 ** 2) throw new HubError('DISK_SPACE', 'The server does not have enough free storage.', 507);
    const id = randomUUID(), now = Date.now(); store.run('INSERT INTO uploads(id,owner_id,metadata,status,created_at,updated_at) VALUES(?,?,?,?,?,?)', id, user.id, JSON.stringify(input), 'awaiting', now, now);
    return { id, path: `/api/v1/admin/uploads/${id}/file` };
  });
  app.get('/api/v1/admin/uploads/:id', async request => {
    const user = await auth.require(request, true); const upload = store.get('SELECT * FROM uploads WHERE id=? AND owner_id=?', bodyId(request), user.id);
    if (!upload) throw new HubError('NOT_FOUND', 'This upload is not available.', 404);
    return { id: upload.id, status: upload.status, bytes: upload.bytes, total: JSON.parse(upload.metadata).size, errorCode: upload.error_code, modId: upload.mod_id };
  });
  app.post('/api/v1/admin/uploads/:id/cancel', async request => { const user = await auth.require(request, true); const id = bodyId(request); const upload = store.get('SELECT * FROM uploads WHERE id=? AND owner_id=?', id, user.id); if (!upload) throw new HubError('NOT_FOUND', 'This upload is not available.', 404); activeUploads.get(id)?.abort(); store.run("UPDATE uploads SET status='cancelled',updated_at=? WHERE id=? AND status!='completed'", Date.now(), id); return { ok: true }; });
  app.put('/api/v1/admin/uploads/:id/file', async request => {
    const user = await auth.require(request, true, true), id = bodyId(request); const upload = store.get("SELECT * FROM uploads WHERE id=? AND owner_id=? AND status='awaiting'", id, user.id);
    if (!upload) throw new HubError('INVALID_UPLOAD', 'Start a new upload before sending the ZIP.', 409);
    const input = uploadSchema.parse(JSON.parse(upload.metadata)); const temporary = path.join(temporaryDir, `${id}.part`); const controller = new AbortController(); activeUploads.set(id, controller);
    const digest = createHash('sha256'); let bytes = 0, storageKey = '';
    store.run("UPDATE uploads SET status='transferring',updated_at=? WHERE id=?", Date.now(), id);
    try {
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > input.size) { callback(new HubError('SIZE_MISMATCH', 'The upload is larger than expected.')); return; } digest.update(chunk); store.run('UPDATE uploads SET bytes=?,updated_at=? WHERE id=?', bytes, Date.now(), id); callback(null, chunk); } });
      await pipeline(request.body as Readable, counter, createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal });
      if (bytes !== input.size || digest.digest('hex') !== input.sha256) throw new HubError('CHECKSUM_MISMATCH', 'The uploaded ZIP did not match the selected file.', 409);
      store.run("UPDATE uploads SET status='validating',updated_at=? WHERE id=?", Date.now(), id); await validateArchive(temporary);
      if (controller.signal.aborted) throw new HubError('CANCELLED', 'Upload cancelled.');
      store.run("UPDATE uploads SET status='storing',bytes=0,updated_at=? WHERE id=?", Date.now(), id);
      storageKey = await storage.put(temporary, `${randomUUID()}.zip`, input.filename, count => store.run('UPDATE uploads SET bytes=?,updated_at=? WHERE id=?', count, Date.now(), id), controller.signal);
      if (controller.signal.aborted) { await storage.remove(storageKey); storageKey = ''; throw new HubError('CANCELLED', 'Upload cancelled.'); }
      await auth.require(request, true, true);
      const modId = store.transaction(() => {
        if (store.get('SELECT v.id FROM versions v JOIN mods m ON m.id=v.mod_id WHERE v.sha256=? AND m.deleted_at IS NULL LIMIT 1', input.sha256)) throw new HubError('DUPLICATE_MOD', 'This ZIP is already in the library.', 409);
        const modId = input.modId || store.createMod(input.metadata); if (input.modId) store.updateMod(modId, input.metadata);
        const versionId = randomUUID(); store.run('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?)', versionId, modId, input.version, input.changelog, input.filename, input.size, input.sha256, `${storage.kind}|${storageKey}`, Date.now());
        store.run('UPDATE mods SET active_version=?,status=?,updated_at=? WHERE id=?', versionId, input.publish ? 'published' : 'draft', Date.now(), modId);
        store.run("UPDATE uploads SET status='completed',bytes=?,mod_id=?,updated_at=? WHERE id=?", bytes, modId, Date.now(), id); store.audit(user.id, input.modId ? 'upload_version' : 'upload_mod', modId, { filename: input.filename, size: bytes }); return modId;
      });
      return { mod: store.requireMod(modId, true) };
    } catch (error) {
      if (storageKey) await storage.remove(storageKey).catch(() => {});
      store.run('UPDATE uploads SET status=?,error_code=?,updated_at=? WHERE id=?', controller.signal.aborted ? 'cancelled' : 'failed', error instanceof HubError ? error.code : 'UPLOAD_FAILED', Date.now(), id); throw error;
    } finally { activeUploads.delete(id); await unlinkTemporary(temporary); }
  });
  app.post('/api/v1/admin/media', async request => {
    const user = await auth.require(request, true, true), id = randomUUID(), temporary = path.join(temporaryDir, `${id}.image`); let bytes = 0;
    try {
      await pipeline(request.body as Readable, new Transform({ transform(chunk: Buffer, _encoding, cb) { bytes += chunk.length; cb(bytes > 10 * 1024 ** 2 ? new HubError('IMAGE_TOO_LARGE', 'The picture must be smaller than 10 MB.') : null, chunk); } }), createWriteStream(temporary, { flags: 'wx' }));
      const key = `${id}.webp`; const image = sharp(temporary, { limitInputPixels: 40000000 }).rotate().resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 });
      const info = await image.toFile(path.join(mediaDir, key)); store.run('INSERT INTO media VALUES(?,?,?,?,?,?,?)', id, key, 'image/webp', info.width, info.height, user.id, Date.now()); store.audit(user.id, 'upload_image', id); return { id, width: info.width, height: info.height };
    } finally { await unlinkTemporary(temporary); }
  });
  app.get('/api/v1/admin/media', async request => { await auth.require(request, true); return store.all('SELECT id,width,height,created_at FROM media ORDER BY created_at DESC LIMIT 200'); });
  app.get('/api/v1/admin/audit', async request => { await auth.require(request, true); return store.all('SELECT id,actor_id,action,target_id,detail,created_at FROM audit ORDER BY created_at DESC LIMIT 200'); });
  app.get('/api/v1/admin/announcements', async request => { await auth.require(request, true); return store.all('SELECT * FROM announcements ORDER BY published_at DESC'); });
  app.post('/api/v1/admin/announcements', async request => {
    const user = await auth.require(request, true, true); const input = z.object({ title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(2000), expiresAt: z.number().int().positive().nullable().default(null) }).parse(request.body);
    const id = randomUUID(); store.run('INSERT INTO announcements VALUES(?,?,?,?,?)', id, input.title, input.body, Date.now(), input.expiresAt); store.audit(user.id, 'publish_announcement', id); return { id };
  });
  app.delete('/api/v1/admin/announcements/:id', async request => { const user = await auth.require(request, true, true), id = bodyId(request); store.run('DELETE FROM announcements WHERE id=?', id); store.audit(user.id, 'delete_announcement', id); return { ok: true }; });
  app.get('/api/v1/admin/storage', async request => { await auth.require(request, true, true); return { kind: storage.kind, ...await storage.check() }; });
  app.get('/api/v1/admin/imports/github', async request => { await auth.require(request, true, true); return { items: await new GithubStorage(config).candidates() }; });
  app.addHook('onClose', async () => { for (const controller of activeUploads.values()) controller.abort(); store.close(); });
  return { app, store, auth, storage };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  const { app } = await createApp({ config });
  await app.listen({ host: config.host, port: config.port });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
