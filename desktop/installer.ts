import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, statfs, lstat, copyFile, unlink, access, truncate } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HubError, safeFilename, idSchema, modSchema, versionSchema, type Mod, type ModVersion, type Progress } from '../shared/schema';
import { validateArchive } from '../server/archive';

export type Installed = { modId: string; name: string; versionId: string; filename: string; path: string; sha256: string; size: number; installedAt: number; managed: boolean; backup?: string; backupSha256?: string };
export type DownloadTicket = { id: string; path: string; version: ModVersion; expiresAt: number };
const ticketSchema = z.object({ id: idSchema, path: z.string(), version: versionSchema, expiresAt: z.number().int().positive() }).refine(value => value.path === `/api/v1/downloads/${value.id}/file`);
const stateQueues = new Map<string, Promise<unknown>>();
export function serializeFile<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file).toLowerCase();
  const result = (stateQueues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  stateQueues.set(key, result);
  void result.finally(() => { if (stateQueues.get(key) === result) stateQueues.delete(key); }).catch(() => {});
  return result;
}
export async function fileHash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true }); const pending = `${file}.${randomUUID()}.writing`;
  try { await writeFile(pending, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(pending, file); }
  finally { await unlink(pending).catch(() => {}); }
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new HubError('STATE_UNREADABLE', 'The saved app state could not be read.'); }
}
export async function discoverModsFolder(base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) {
  const ini = path.join(base, 'BeamNG', 'BeamNG.drive.ini'); let userFolder = path.join(base, 'BeamNG', 'BeamNG.drive', 'current');
  try {
    const text = await readFile(ini, 'utf8'); const match = /^\s*userFolder\s*=\s*(.*?)\s*$/im.exec(text);
    if (match?.[1]) {
      const value = match[1].replace(/^['"]|['"]$/g, '').replace(/%([^%]+)%/g, (whole, key: string) => process.env[key] || whole);
      userFolder = path.resolve(path.dirname(ini), value);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path.join(userFolder, 'mods');
}
export function checkedTarget(folder: string, filename: string) {
  safeFilename(filename); const root = path.resolve(folder), result = path.resolve(root, filename);
  if (path.dirname(result).toLowerCase() !== root.toLowerCase()) throw new HubError('INVALID_FILENAME', 'The destination must stay inside the mods folder.');
  const normalized = root.replace(/\\/g, '/').toLowerCase();
  if (/\/steamapps\/common\/beamng\.drive(?:\/|$)/.test(normalized)) throw new HubError('WRONG_FOLDER', 'Choose the BeamNG user mods folder, not the game installation folder.');
  return result;
}
async function regularFile(file: string) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new HubError('UNSAFE_DESTINATION', 'The destination is not a regular ZIP file.'); return info; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function installVerified(options: { part: string; folder: string; version: ModVersion; replace: boolean; backupFolder: string; signal?: AbortSignal; onInstalling?: () => void }): Promise<{ path: string; managed: boolean; backup?: string; backupSha256?: string }> {
  const { part, folder, version, replace, backupFolder } = options;
  versionSchema.parse(version); options.signal?.throwIfAborted();
  const target = checkedTarget(folder, version.filename); await mkdir(folder, { recursive: true }); await access(folder, constants.W_OK);
  const info = await stat(part);
  if (info.size !== version.size || await fileHash(part) !== version.sha256) throw new HubError('CHECKSUM_MISMATCH', 'The downloaded ZIP did not pass verification.');
  await validateArchive(part);
  options.signal?.throwIfAborted();
  const existing = await regularFile(target); let backup: string | undefined, backupSha256: string | undefined;
  if (existing) {
    const digest = await fileHash(target);
    if (digest === version.sha256 && existing.size === version.size) return { path: target, managed: false };
    if (!replace) throw new HubError('REPLACE_REQUIRED', 'A different ZIP with this filename already exists. Choose whether to back it up and replace it.', 409);
    await mkdir(backupFolder, { recursive: true }); backup = path.join(backupFolder, `${digest}.zip`);
    if (!await regularFile(backup)) await copyFile(target, backup, constants.COPYFILE_EXCL);
    if (await fileHash(backup) !== digest) throw new HubError('BACKUP_FAILED', 'The existing ZIP could not be backed up.');
    backupSha256 = digest;
  }
  const disk = await statfs(folder); if (disk.bavail * disk.bsize < version.size + 50 * 1024 ** 2) throw new HubError('DISK_SPACE', 'There is not enough free space in the mods folder.');
  const pending = `${target}.${randomUUID()}.installing`;
  let owned = false;
  try {
    await copyFile(part, pending, constants.COPYFILE_EXCL);
    owned = true;
    if (await fileHash(pending) !== version.sha256) throw new HubError('CHECKSUM_MISMATCH', 'The copied ZIP did not pass verification.');
    options.signal?.throwIfAborted(); options.onInstalling?.();
    const latest = await regularFile(target);
    if (existing ? !latest || await fileHash(target) !== backupSha256 : Boolean(latest)) throw new HubError('FILE_CHANGED', 'The destination changed during installation. Try again.');
    await rename(pending, target);
  } catch (error) {
    if (owned) await unlink(pending).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EBUSY') throw new HubError('FILE_LOCKED', 'The ZIP is in use. Close BeamNG and try again.');
    throw error;
  }
  return { path: target, managed: true, backup, backupSha256 };
}
export class Installer {
  private jobs = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  private active = 0; private waiting: Array<() => void> = []; private stateFile: string;
  constructor(private options: { dataDir: string; folder: () => string; concurrency: () => number; ticket: (modId: string) => Promise<DownloadTicket>; fetch: (path: string, options: RequestInit) => Promise<Response>; report: (id: string, result: 'completed' | 'failed' | 'cancelled', sha256?: string, errorCode?: string) => Promise<void>; onProgress: (value: Progress) => void }) { this.stateFile = path.join(options.dataDir, 'installed.json'); }
  async records() { return readJson<Record<string, Installed>>(this.stateFile, {}); }
  private mutateRecords<T>(task: (records: Record<string, Installed>) => T | Promise<T>) {
    return serializeFile(this.stateFile, async () => { const records = await this.records(); const result = await task(records); await writeJson(this.stateFile, records); return result; });
  }
  async inspect() {
    const records = await this.records(); const result: Record<string, Installed & { present: boolean; modified: boolean }> = {};
    for (const [id, record] of Object.entries(records)) {
      const info = await regularFile(record.path); const present = Boolean(info); const modified = Boolean(info && (info.size !== record.size || await fileHash(record.path) !== record.sha256));
      result[id] = { ...record, present, modified };
    }
    return result;
  }
  start(mod: Mod, replace = false) {
    mod = modSchema.parse(mod);
    if (!mod.activeVersion) throw new HubError('ASSET_MISSING', 'This mod has no downloadable file.');
    const id = mod.id; if (this.jobs.has(id)) throw new HubError('ALREADY_DOWNLOADING', 'This mod is already in the download queue.');
    const controller = new AbortController(); const promise = this.download(mod, replace, controller).finally(() => { this.jobs.delete(id); });
    promise.catch(() => {}); this.jobs.set(id, { controller, promise }); return { id };
  }
  cancel(id: string) { this.jobs.get(id)?.controller.abort(); }
  cancelAll() { for (const value of this.jobs.values()) value.controller.abort(); }
  async settled() { await Promise.allSettled([...this.jobs.values()].map(value => value.promise)); }
  private async permit(signal: AbortSignal) {
    while (this.active >= this.options.concurrency()) {
      await new Promise<void>((resolve, reject) => { const ready = () => { signal.removeEventListener('abort', abort); resolve(); }; const abort = () => { this.waiting = this.waiting.filter(v => v !== ready); reject(new HubError('CANCELLED', 'Download cancelled.')); }; signal.addEventListener('abort', abort, { once: true }); this.waiting.push(ready); if (signal.aborted) abort(); });
    }
    if (signal.aborted) throw new HubError('CANCELLED', 'Download cancelled.'); this.active++;
  }
  private async download(mod: Mod, replace: boolean, controller: AbortController) {
    const emit = (stage: Progress['stage'], bytes = 0, total: number | null = mod.activeVersion?.size || null, speed = 0, error?: string) => this.options.onProgress({ id: mod.id, modId: mod.id, name: mod.name, kind: 'download', stage, bytes, total, speed, error });
    emit('queued'); let acquired = false, ticket: DownloadTicket | null = null;
    const part = path.join(this.options.dataDir, 'downloads', `${mod.activeVersion!.id}.part`);
    try {
      await this.permit(controller.signal); acquired = true;
      await mkdir(path.dirname(part), { recursive: true });
      ticket = ticketSchema.parse(await this.options.ticket(mod.id));
      const version = ticket.version;
      if (version.id !== mod.activeVersion!.id || version.modId !== mod.id || version.sha256 !== mod.activeVersion!.sha256) throw new HubError('VERSION_CHANGED', 'A new mod version was published. Refresh the library and start again.');
      const folder = this.options.folder(); if (!folder) throw new HubError('FOLDER_REQUIRED', 'Choose your BeamNG mods folder in Settings.');
      const target = checkedTarget(folder, version.filename), current = await regularFile(target);
      if (current && current.size === version.size && await fileHash(target) === version.sha256) {
        await this.mutateRecords(records => { const previous = records[mod.id];
          records[mod.id] = { modId: mod.id, name: mod.name, versionId: version.id, filename: version.filename, path: target, sha256: version.sha256, size: version.size, installedAt: Date.now(), managed: previous?.managed || false, backup: previous?.backup, backupSha256: previous?.backupSha256 };
        }); emit('completed', version.size, version.size); return;
      }
      if (current && !replace) throw new HubError('REPLACE_REQUIRED', 'A different ZIP with this filename already exists. Back it up and replace it?', 409);
      let offset = (await regularFile(part))?.size || 0;
      if (offset > version.size) { await unlink(part); offset = 0; }
      if (offset === version.size) { offset--; await truncate(part, offset); }
      const disk = await statfs(this.options.dataDir); if (disk.bavail * disk.bsize < version.size - offset + 50 * 1024 ** 2) throw new HubError('DISK_SPACE', 'There is not enough free space to download this mod.');
      if (offset < version.size) {
        const response = await this.options.fetch(ticket.path, { signal: controller.signal, headers: offset ? { range: `bytes=${offset}-` } : {} });
        if (!response.ok || !response.body) throw new HubError(response.status === 401 ? 'DOWNLOAD_EXPIRED' : 'DOWNLOAD_FAILED', 'The download could not be started. Please try again.');
        if (offset && response.status !== 206) offset = 0;
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          if (!range || Number(range[1]) !== offset || Number(range[3]) !== version.size) throw new HubError('INVALID_RANGE', 'The server returned a different download range.');
        }
        let bytes = offset, sampleBytes = bytes, sampleTime = Date.now(), speed = 0;
        emit('transferring', bytes, version.size);
        const counter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => { bytes += chunk.length; if (bytes > version.size) { callback(new HubError('SIZE_MISMATCH', 'The download is larger than expected.')); return; } const now = Date.now(); if (now - sampleTime > 200) { speed = (bytes - sampleBytes) * 1000 / (now - sampleTime); sampleTime = now; sampleBytes = bytes; emit('transferring', bytes, version.size, speed); } callback(null, chunk); } });
        await pipeline(Readable.fromWeb(response.body as any), counter, createWriteStream(part, { flags: offset ? 'a' : 'w' }), { signal: controller.signal });
      }
      emit('validating', version.size, version.size);
      if (controller.signal.aborted) throw new HubError('CANCELLED', 'Download cancelled.');
      await serializeFile(target, async () => {
        const installed = await installVerified({ part, folder, version, replace, backupFolder: path.join(this.options.dataDir, 'backups'), signal: controller.signal, onInstalling: () => emit('installing', version.size, version.size) });
        await this.mutateRecords(records => { records[mod.id] = { modId: mod.id, name: mod.name, versionId: version.id, filename: version.filename, sha256: version.sha256, size: version.size, installedAt: Date.now(), ...installed }; });
      });
      await unlink(part).catch(() => {});
      await this.options.report(ticket.id, 'completed', version.sha256).catch(() => {}); emit('completed', version.size, version.size);
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof HubError && error.code === 'CANCELLED';
      const code = error instanceof HubError ? error.code : (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'DISK_SPACE' : 'DOWNLOAD_FAILED';
      if (code === 'CHECKSUM_MISMATCH' || code === 'UNSAFE_ZIP' || code === 'INVALID_ZIP') await unlink(part).catch(() => {});
      if (ticket) await this.options.report(ticket.id, cancelled ? 'cancelled' : 'failed', undefined, code).catch(() => {});
      emit(cancelled ? 'cancelled' : 'failed', (await regularFile(part))?.size || 0, mod.activeVersion!.size, 0, code); throw error;
    } finally { if (acquired) { this.active--; this.waiting.splice(0).forEach(ready => ready()); } }
  }
  async uninstall(id: string) {
    idSchema.parse(id);
    return this.mutateRecords(async records => { const record = records[id];
    if (!record?.managed) throw new HubError('NOT_MANAGED', 'This ZIP was not installed by the app.');
    const info = await regularFile(record.path);
    if (info && await fileHash(record.path) !== record.sha256) throw new HubError('FILE_MODIFIED', 'This ZIP changed after installation. It will not be removed.');
    if (info) await unlink(record.path); delete records[id]; return { ok: true }; });
  }
  async restore(id: string) {
    idSchema.parse(id);
    return this.mutateRecords(async records => { const record = records[id];
    if (!record?.managed || !record.backup || !record.backupSha256) throw new HubError('BACKUP_MISSING', 'There is no saved previous ZIP for this mod.');
    if (await fileHash(record.backup) !== record.backupSha256 || await fileHash(record.path) !== record.sha256) throw new HubError('FILE_MODIFIED', 'A file changed. Restore was stopped.');
    const pending = `${record.path}.${randomUUID()}.restoring`; let owned = false;
    try { await copyFile(record.backup, pending, constants.COPYFILE_EXCL); owned = true; if (await fileHash(pending) !== record.backupSha256) throw new HubError('BACKUP_FAILED', 'The saved ZIP did not pass verification.'); await rename(pending, record.path); }
    finally { if (owned) await unlink(pending).catch(() => {}); }
    delete records[id]; return { ok: true }; });
  }
}
