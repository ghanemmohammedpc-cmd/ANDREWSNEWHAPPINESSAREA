import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { ZipFile } from 'yazl';
import { fileHash } from '../desktop/installer';
import { metadataSchema, type Mod } from '../shared/schema';

const prefix = path.join(os.tmpdir(), 'razka-program-test-');
export async function temporary() { return mkdtemp(prefix); }
export async function cleanup(folder: string) {
  const target = path.resolve(folder);
  if (!target.startsWith(prefix) || path.dirname(target) !== os.tmpdir()) throw new Error('Unexpected test directory.');
  await rm(target, { recursive: true, force: true });
}
export async function zipFile(file: string, entries: Record<string, string> = { 'vehicles/test/info.json': '{"Name":"Test vehicle"}' }) {
  const zip = new ZipFile();
  for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name, { compress: false });
  zip.end(); await pipeline(zip.outputStream, createWriteStream(file));
}
export async function modFile(folder: string, filename = 'Original name - Creator.zip'): Promise<Mod> {
  const source = path.join(folder, `${randomUUID()}.zip`); await zipFile(source);
  const { size } = await import('node:fs/promises').then(fs => fs.stat(source));
  const id = randomUUID();
  await writeFile(path.join(folder, 'latest-source.txt'), source);
  return { ...metadataSchema.parse({ name: filename.slice(0, -4), creator: 'Creator', type: 'car' }), id, status: 'published', createdAt: Date.now(), updatedAt: Date.now(), downloads: 0, rating: null, reviewCount: 0,
    activeVersion: { id: randomUUID(), modId: id, filename, version: '1', changelog: '', size, sha256: await fileHash(source), createdAt: Date.now() } };
}
