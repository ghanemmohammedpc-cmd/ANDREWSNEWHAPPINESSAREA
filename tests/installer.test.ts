import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Installer, installVerified, fileHash } from '../desktop/installer';
import { modSchema, userSchema, type Mod, type Progress } from '../shared/schema';
import { validateArchive } from '../server/archive';
import { temporary, cleanup, modFile, zipFile } from './fixtures';

let folder = '';
afterEach(async () => { if (folder) { await cleanup(folder); folder = ''; } });
async function fixture() {
  folder = await temporary(); const mod = await modFile(folder);
  const source = await readFile(path.join(folder, 'latest-source.txt'), 'utf8');
  return { mod, source, options: { part: source, folder: path.join(folder, 'mods'), version: mod.activeVersion!, replace: false, backupFolder: path.join(folder, 'backups') } };
}
describe('safe BeamNG installation', () => {
  it('keeps the exact basename and leaves unrelated staging files alone', async () => {
    const { options } = await fixture(); await mkdir(options.folder);
    const unrelated = path.join(options.folder, options.version.filename + '.installing'); await writeFile(unrelated, 'unrelated');
    const result = await installVerified(options);
    expect(path.basename(result.path)).toBe(options.version.filename);
    expect(await fileHash(result.path)).toBe(options.version.sha256);
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated');
  });
  it('backs up replacements and refuses a corrupt existing backup', async () => {
    const { options } = await fixture(); await mkdir(options.folder);
    const target = path.join(options.folder, options.version.filename); await writeFile(target, 'original bytes');
    await expect(installVerified(options)).rejects.toMatchObject({ code: 'REPLACE_REQUIRED' });
    expect(await readFile(target, 'utf8')).toBe('original bytes');
    const result = await installVerified({ ...options, replace: true });
    expect(await readFile(result.backup!, 'utf8')).toBe('original bytes');
    await writeFile(target, 'original bytes'); await writeFile(result.backup!, 'damaged backup');
    await expect(installVerified({ ...options, replace: true })).rejects.toMatchObject({ code: 'BACKUP_FAILED' });
    expect(await readFile(target, 'utf8')).toBe('original bytes');
  });
  it('rejects a failed checksum before changing the destination', async () => {
    const { options } = await fixture(); await mkdir(options.folder);
    const target = path.join(options.folder, options.version.filename); await writeFile(target, 'untouched');
    await expect(installVerified({ ...options, replace: true, version: { ...options.version, sha256: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });
  it('detects ZIP CRC corruption and nested archives', async () => {
    folder = await temporary(); const zip = path.join(folder, 'test.zip');
    await zipFile(zip, { 'vehicles/test/info.json': 'unique CRC payload' });
    const data = await readFile(zip); data[data.indexOf(Buffer.from('unique CRC payload'))] ^= 1; await writeFile(zip, data);
    await expect(validateArchive(zip)).rejects.toMatchObject({ code: 'UNSAFE_ZIP' });
    await zipFile(zip, { 'vehicles/test/info.json': '{}', 'nested.zip': 'nested' });
    await expect(validateArchive(zip)).rejects.toMatchObject({ code: 'UNSAFE_ZIP' });
  });
  it('rejects remote identifiers and avatar URLs that could escape trusted locations', async () => {
    const { mod } = await fixture();
    expect(modSchema.safeParse({ ...mod, activeVersion: { ...mod.activeVersion, id: '../../outside' } }).success).toBe(false);
    expect(userSchema.safeParse({ id: '../outside', name: 'User', avatar: null, admin: false, mode: 'discord', verifiedAt: 0 }).success).toBe(false);
    expect(userSchema.safeParse({ id: '123456789012345678', name: 'User', avatar: 'https://example.com/track', admin: false, mode: 'discord', verifiedAt: 0 }).success).toBe(false);
  });
  it('preserves every record when nine installations complete concurrently', async () => {
    const { mod, source } = await fixture(); const data = await readFile(source); const mods: Mod[] = [];
    for (let n = 0; n < 9; n++) { const id = randomUUID(); mods.push({ ...mod, id, name: `Vehicle ${n}`, activeVersion: { ...mod.activeVersion!, id: randomUUID(), modId: id, filename: `Vehicle ${n}.zip` } }); }
    const report = vi.fn(async () => {}); const stages: Progress[] = [];
    const installer = new Installer({ dataDir: folder, folder: () => path.join(folder, 'mods'), concurrency: () => 3,
      ticket: async id => { const version = mods.find(m => m.id === id)!.activeVersion!; const ticketId = randomUUID(); return { id: ticketId, path: `/api/v1/downloads/${ticketId}/file`, version, expiresAt: Date.now() + 60000 }; },
      fetch: async () => new Response(data), report, onProgress: stage => stages.push(stage) });
    mods.forEach(item => installer.start(item)); await installer.settled();
    expect(Object.keys(await installer.records()).sort()).toEqual(mods.map(m => m.id).sort());
    expect(stages.filter(s => s.stage === 'failed')).toEqual([]);
    expect(report).toHaveBeenCalledTimes(9);
    expect((await readdir(path.join(folder, 'mods'))).filter(f => f.endsWith('.zip'))).toHaveLength(9);
  });
  it('resumes a full partial file with a real final-byte request before reporting completion', async () => {
    const { mod, source } = await fixture(); const data = await readFile(source); const downloads = path.join(folder, 'downloads'); await mkdir(downloads);
    await writeFile(path.join(downloads, `${mod.activeVersion!.id}.part`), data);
    const ticketId = randomUUID(); const report = vi.fn(async () => {});
    const fetch = vi.fn(async (_path: string, options: RequestInit) => { expect(new Headers(options.headers).get('range')).toBe(`bytes=${data.length - 1}-`); return new Response(data.subarray(-1), { status: 206, headers: { 'content-range': `bytes ${data.length - 1}-${data.length - 1}/${data.length}` } }); });
    const installer = new Installer({ dataDir: folder, folder: () => path.join(folder, 'mods'), concurrency: () => 1, ticket: async () => ({ id: ticketId, path: `/api/v1/downloads/${ticketId}/file`, version: mod.activeVersion!, expiresAt: Date.now() + 60000 }), fetch, report, onProgress: () => {} });
    installer.start(mod); await installer.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(ticketId, 'completed', mod.activeVersion!.sha256);
    expect(await fileHash(path.join(folder, 'mods', mod.activeVersion!.filename))).toBe(mod.activeVersion!.sha256);
  });
});
