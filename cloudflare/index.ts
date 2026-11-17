import { z, ZodError } from 'zod';
import { HubError, idSchema, metadataSchema, querySchema, uploadSchema, safeFilename } from '../shared/schema';
import { Store, type Env } from './database';
import { Auth, hash } from './auth';
import { GitHub, chunkSize } from './github';
import { boundedBytes, downloadRange } from './download';

const json = (value: unknown, status = 200) => Response.json(value, { status });
function signInPage(title: string, message: string, status = 200) {
  const arabic = title === 'Signed in' ? ['تم تسجيل الدخول', 'ارجع إلى برنامج Team Razka. يمكنك إغلاق هذه الصفحة.'] : title === 'Start sign-in from the program' ? ['ابدأ تسجيل الدخول من البرنامج', 'افتح برنامج Team Razka واضغط على «تسجيل الدخول بديسكورد». يستقبل هذا الرابط نتيجة تسجيل الدخول من ديسكورد، ولا يمكن تسجيل الدخول بفتحه مباشرةً.'] : ['تعذّر إكمال تسجيل الدخول', message.startsWith('This sign-in') ? 'انتهت صلاحية طلب تسجيل الدخول أو تم استخدامه مسبقًا. ارجع إلى البرنامج وابدأ تسجيل الدخول من جديد.' : 'ارجع إلى البرنامج لمعرفة نتيجة تسجيل الدخول. تأكد من انضمامك إلى سيرفر Team Razka في ديسكورد قبل المحاولة مجددًا.'];
  return new Response(`<!doctype html><html lang="ar"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Team Razka Program</title><body style="background:#101012;color:#f4f4f4;font:18px Segoe UI,Tahoma,sans-serif;padding:48px;max-width:640px;margin:auto;line-height:1.8"><main><section dir="rtl"><h1>${arabic[0]}</h1><p>${arabic[1]}</p></section><section lang="en" dir="ltr" style="border-top:1px solid #333;margin-top:32px;padding-top:16px"><h2>${title}</h2><p>${message}</p></section></main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
}
const publicUser = (user: Awaited<ReturnType<Auth['require']>>) => { const { sessionHash, authenticatedAt, ...result } = user; return result; };
async function body(request: Request, max = 65536) {
  const reader = request.body?.getReader(); if (!reader) return {};
  let count = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const value = await reader.read(); if (value.done) break; count += value.value.byteLength; if (count > max) throw new HubError('FILE_TOO_LARGE', 'The request is too large.', 413); chunks.push(value.value); } }
  catch (e) { await reader.cancel(); throw e; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function rate(store: Store, request: Request, endpoint: string, maximum = 240) {
  await store.run('DELETE FROM request_limits WHERE expires_at<?', Date.now());
  const bucket = Math.floor(Date.now() / 60000), key = await hash(`${request.headers.get('cf-connecting-ip') || 'local'}:${endpoint}:${bucket}`);
  await store.run('INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', key, Date.now() + 120000);
  if (Number((await store.get('SELECT count FROM request_limits WHERE key=?', key))?.count || 0) > maximum) throw new HubError('RATE_LIMITED', 'Please wait before trying again.', 429);
}
async function service(request: Request, env: Env) {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!env.PUBLISH_CALLBACK_SECRET || await hash(bearer) !== await hash(env.PUBLISH_CALLBACK_SECRET)) throw new HubError('UNAUTHORIZED', 'Authentication is required.', 401);
}
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), origin = env.APP_BASE_URL || url.origin, path = url.pathname, method = request.method;
  const store = new Store(env.DB), auth = new Auth(env, store, origin), github = new GitHub(env);
  const match = (pattern: RegExp) => pattern.exec(path);
  const originHeader = request.headers.get('origin');
  if (originHeader && originHeader !== origin) throw new HubError('FORBIDDEN_ORIGIN', 'This request is not allowed.', 403);
  if (path === '/api/v1/health') return json({ ok: true });
  if (path === '/api/v1/config/public') return json({ name: 'TEAM RAZKA PROGRAM', inviteUrl: env.DISCORD_INVITE_URL, discordConfigured: Boolean(env.DISCORD_CLIENT_SECRET && env.DISCORD_BOT_TOKEN && env.SESSION_SECRET), nativeLoopbackCallback: env.DISCORD_REDIRECT_URI === 'http://127.0.0.1:8787/api/v1/auth/discord/callback', membershipVerification: 'bot', maxUploadBytes: 2 * 1024 ** 3 - 1, chunkSize });
  await rate(store, request, path.startsWith('/api/v1/auth/') ? 'auth' : 'api', path.endsWith('/start') ? 12 : 240);
  if (path === '/api/v1/auth/discord/start' && method === 'GET') return json(await auth.start());
  if (path === '/api/v1/auth/desktop/exchange' && method === 'POST') return json(await auth.exchange(z.object({ pollToken: z.string().min(40).max(100) }).parse(await body(request)).pollToken));
  if (path === '/api/v1/auth/discord/callback') {
    if (method === 'GET' && (!url.searchParams.has('code') || !url.searchParams.has('state'))) return signInPage('Start sign-in from the program', 'Open Team Razka Program and select “Sign in with Discord”. This address receives the result from Discord; opening it directly does not sign you in.', 400);
    const input = z.object({ code: z.string().min(1).max(2048), state: z.string().min(20).max(128), iss: z.string().optional() }).parse(method === 'POST' ? await body(request) : Object.fromEntries(url.searchParams));
    try { await auth.callback(input.code, input.state, input.iss); }
    catch (error) { if (error instanceof HubError) return signInPage('Sign-in could not be completed', error.code === 'INVALID_OAUTH_STATE' ? 'This sign-in request has expired or was already used. Return to the program and start sign-in again.' : 'Return to the program for the sign-in result. Check that you belong to the Team Razka Discord server before trying again.', error.status); throw error; }
    return signInPage('Signed in', 'Return to Team Razka Program. You can close this page.');
  }
  if (path === '/api/v1/publish/import' && method === 'POST') {
    await service(request, env);
    const input = z.object({ ownerId: z.string().regex(/^\d{15,22}$/), releaseId: z.string().regex(/^\d+$/), assetId: z.string().regex(/^\d+$/), filename: z.string(), size: z.number().int().positive().max(2 ** 31 - 1), sha256: z.string().regex(/^[a-f0-9]{64}$/), metadata: metadataSchema, picture: z.object({ body: z.string().max(1600000), width: z.number().int().min(1).max(1600), height: z.number().int().min(1).max(1600) }).optional() }).parse(await body(request, 1800000));
    safeFilename(input.filename);
    if (!env.ADMIN_DISCORD_IDS.split(',').map(v => v.trim()).includes(input.ownerId)) throw new HubError('FORBIDDEN', 'Owner access is required.', 403);
    await auth.membership(input.ownerId);
    const release = await github.json(`/releases/${input.releaseId}`), asset = release.assets.find((a: any) => String(a.id) === input.assetId);
    if (release.draft || !asset || asset.size !== input.size || asset.digest !== `sha256:${input.sha256}`) throw new HubError('CHECKSUM_MISMATCH', 'The GitHub ZIP did not match the verified file.', 409);
    const previous = await store.get('SELECT mod_id FROM versions WHERE sha256=?', input.sha256);
    if (previous) return json({ ok: true, duplicate: true, modId: previous.mod_id });
    const modId = crypto.randomUUID(), versionId = crypto.randomUUID(), imageId = input.picture ? crypto.randomUUID() : null, now = Date.now();
    const metadata = { ...input.metadata, thumbnailId: imageId }, statements = [];
    if (input.picture) { const bytes = Buffer.from(input.picture.body, 'base64'); if (bytes.length > 1200000 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new HubError('INVALID_IMAGE', 'The picture is not a valid JPEG.'); statements.push(store.statement('INSERT INTO media(id,key,mime,width,height,owner_id,created_at,body) VALUES(?,?,?,?,?,?,?,?)', imageId, `${imageId}.jpg`, 'image/jpeg', input.picture.width, input.picture.height, input.ownerId, now, input.picture.body)); }
    statements.push(store.statement("INSERT INTO mods(id,name,creator,type,metadata,search,status,active_version,created_at,updated_at) VALUES(?,?,?,?,?,?,'published',?,?,?)", modId, metadata.name, metadata.creator, metadata.type, JSON.stringify(metadata), store.search(metadata), versionId, now, now));
    statements.push(store.statement('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?)', versionId, modId, '', '', input.filename, input.size, input.sha256, `github-releases|github:${input.assetId}`, now));
    statements.push(store.statement('INSERT INTO audit VALUES(?,?,?,?,?,?)', crypto.randomUUID(), input.ownerId, 'import_mod', modId, JSON.stringify({ filename: input.filename, releaseId: input.releaseId, assetId: input.assetId }), now));
    await env.DB.batch(statements); return json({ ok: true, modId });
  }
  const publishing = match(/^\/api\/v1\/publish\/([\w-]+)$/);
  if (publishing) {
    await service(request, env); const id = idSchema.parse(publishing[1]), upload = await store.get('SELECT * FROM uploads WHERE id=?', id);
    if (!upload) throw new HubError('NOT_FOUND', 'The upload is not available.', 404);
    const input = uploadSchema.parse(JSON.parse(upload.metadata));
    if (method === 'GET') { if (upload.status !== 'storing') throw new HubError('INVALID_UPLOAD', 'The upload is not awaiting publication.', 409); return json({ id, releaseId: upload.release_id, repository: env.GITHUB_REPOSITORY, ...input, parts: await store.all('SELECT part_index,asset_id,size,sha256 FROM upload_parts WHERE upload_id=? ORDER BY part_index', id) }); }
    if (method === 'POST') {
      const result = z.object({ status: z.enum(['completed', 'failed']), assetId: z.string().regex(/^\d+$/).optional(), errorCode: z.string().max(60).optional() }).parse(await body(request));
      if (upload.status === 'completed') return json({ ok: true });
      if (result.status === 'failed') { await store.run("UPDATE uploads SET status='failed',error_code=?,updated_at=? WHERE id=?", result.errorCode || 'PUBLISH_FAILED', Date.now(), id); return json({ ok: true }); }
      if (!result.assetId || upload.status !== 'storing') throw new HubError('INVALID_UPLOAD', 'The upload cannot be published.');
      if (!env.ADMIN_DISCORD_IDS.split(',').map(v => v.trim()).includes(upload.owner_id)) throw new HubError('FORBIDDEN', 'Owner access is required.', 403);
      await auth.membership(upload.owner_id);
      const asset = await github.asset(result.assetId), release = await github.json(`/releases/${upload.release_id}`);
      if ((asset.name !== input.filename && asset.label !== input.filename) || asset.size !== input.size || asset.digest !== `sha256:${input.sha256}` || release.draft || release.tag_name !== `upload-${id}` || !release.assets.some((a: any) => String(a.id) === result.assetId)) throw new HubError('CHECKSUM_MISMATCH', 'The published ZIP did not match the upload.', 409);
      const versionId = crypto.randomUUID(), modId = upload.mod_id, now = Date.now();
      if (!await store.get('SELECT id FROM mods WHERE id=? AND deleted_at IS NULL', modId)) throw new HubError('NOT_FOUND', 'The listing was removed during upload.', 409);
      await env.DB.batch([
        store.statement('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?)', versionId, modId, input.version, input.changelog, input.filename, input.size, input.sha256, `github-releases|github:${result.assetId}`, now),
        store.statement('UPDATE mods SET name=?,creator=?,type=?,metadata=?,search=?,active_version=?,status=?,updated_at=? WHERE id=?', input.metadata.name, input.metadata.creator, input.metadata.type, JSON.stringify(input.metadata), store.search(input.metadata), versionId, input.publish ? 'published' : 'draft', now, modId),
        store.statement("UPDATE uploads SET status='completed',bytes=?,updated_at=? WHERE id=?", input.size, now, id),
        store.statement('INSERT INTO audit VALUES(?,?,?,?,?,?)', crypto.randomUUID(), upload.owner_id, 'publish_mod', modId, JSON.stringify({ filename: input.filename, releaseId: upload.release_id }), now),
      ]);
      return json({ ok: true, mod: await store.requireMod(modId, true) });
    }
  }
  const user = await auth.require(request, path.startsWith('/api/v1/admin/'), method !== 'GET' && !path.includes('/downloads/'));
  if (path === '/api/v1/auth/me') return json(publicUser(user));
  if (path === '/api/v1/auth/recheck-membership' && method === 'POST') return json(publicUser(await auth.require(request, false, true)));
  if (path === '/api/v1/auth/logout' && method === 'POST') { await store.run('UPDATE sessions SET revoked_at=? WHERE hash=?', Date.now(), user.sessionHash); return json({ ok: true }); }
  if ((path === '/api/v1/mods' || path === '/api/v1/admin/mods') && method === 'GET') return json(await store.list(querySchema.parse(Object.fromEntries(url.searchParams)), path.startsWith('/api/v1/admin/')));
  if (path === '/api/v1/mods/favorites' && method === 'GET') return json(await store.list(querySchema.parse(Object.fromEntries(url.searchParams)), false, z.array(idSchema).max(500).parse(url.searchParams.get('ids')?.split(',').filter(Boolean) || [])));
  const detail = match(/^\/api\/v1\/mods\/([^/]+)$/);
  if (detail && method === 'GET') return json(await store.requireMod(idSchema.parse(detail[1]), user.admin));
  const versions = match(/^\/api\/v1\/mods\/([^/]+)\/versions$/);
  if (versions && method === 'GET') { const id = idSchema.parse(versions[1]); await store.requireMod(id, user.admin); return json((await store.all('SELECT * FROM versions WHERE mod_id=? ORDER BY created_at DESC', id)).map(v => store.version(v))); }
  const review = match(/^\/api\/v1\/mods\/([^/]+)\/reviews(?:\/([^/]+))?$/);
  if (review) {
    const id = idSchema.parse(review[1]); await store.requireMod(id, user.admin);
    if (method === 'GET') { const summary = await store.get('SELECT count(*) count,avg(rating) average FROM reviews WHERE mod_id=?', id); return json({ average: summary?.average ?? null, count: Number(summary?.count || 0), items: await store.all('SELECT r.user_id AS userId,u.name,r.rating,r.body,r.created_at AS createdAt,r.updated_at AS updatedAt FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.mod_id=? ORDER BY r.updated_at DESC LIMIT 100', id) }); }
    if (method === 'PUT' && !review[2]) { await rate(store, request, 'review-write', 12); const input = z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).default('') }).parse(await body(request)); const now = Date.now(); await store.run('INSERT INTO reviews VALUES(?,?,?,?,?,?) ON CONFLICT(mod_id,user_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,updated_at=excluded.updated_at', id, user.id, input.rating, input.body, now, now); return json({ ok: true }); }
    if (method === 'DELETE') { const author = review[2] || user.id; if (author !== user.id && !user.admin) throw new HubError('FORBIDDEN', 'You can only remove your own review.', 403); await store.run('DELETE FROM reviews WHERE mod_id=? AND user_id=?', id, author); return json({ ok: true }); }
  }
  if (path === '/api/v1/announcements') return json(await store.all('SELECT * FROM announcements WHERE published_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY published_at DESC LIMIT 10', Date.now(), Date.now()));
  const media = match(/^\/api\/v1\/media\/([^/]+)$/);
  if (media && method === 'GET') { const image = await store.get('SELECT * FROM media WHERE id=?', idSchema.parse(media[1])); if (!image) throw new HubError('NOT_FOUND', 'The picture is not available.', 404); if (image.body) return new Response(Buffer.from(image.body, 'base64'), { headers: { 'content-type': image.mime } }); if (image.key.startsWith('github:')) { const r = await github.download(image.key.slice(7)); return new Response(r.body, { headers: { 'content-type': image.mime } }); } throw new HubError('NOT_FOUND', 'The picture is not available.', 404); }
  const ticket = match(/^\/api\/v1\/mods\/([^/]+)\/download-ticket$/);
  if (ticket && method === 'POST') {
    await auth.require(request, false, true); const mod = await store.requireMod(idSchema.parse(ticket[1]), user.admin); if (!mod.activeVersion) throw new HubError('ASSET_MISSING', 'The ZIP is not available.', 404);
    const id = crypto.randomUUID(), expiresAt = Date.now() + 1800000;
    await store.run('INSERT INTO download_tickets(id,session_hash,user_id,mod_id,version_id,expires_at) VALUES(?,?,?,?,?,?)', id, user.sessionHash, user.id, mod.id, mod.activeVersion.id, expiresAt);
    return json({ id, path: `/api/v1/downloads/${id}/file`, expiresAt, version: mod.activeVersion });
  }
  const download = match(/^\/api\/v1\/downloads\/([^/]+)\/(file|complete)$/);
  if (download) {
    const id = idSchema.parse(download[1]), t = await store.get('SELECT t.*,v.filename,v.sha256,v.size,v.storage_key FROM download_tickets t JOIN versions v ON v.id=t.version_id WHERE t.id=? AND t.session_hash=?', id, user.sessionHash);
    if (!t || t.expires_at <= Date.now()) throw new HubError('DOWNLOAD_EXPIRED', 'Start the download again.', 401);
    if (download[2] === 'complete' && method === 'POST') { const input = z.object({ result: z.enum(['completed', 'failed', 'cancelled']), sha256: z.string().optional(), errorCode: z.string().max(60).optional() }).parse(await body(request)); if (input.result === 'completed' && (!t.transferred_at || input.sha256 !== t.sha256)) throw new HubError('CHECKSUM_MISMATCH', 'The downloaded file has not been verified.', 409); if (!t.completed_at) await store.run('UPDATE download_tickets SET completed_at=?,result=?,error_code=? WHERE id=?', Date.now(), input.result, input.errorCode || null, id); return json({ ok: true }); }
    if (download[2] === 'file' && method === 'GET') { const assetId = /github:(\d+)$/.exec(t.storage_key)?.[1]; if (!assetId || t.completed_at) throw new HubError('ASSET_MISSING', 'The ZIP is not available.', 404); const range = request.headers.get('range'); if (range && !/^bytes=\d+-\d*$/.test(range)) throw new HubError('INVALID_RANGE', 'Invalid download range.', 416); const r = await github.download(assetId, range || undefined); const expected = downloadRange(t.size, range, r); let transferred = 0; const headers = new Headers({ 'content-type': 'application/zip', 'accept-ranges': 'bytes', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(t.filename)}` }); for (const key of ['content-length', 'content-range']) if (r.headers.has(key)) headers.set(key, r.headers.get(key)!); const transform = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { transferred += chunk.length; if (transferred > expected.length) throw new HubError('SIZE_MISMATCH', 'The downloaded size was incorrect.'); controller.enqueue(chunk); }, async flush() { if (transferred !== expected.length) throw new HubError('SIZE_MISMATCH', 'The download was incomplete.'); if (expected.reachesEnd) await store.run('UPDATE download_tickets SET transferred_at=? WHERE id=?', Date.now(), id); } }); return new Response(r.body!.pipeThrough(transform), { status: r.status, headers }); }
  }
  const edit = match(/^\/api\/v1\/admin\/mods\/([^/]+)(?:\/(publish|unpublish))?$/);
  if (edit) {
    const id = idSchema.parse(edit[1]), mod = await store.requireMod(id, true);
    if (method === 'PATCH') { const data = metadataSchema.parse(await body(request)); if (data.thumbnailId && !await store.get('SELECT id FROM media WHERE id=?', data.thumbnailId)) throw new HubError('INVALID_IMAGE', 'Select an uploaded picture.'); await store.run('UPDATE mods SET name=?,creator=?,type=?,metadata=?,search=?,updated_at=? WHERE id=?', data.name, data.creator, data.type, JSON.stringify(data), store.search(data), Date.now(), id); await store.audit(user.id, 'edit_mod', id); return json(await store.requireMod(id, true)); }
    if (method === 'POST' && edit[2]) { if (edit[2] === 'publish' && !mod.activeVersion) throw new HubError('ASSET_MISSING', 'Upload a ZIP first.'); await store.run('UPDATE mods SET status=?,updated_at=? WHERE id=?', edit[2] === 'publish' ? 'published' : 'draft', Date.now(), id); await store.audit(user.id, edit[2], id); return json(await store.requireMod(id, true)); }
    if (method === 'DELETE') { if (Date.now() - user.authenticatedAt > 600000) throw new HubError('RECENT_AUTH_REQUIRED', 'Sign in again before removing a listing.', 401); const input = z.object({ confirmation: z.string() }).parse(await body(request)); if (input.confirmation !== mod.name) throw new HubError('CONFIRMATION_REQUIRED', 'Confirm the listing name.'); await store.run("UPDATE mods SET deleted_at=?,status='draft',updated_at=? WHERE id=?", Date.now(), Date.now(), id); await store.audit(user.id, 'delete_listing', id, { filesRetained: true }); return json({ ok: true, filesRetained: true }); }
  }
  if (path === '/api/v1/admin/stats') {
    const counts = await store.get("SELECT sum(status='published') published,sum(status='draft') drafts FROM mods WHERE deleted_at IS NULL"), bytes = await store.get('SELECT coalesce(sum(size),0) n FROM versions'), catalog = await store.get('SELECT coalesce(sum(v.size),0) n FROM mods m JOIN versions v ON m.active_version=v.id WHERE m.deleted_at IS NULL'), completed = await store.get("SELECT count(*) n FROM download_tickets WHERE result='completed'");
    return json({ published: Number(counts?.published || 0), drafts: Number(counts?.drafts || 0), storedBytes: Number(bytes?.n || 0), catalogBytes: Number(catalog?.n || 0), completedDownloads: Number(completed?.n || 0) });
  }
  if (path === '/api/v1/admin/uploads/init' && method === 'POST') {
    const input = uploadSchema.parse(await body(request)); safeFilename(input.filename);
    if (input.size >= 2 * 1024 ** 3) throw new HubError('FILE_TOO_LARGE', 'GitHub ZIPs must be smaller than 2 GiB.');
    if (await store.get('SELECT id FROM versions WHERE sha256=? LIMIT 1', input.sha256) || (await github.candidates()).some((a: any) => a.sha256 === input.sha256)) throw new HubError('DUPLICATE_MOD', 'This ZIP is already in the library or repository.', 409);
    if (input.metadata.thumbnailId && !await store.get('SELECT id FROM media WHERE id=?', input.metadata.thumbnailId)) throw new HubError('INVALID_IMAGE', 'Select an uploaded picture.');
    const id = crypto.randomUUID(), modId = input.modId || crypto.randomUUID(), now = Date.now();
    if (input.modId) await store.requireMod(modId, true);
    const release = await github.createUpload(id, input.metadata.name, input.metadata.description);
    const statements = [store.statement('INSERT INTO uploads(id,owner_id,metadata,status,created_at,updated_at,mod_id,release_id) VALUES(?,?,?,?,?,?,?,?)', id, user.id, JSON.stringify(input), 'transferring', now, now, modId, String(release.id))];
    if (!input.modId) statements.unshift(store.statement('INSERT INTO mods(id,name,creator,type,metadata,search,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', modId, input.metadata.name, input.metadata.creator, input.metadata.type, JSON.stringify(input.metadata), store.search(input.metadata), now, now));
    await env.DB.batch(statements); return json({ id, chunkSize, partsPath: `/api/v1/admin/uploads/${id}/parts`, completePath: `/api/v1/admin/uploads/${id}/complete` });
  }
  const uploadPath = match(/^\/api\/v1\/admin\/uploads\/([^/]+)(?:\/(parts\/\d+|complete|cancel))?$/);
  if (uploadPath) {
    const id = idSchema.parse(uploadPath[1]), upload = await store.get('SELECT * FROM uploads WHERE id=? AND owner_id=?', id, user.id); if (!upload) throw new HubError('NOT_FOUND', 'The upload is not available.', 404);
    const input = uploadSchema.parse(JSON.parse(upload.metadata));
    if (!uploadPath[2] && method === 'GET') return json({ id, status: upload.status, bytes: upload.bytes, total: input.size, errorCode: upload.error_code, modId: upload.mod_id });
    if (uploadPath[2] === 'cancel' && method === 'POST') { if (upload.status !== 'completed') await store.run("UPDATE uploads SET status='cancelled',updated_at=? WHERE id=?", Date.now(), id); return json({ ok: true }); }
    if (uploadPath[2]?.startsWith('parts/') && method === 'PUT') {
      if (upload.status !== 'transferring') throw new HubError('INVALID_UPLOAD', 'The upload is no longer accepting parts.', 409);
      const index = Number(uploadPath[2].slice(6)), expected = Math.min(chunkSize, input.size - index * chunkSize);
      if (!Number.isSafeInteger(index) || index < 0 || expected <= 0 || Number(request.headers.get('content-length')) !== expected || !request.body) throw new HubError('SIZE_MISMATCH', 'This upload part has the wrong size.');
      const digest = z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers.get('x-part-sha256'));
      const previous = await store.get('SELECT * FROM upload_parts WHERE upload_id=? AND part_index=?', id, index); if (previous) { if (previous.sha256 !== digest) throw new HubError('FILE_CHANGED', 'The upload part changed.'); return json({ ok: true }); }
      const asset = await github.uploadPart(upload.release_id, index, request.body, expected);
      if (asset.size !== expected || asset.digest !== `sha256:${digest}`) throw new HubError('CHECKSUM_MISMATCH', 'The upload part did not pass verification.');
      await store.run('INSERT INTO upload_parts VALUES(?,?,?,?,?)', id, index, String(asset.id), expected, digest);
      await store.run('UPDATE uploads SET bytes=(SELECT coalesce(sum(size),0) FROM upload_parts WHERE upload_id=?),updated_at=? WHERE id=?', id, Date.now(), id); return json({ ok: true });
    }
    if (uploadPath[2] === 'complete' && method === 'POST') {
      if (upload.status === 'completed' || upload.status === 'storing') return json({ ok: true });
      if (upload.status !== 'transferring') throw new HubError('INVALID_UPLOAD', 'This upload cannot be completed.');
      const count = await store.get('SELECT count(*) n,sum(size) bytes FROM upload_parts WHERE upload_id=?', id);
      if (Number(count?.n) !== Math.ceil(input.size / chunkSize) || Number(count?.bytes) !== input.size) throw new HubError('SIZE_MISMATCH', 'The upload is incomplete.');
      await store.run("UPDATE uploads SET status='storing',dispatch_at=?,updated_at=? WHERE id=?", Date.now(), Date.now(), id);
      try { await github.dispatch(id); } catch (error) { await store.run("UPDATE uploads SET status='transferring',error_code='PUBLISH_UNAVAILABLE' WHERE id=?", id); throw error; }
      return json({ ok: true });
    }
  }
  if (path === '/api/v1/admin/media' && method === 'POST') {
    const bytes = await boundedBytes(request, 1200000); if (bytes[0] !== 255 || bytes[1] !== 216) throw new HubError('INVALID_IMAGE', 'Choose a supported JPEG picture under 1.2 MB.');
    const id = crypto.randomUUID(), width = Math.max(1, Math.min(1600, Number(request.headers.get('x-image-width')) || 1)), height = Math.max(1, Math.min(1600, Number(request.headers.get('x-image-height')) || 1));
    await store.run('INSERT INTO media(id,key,mime,width,height,owner_id,created_at,body) VALUES(?,?,?,?,?,?,?,?)', id, `${id}.jpg`, 'image/jpeg', width, height, user.id, Date.now(), Buffer.from(bytes).toString('base64')); return json({ id, width, height });
  }
  if (path === '/api/v1/admin/media' && method === 'GET') return json(await store.all('SELECT id,width,height,created_at FROM media ORDER BY created_at DESC LIMIT 200'));
  if (path === '/api/v1/admin/audit') return json(await store.all('SELECT * FROM audit ORDER BY created_at DESC LIMIT 200'));
  if (path === '/api/v1/admin/announcements' && method === 'GET') return json(await store.all('SELECT * FROM announcements ORDER BY published_at DESC'));
  if (path === '/api/v1/admin/announcements' && method === 'POST') { const input = z.object({ title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(2000) }).parse(await body(request)); const id = crypto.randomUUID(); await store.run('INSERT INTO announcements VALUES(?,?,?,?,?)', id, input.title, input.body, Date.now(), null); await store.audit(user.id, 'publish_announcement', id); return json({ id }); }
  const deleteAnnouncement = match(/^\/api\/v1\/admin\/announcements\/([^/]+)$/); if (deleteAnnouncement && method === 'DELETE') { const id = idSchema.parse(deleteAnnouncement[1]); await store.run('DELETE FROM announcements WHERE id=?', id); return json({ ok: true }); }
  if (path === '/api/v1/admin/storage') { await github.json(''); return json({ kind: 'github-releases', available: true, uploads: Boolean(env.GITHUB_TOKEN), visibility: 'public-github-release' }); }
  if (path === '/api/v1/admin/imports/github' && method === 'GET') return json({ items: await github.candidates() });
  throw new HubError('NOT_FOUND', 'This request is not available.', 404);
}
export default {
  async fetch(request: Request, env: Env) {
    let response: Response;
    try { response = await handle(request, env); }
    catch (error) { const status = error instanceof HubError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500; response = json({ error: { code: error instanceof HubError ? error.code : status === 400 ? 'INVALID_INPUT' : 'REQUEST_FAILED', message: error instanceof HubError ? error.message : status === 400 ? 'Check the entered details.' : 'The request could not be completed.' } }, status); }
    const headers = new Headers(response.headers); headers.set('x-content-type-options', 'nosniff'); headers.set('cache-control', 'no-store'); headers.set('referrer-policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers });
  },
};
