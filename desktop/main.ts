import { app, BrowserWindow, clipboard, dialog, ipcMain, net, nativeImage, protocol, safeStorage, session, shell } from 'electron';
import { readFile, writeFile, mkdir, stat, open as openFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { HubError, idSchema, metadataSchema, querySchema, userSchema, sessionTokenSchema, type Mod, type Progress, type Settings, type UploadInput, type User } from '../shared/schema';
import { Installer, discoverModsFolder, fileHash, readJson, writeJson, serializeFile } from './installer';
import { validateArchive } from '../server/archive';
import { inspectMod } from './metadata';
import { setTimeout as waitForStatus } from 'node:timers/promises';
import type { Action, Bootstrap, Selection } from '../shared/bridge';
import { startUpdates } from './updates';

app.setName('Team Razka Program');
app.setAppUserModelId('com.teamrazka.program');
if (process.env.HUB_USER_DATA && !app.isPackaged) app.setPath('userData', path.resolve(process.env.HUB_USER_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow;
let settings: Settings, token = '', user: User | null = null, inviteUrl = 'https://discord.gg/DHF4akrWmr';
let loginController: AbortController | null = null, lastError = '';
const selections = new Map<string, { file: string; name: string; size: number; modified: number; kind: 'zip' | 'image' }>();
const progress = new Map<string, Progress>(), uploads = new Map<string, { controller: AbortController; serverId?: string }>();
const images = new Map<string, string>();
let installer: Installer;
const root = app.getAppPath(), dataDir = app.getPath('userData'), settingsFile = path.join(dataDir, 'settings.json'), sessionFile = path.join(dataDir, 'session.bin');
const isDev = !app.isPackaged && Boolean(process.env.HUB_DEV_URL);

function baseUrl(value: string) {
  const parsed = new URL(value.trim());
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new HubError('INVALID_SERVER', 'Enter the HTTPS address of your Team Razka server.');
  return parsed.origin;
}
async function storeToken(value: string) {
  token = value ? sessionTokenSchema.parse(value) : '';
  if (safeStorage.isEncryptionAvailable()) await writeFile(sessionFile, safeStorage.encryptString(JSON.stringify({ token: value, serverUrl: settings.serverUrl })), { mode: 0o600 });
}
function emit(value: Progress) {
  progress.set(value.id, value); if (progress.size > 200) { const first = [...progress.values()].find(v => ['completed', 'cancelled', 'failed'].includes(v.stage)); if (first) progress.delete(first.id); }
  if (window && !window.isDestroyed()) window.webContents.send('hub:progress', value);
}
function lock() { user = null; installer?.cancelAll(); for (const upload of uploads.values()) upload.controller.abort(); images.clear(); if (window && !window.isDestroyed()) window.webContents.send('hub:session', null); }
async function fetchApi(endpoint: string, options: RequestInit = {}) {
  if (!settings.serverUrl) throw new HubError('SERVER_REQUIRED', 'Connect to the Team Razka server first.');
  if (!endpoint.startsWith('/api/v1/') || endpoint.includes('..') || endpoint.startsWith('//')) throw new HubError('INVALID_REQUEST', 'This request is not supported.');
  const headers = new Headers(options.headers); if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${settings.serverUrl}${endpoint}`, { ...options, headers, redirect: 'error', signal: options.signal || AbortSignal.timeout(30000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as any; const error = new HubError(body?.error?.code || 'SERVER_ERROR', body?.error?.message || 'The server could not complete this request.', response.status);
    lastError = error.code;
    if (['UNAUTHORIZED', 'SESSION_EXPIRED', 'NOT_A_MEMBER', 'ROLE_REQUIRED'].includes(error.code)) lock();
    throw error;
  }
  return response;
}
async function api<T = any>(endpoint: string, method = 'GET', body?: unknown): Promise<T> { return (await fetchApi(endpoint, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })).json() as Promise<T>; }
async function ensureUser(admin = false) { if (!token) throw new HubError('UNAUTHORIZED', 'Sign in with Discord to continue.', 401); user = userSchema.parse(await api('/api/v1/auth/me')); if (admin && !user.admin) throw new HubError('FORBIDDEN', 'This action is only available to the library owner.', 403); return user; }
async function bootstrap(): Promise<Bootstrap> {
  let connected = false, configured = false, error: string | undefined;
  if (settings.serverUrl) {
    try { const config = await api('/api/v1/config/public'); connected = true; configured = config.discordConfigured === true; inviteUrl = config.inviteUrl; if (token) await ensureUser(); } catch (e) { user = null; error = e instanceof HubError ? e.code : 'CONNECTION_FAILED'; }
  }
  return { connected, configured, user, serverUrl: settings.serverUrl, language: settings.language, adminLanguage: settings.adminLanguage, inviteUrl, error, version: app.getVersion() };
}
async function trustedExternal(value: string, authorize = false) {
  const parsed = new URL(value);
  const allowed = authorize ? parsed.hostname === 'discord.com' && parsed.pathname === '/oauth2/authorize' : parsed.hostname === 'discord.gg' || parsed.hostname === 'discord.com';
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed) throw new HubError('INVALID_LINK', 'This link is not supported.');
  await shell.openExternal(parsed.toString());
}
async function login() {
  loginController?.abort(); const controller = new AbortController(); loginController = controller;
  const start = z.object({ authorizeUrl: z.string().url(), pollToken: sessionTokenSchema, expiresIn: z.number().int().min(1).max(600) }).parse(await api('/api/v1/auth/discord/start')); await trustedExternal(start.authorizeUrl, true);
  const expires = Date.now() + start.expiresIn * 1000;
  while (Date.now() < expires && !controller.signal.aborted) {
    await delay(1500, undefined, { signal: controller.signal }).catch(() => {});
    if (controller.signal.aborted) break;
    const exchange = await api('/api/v1/auth/desktop/exchange', 'POST', { pollToken: start.pollToken });
    if (exchange.status === 'complete') { await storeToken(exchange.token); const member = await ensureUser(); window.webContents.send('hub:session', member); return member; }
  }
  throw new HubError(controller.signal.aborted ? 'CANCELLED' : 'SIGNIN_EXPIRED', controller.signal.aborted ? 'Sign-in cancelled.' : 'The sign-in request expired. Try again.');
}
async function resource(action: Action, payload: any = {}) {
  const id = () => idSchema.parse(payload.id);
  const list = () => new URLSearchParams(Object.entries(querySchema.parse(payload)).map(([k, v]) => [k, String(v)])).toString();
  switch (action) {
    case 'mods:list': return api(`/api/v1/mods?${list()}`);
    case 'mods:brands': return api('/api/v1/mods/brands');
    case 'mods:favorites': { const ids = z.array(idSchema).max(500).parse(payload.ids); return api(`/api/v1/mods/favorites?${list()}&ids=${encodeURIComponent(ids.join(','))}`); }
    case 'mods:detail': return api(`/api/v1/mods/${id()}`);
    case 'mods:versions': return api(`/api/v1/mods/${id()}/versions`);
    case 'mods:reviews': return api(`/api/v1/mods/${id()}/reviews`);
    case 'mods:report': return api(`/api/v1/mods/${id()}/reports`, 'POST', z.object({ body: z.string().trim().min(5).max(2000) }).parse(payload));
    case 'mods:review': return api(`/api/v1/mods/${id()}/reviews`, 'PUT', z.object({ rating: z.number().int().min(1).max(5), body: z.string().max(2000) }).parse(payload));
    case 'mods:deleteReview': return api(`/api/v1/mods/${id()}/reviews/${z.string().regex(/^\d{15,22}$/).parse(payload.userId)}`, 'DELETE');
    case 'announcements:list': return api('/api/v1/announcements');
    case 'admin:stats': return api('/api/v1/admin/stats');
    case 'admin:reports': return api('/api/v1/admin/reports');
    case 'admin:reviewReport': return api(`/api/v1/admin/reports/${id()}`, 'PATCH', z.object({ status: z.enum(['open', 'resolved']) }).parse(payload));
    case 'admin:mods': return api(`/api/v1/admin/mods?${list()}`);
    case 'admin:update': return api(`/api/v1/admin/mods/${id()}`, 'PATCH', metadataSchema.parse(payload.metadata));
    case 'admin:publish': return api(`/api/v1/admin/mods/${id()}/publish`, 'POST', {});
    case 'admin:unpublish': return api(`/api/v1/admin/mods/${id()}/unpublish`, 'POST', {});
    case 'admin:delete': return api(`/api/v1/admin/mods/${id()}`, 'DELETE', z.object({ confirmation: z.string().max(160) }).parse(payload));
    case 'admin:media': return api('/api/v1/admin/media');
    case 'admin:audit': return api('/api/v1/admin/audit');
    case 'admin:announcements': return api('/api/v1/admin/announcements');
    case 'admin:announce': return api('/api/v1/admin/announcements', 'POST', payload);
    case 'admin:deleteAnnouncement': return api(`/api/v1/admin/announcements/${id()}`, 'DELETE');
    case 'admin:storage': return api('/api/v1/admin/storage');
    case 'admin:imports': return api('/api/v1/admin/imports/github');
    default: throw new HubError('INVALID_REQUEST', 'This request is not supported.');
  }
}
async function pickFile(kind: 'zip' | 'image') {
  await ensureUser(true); z.enum(['zip', 'image']).parse(kind);
  const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: kind === 'zip' ? 'BeamNG ZIP' : 'Pictures', extensions: kind === 'zip' ? ['zip'] : ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (selection.canceled || !selection.filePaths[0]) return null;
  const file = selection.filePaths[0], info = await stat(file), name = path.basename(file), id = randomUUID();
  if (kind === 'zip' && info.size > 2 * 1024 ** 3 || kind === 'image' && info.size > 10 * 1024 ** 2) throw new HubError('FILE_TOO_LARGE', 'The selected file is too large.');
  selections.set(id, { file, name, size: info.size, modified: info.mtimeMs, kind }); return { id, name, size: info.size } satisfies Selection;
}
async function chosen(id: string, kind: 'zip' | 'image') { idSchema.parse(id); const selection = selections.get(id); if (!selection || selection.kind !== kind) throw new HubError('FILE_REQUIRED', 'Select the file again.'); const info = await stat(selection.file); if (info.size !== selection.size || info.mtimeMs !== selection.modified) throw new HubError('FILE_CHANGED', 'The file changed. Select it again.'); return selection; }
async function uploadMedia(id: string) {
  await ensureUser(true); const file = await chosen(id, 'image');
  let image = nativeImage.createFromPath(file.file); if (image.isEmpty()) throw new HubError('INVALID_IMAGE', 'This picture could not be opened.');
  const dimensions = image.getSize(); const scale = Math.min(1, 1280 / Math.max(dimensions.width, dimensions.height));
  image = image.resize({ width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)), quality: 'best' });
  let bytes = image.toJPEG(86); if (bytes.length > 1100000) bytes = image.toJPEG(65);
  if (bytes.length > 1100000) { image = image.resize({ width: 800 }); bytes = image.toJPEG(70); }
  const size = image.getSize();
  const response = await fetchApi('/api/v1/admin/media', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length), 'x-image-width': String(size.width), 'x-image-height': String(size.height) }, body: new Uint8Array(bytes) });
  return response.json();
}
async function uploadMod(id: string, input: Omit<UploadInput, 'filename' | 'size' | 'sha256'>) {
  await ensureUser(true); const file = await chosen(id, 'zip'), jobId = randomUUID(), controller = new AbortController(); uploads.set(jobId, { controller });
  const run = async () => {
    emit({ id: jobId, name: file.name, kind: 'upload', stage: 'validating', bytes: 0, total: file.size, speed: 0 }); let poll: NodeJS.Timeout | undefined;
    try {
      await validateArchive(file.file); const sha256 = await fileHash(file.file);
      const detected = await inspectMod(file.file);
      input = { ...input, metadata: { ...input.metadata, creator: input.metadata.creator && input.metadata.creator !== 'Unknown' ? input.metadata.creator : detected.creator, type: detected.type, tags: input.metadata.tags.length ? input.metadata.tags : detected.tags, manufacturer: input.metadata.manufacturer || detected.manufacturer, model: input.metadata.model || detected.model, years: input.metadata.years || detected.years } };
      if (controller.signal.aborted) throw new HubError('CANCELLED', 'Upload cancelled.');
      const init = await api('/api/v1/admin/uploads/init', 'POST', { ...input, filename: file.name, size: file.size, sha256 }); uploads.get(jobId)!.serverId = init.id;
      if (init.chunkSize && init.partsPath && init.completePath) {
        idSchema.parse(init.id);
        if (!Number.isSafeInteger(init.chunkSize) || init.chunkSize < 1048576 || init.chunkSize > 33554432 || init.partsPath !== `/api/v1/admin/uploads/${init.id}/parts` || init.completePath !== `/api/v1/admin/uploads/${init.id}/complete`) throw new HubError('INVALID_RESPONSE', 'The upload response was invalid.');
        const fileHandle = await openFile(file.file, 'r'); let sent = 0; const started = Date.now();
        try {
          for (let index = 0; sent < file.size; index++) {
            controller.signal.throwIfAborted();
            const length = Math.min(Number(init.chunkSize), file.size - sent), bytes = Buffer.alloc(length);
            const read = await fileHandle.read(bytes, 0, length, sent); if (read.bytesRead !== length) throw new HubError('FILE_CHANGED', 'The ZIP changed during upload.');
            const digest = createHash('sha256').update(bytes).digest('hex');
            await fetchApi(`${init.partsPath}/${index}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(length), 'x-part-sha256': digest }, body: bytes, signal: controller.signal });
            sent += length; emit({ id: jobId, name: file.name, kind: 'upload', stage: 'transferring', bytes: sent, total: file.size, speed: sent * 1000 / Math.max(1, Date.now() - started) });
          }
        } finally { await fileHandle.close(); }
        await api(init.completePath, 'POST', {});
        const deadline = Date.now() + 30 * 60000;
        while (Date.now() < deadline) {
          controller.signal.throwIfAborted(); const status = await api(`/api/v1/admin/uploads/${init.id}`);
          if (status.status === 'completed') { emit({ id: jobId, name: file.name, modId: status.modId, kind: 'upload', stage: 'completed', bytes: file.size, total: file.size, speed: 0 }); selections.delete(id); return; }
          if (['failed', 'cancelled'].includes(status.status)) throw new HubError(status.errorCode || 'UPLOAD_FAILED', 'GitHub could not publish the ZIP.');
          emit({ id: jobId, name: file.name, kind: 'upload', stage: 'storing', bytes: file.size, total: file.size, speed: 0 });
          await waitForStatus(3000, undefined, { signal: controller.signal });
        }
        throw new HubError('PUBLISH_TIMEOUT', 'GitHub is still processing this upload. Check the library shortly.');
      }
      let bytes = 0, previous = 0, tick = Date.now();
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; const now = Date.now(); if (now - tick > 200) { emit({ id: jobId, name: file.name, kind: 'upload', stage: 'transferring', bytes, total: file.size, speed: (bytes - previous) * 1000 / (now - tick) }); previous = bytes; tick = now; } callback(null, chunk); } });
      poll = setInterval(() => { api(`/api/v1/admin/uploads/${init.id}`).then(status => { if (['storing', 'validating'].includes(status.status)) emit({ id: jobId, name: file.name, kind: 'upload', stage: status.status, bytes: status.bytes, total: file.size, speed: 0 }); }).catch(() => {}); }, 1000);
      const stream = createReadStream(file.file).pipe(counter);
      const response = await fetchApi(init.path, { method: 'PUT', headers: { 'content-type': 'application/zip', 'content-length': String(file.size) }, body: stream as any, duplex: 'half', signal: controller.signal } as any);
      const result = await response.json() as any;
      emit({ id: jobId, name: file.name, modId: result.mod.id, kind: 'upload', stage: 'completed', bytes: file.size, total: file.size, speed: 0 }); selections.delete(id);
    } catch (error) { emit({ id: jobId, name: file.name, kind: 'upload', stage: controller.signal.aborted ? 'cancelled' : 'failed', bytes: 0, total: file.size, speed: 0, error: error instanceof HubError ? error.code : 'UPLOAD_FAILED' }); }
    finally { if (poll) clearInterval(poll); uploads.delete(jobId); }
  };
  void run(); return { id: jobId };
}
async function favoriteFile() { const member = await ensureUser(); return path.join(dataDir, 'favorites', `${member.id}.json`); }
async function call(method: string, args: any[]) {
  switch (method) {
    case 'bootstrap': return bootstrap();
    case 'connect': { const url = baseUrl(z.string().max(2048).parse(args[0])); lock(); await storeToken(''); settings.serverUrl = url; await writeJson(settingsFile, settings); return bootstrap(); }
    case 'login': return login();
    case 'cancelLogin': loginController?.abort(); return;
    case 'logout': loginController?.abort(); installer.cancelAll(); await api('/api/v1/auth/logout', 'POST', {}).catch(() => {}); await storeToken(''); lock(); return;
    case 'recheck': { const member = userSchema.parse(await api('/api/v1/auth/recheck-membership', 'POST', {})); user = member; return member; }
    case 'joinDiscord': return trustedExternal(inviteUrl);
    case 'request': if (!token) throw new HubError('UNAUTHORIZED', 'Sign in with Discord to continue.'); return resource(args[0], args[1]);
    case 'image': { if (!user || !token) throw new HubError('UNAUTHORIZED', 'Sign in with Discord to continue.', 401); const id = idSchema.parse(args[0]); if (!images.has(id)) { const response = await fetchApi(`/api/v1/media/${id}`); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 10 * 1024 ** 2) throw new HubError('IMAGE_TOO_LARGE', 'The image is too large.'); const mime = response.headers.get('content-type')?.split(';')[0] || ''; if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new HubError('INVALID_IMAGE', 'Unsupported picture format.'); images.set(id, `data:${mime};base64,${bytes.toString('base64')}`); if (images.size > 200) images.delete(images.keys().next().value!); } return images.get(id); }
    case 'settings': await ensureUser(); return settings;
    case 'setLanguage': {
      const language = z.enum(['ar', 'en']).parse(args[0]), area = z.enum(['app', 'admin']).parse(args[1]);
      await serializeFile(settingsFile, async () => { settings = { ...settings, [area === 'admin' ? 'adminLanguage' : 'language']: language }; await writeJson(settingsFile, settings); }); return;
    }
    case 'saveSettings': { await ensureUser(); const value = z.object({ language: z.enum(['ar', 'en']).optional(), parallelDownloads: z.number().int().min(1).max(3).optional() }).parse(args[0]); settings = { ...settings, ...value }; await writeJson(settingsFile, settings); return settings; }
    case 'chooseModsFolder': { await ensureUser(); const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.modsFolder }); if (!selected.canceled && selected.filePaths[0]) { settings.modsFolder = selected.filePaths[0]; await writeJson(settingsFile, settings); } return settings; }
    case 'openModsFolder': await ensureUser(); await mkdir(settings.modsFolder, { recursive: true }); return shell.openPath(settings.modsFolder);
    case 'installed': await ensureUser(); return installer.inspect();
    case 'install': { await ensureUser(); const id = idSchema.parse(args[0]), replace = z.boolean().default(false).parse(args[1]); const mod = await api<Mod>(`/api/v1/mods/${id}`); return installer.start(mod, replace); }
    case 'cancelJob': { const id = idSchema.parse(args[0]); const upload = uploads.get(id); if (upload) { if (upload.serverId) await api(`/api/v1/admin/uploads/${upload.serverId}/cancel`, 'POST', {}).catch(() => {}); upload.controller.abort(); } else installer.cancel(id); return; }
    case 'uninstall': { await ensureUser(); const id = idSchema.parse(args[0]); const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Uninstall'], defaultId: 0, cancelId: 0, message: 'Remove this ZIP installed by Team Razka Program?' }); if (result.response === 1) return installer.uninstall(id); return; }
    case 'restore': { await ensureUser(); const id = idSchema.parse(args[0]); const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Restore previous ZIP'], defaultId: 0, cancelId: 0, message: 'Restore the ZIP backed up before this installation?' }); if (result.response === 1) return installer.restore(id); return; }
    case 'pickFile': return pickFile(args[0]);
    case 'uploadMedia': return uploadMedia(args[0]);
    case 'uploadMod': return uploadMod(args[0], args[1]);
    case 'favorites': return readJson(await favoriteFile(), []);
    case 'favorite': { const file = await favoriteFile(), id = idSchema.parse(args[0]), enabled = z.boolean().parse(args[1]); return serializeFile(file, async () => { const current = new Set(await readJson<string[]>(file, [])); enabled ? current.add(id) : current.delete(id); const values = [...current]; await writeJson(file, values); return values; }); }
    case 'jobs': await ensureUser(); return [...progress.values()];
    case 'diagnostics': await ensureUser(); clipboard.writeText(JSON.stringify({ app: 'Team Razka Program', version: app.getVersion(), platform: process.platform, server: settings.serverUrl, modsFolder: settings.modsFolder, lastError }, null, 2)); return;
    case 'window': { const action = z.enum(['minimize', 'maximize', 'close']).parse(args[0]); if (action === 'close') window.close(); else if (action === 'minimize') window.minimize(); else window.isMaximized() ? window.unmaximize() : window.maximize(); return; }
    default: throw new HubError('INVALID_REQUEST', 'This request is not supported.');
  }
}
async function createWindow() {
  window = new BrowserWindow({ width: 1450, height: 900, minWidth: 1000, minHeight: 680, title: 'TEAM RAZKA PROGRAM', icon: path.join(root, 'assets', process.platform === 'win32' ? 'icon.ico' : 'logo.png'), backgroundColor: '#0B0B0D', frame: false, show: false, webPreferences: { preload: path.join(root, 'dist', 'desktop', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  if (isDev) await window.loadURL(process.env.HUB_DEV_URL!); else await window.loadURL('app://hub/index.html');
}
app.whenReady().then(async () => {
  await mkdir(dataDir, { recursive: true });
  const connection = await readJson<{ serverUrl: string }>(path.join(root, 'dist', 'desktop', 'connection.json'), { serverUrl: '' });
  settings = z.object({ serverUrl: z.string().max(2048), modsFolder: z.string().max(32768), language: z.enum(['ar', 'en']), adminLanguage: z.enum(['ar', 'en']).default('en'), parallelDownloads: z.number().int().min(1).max(3) }).parse(await readJson<Settings>(settingsFile, { serverUrl: process.env.PUBLIC_API_BASE_URL || connection.serverUrl, modsFolder: await discoverModsFolder(), language: 'ar', adminLanguage: 'en', parallelDownloads: 2 }));
  const detectedRepo = await discoverModsFolder();
  if (path.resolve(settings.modsFolder).toLowerCase() === path.dirname(detectedRepo).toLowerCase()) { settings.modsFolder = detectedRepo; await mkdir(detectedRepo, { recursive: true }); await writeJson(settingsFile, settings); }
  if (app.isPackaged && connection.serverUrl.startsWith('https:') && /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(settings.serverUrl)) { settings.serverUrl = connection.serverUrl; await writeJson(settingsFile, settings); }
  if (settings.serverUrl) settings.serverUrl = baseUrl(settings.serverUrl);
  try { const stored = JSON.parse(safeStorage.decryptString(await readFile(sessionFile))); if (stored.serverUrl === settings.serverUrl && stored.token) token = sessionTokenSchema.parse(stored.token); } catch {}
  installer = new Installer({ dataDir, folder: () => settings.modsFolder, concurrency: () => settings.parallelDownloads, ticket: id => api(`/api/v1/mods/${id}/download-ticket`, 'POST', {}), fetch: fetchApi, allocation: id => api(`/api/v1/downloads/${id}/pace`, 'POST', {}), report: async (id, result, sha256, errorCode) => { await api(`/api/v1/downloads/${id}/complete`, 'POST', { result, sha256, errorCode }); }, onProgress: emit });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const policy = isDev ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:5173; img-src 'self' data: https://cdn.discordapp.com; object-src 'none'; frame-src 'none'" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https://cdn.discordapp.com; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
  protocol.handle('app', async request => {
    const url = new URL(request.url); if (url.hostname !== 'hub' || request.method !== 'GET') return new Response('', { status: 403 });
    const directory = path.join(root, 'dist', 'renderer'); const file = path.resolve(directory, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${directory}${path.sep}`)) return new Response('', { status: 403 }); return net.fetch(pathToFileURL(file).toString());
  });
  ipcMain.handle('hub:call', async (event, input) => {
    try {
      const frame = event.senderFrame, expected = isDev ? new URL(process.env.HUB_DEV_URL!).origin : 'app://hub';
      if (event.sender !== window.webContents || frame !== window.webContents.mainFrame || !frame || (isDev ? new URL(frame.url).origin !== expected : !frame.url.startsWith('app://hub/'))) throw new HubError('UNTRUSTED_SENDER', 'This request is not allowed.');
      const value = z.object({ method: z.string().max(40), args: z.array(z.unknown()).max(3) }).parse(input);
      return { ok: true, data: await call(value.method, value.args) };
    } catch (error) { lastError = error instanceof HubError ? error.code : 'REQUEST_FAILED'; return { ok: false, error: { code: lastError, message: error instanceof HubError ? error.message : 'The request could not be completed.' } }; }
  });
  await createWindow();
  startUpdates(() => [...progress.values()].some(job => !['completed', 'cancelled', 'failed'].includes(job.stage)));
  setInterval(() => { if (user) ensureUser().catch(() => {}); }, 30000).unref();
});
app.on('window-all-closed', () => { installer?.cancelAll(); for (const upload of uploads.values()) upload.controller.abort(); app.quit(); });
