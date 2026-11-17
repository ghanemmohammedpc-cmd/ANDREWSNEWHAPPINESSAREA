import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { fileHash } from '../desktop/installer';
import { inspectMod } from '../desktop/metadata';
import { validateArchive } from '../server/archive';
import { metadataSchema } from '../shared/schema';
const manifestPath = 'data/collection/manifest.json', manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const journal = JSON.parse(await readFile('data/collection/publication.json', 'utf8'));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
async function fingerprint(file: string): Promise<string> { return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => { if (error || !zip) return reject(error); const rows: string[] = []; zip.on('error', reject); zip.on('entry', entry => { rows.push(`${entry.fileName}\0${entry.uncompressedSize}\0${entry.crc32}`); zip.readEntry(); }); zip.on('end', () => resolve(createHash('sha256').update(rows.sort().join('\n')).digest('hex'))); zip.readEntry(); })); }
for (const item of manifest.items) {
  if (only && item.filename !== only || !['ready', 'prepared'].includes(item.status)) continue;
  try {
  const info = await stat(item.file);
  if (item.status === 'prepared' || item.modified !== info.mtimeMs || !item.fingerprint) {
    await validateArchive(item.file); const before = item.sha256, digest = await fileHash(item.file), detected = await inspectMod(item.file);
    if (before !== digest && journal[before]?.modId) item.replacesModId = journal[before].modId;
    const source = item.originalFile || item.file;
    const type = /[\\/]Extras[\\/]/i.test(source) ? 'addon' : /[\\/]Maps[\\/]/i.test(source) ? 'map' : detected.type;
    item.metadata = metadataSchema.parse({ ...detected, ...item.metadata, type, years: item.metadata.years || detected.years, creator: !item.metadata.creator || item.metadata.creator === 'Unknown' ? detected.creator : item.metadata.creator });
    Object.assign(item, { sha256: digest, size: info.size, modified: info.mtimeMs, fingerprint: await fingerprint(item.file), status: 'ready' });
    console.log(`Verified ${item.filename}`);
  }
  delete item.finalizationError;
  } catch (error) { item.finalizationError = error instanceof Error ? error.message : 'Validation failed'; console.log(`Needs attention: ${item.filename}: ${item.finalizationError}`); }
  await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2)); await rename(manifestPath + '.tmp', manifestPath);
}
const fingerprints = new Map<string, any>();
for (const item of [...manifest.items].sort((a, b) => Number(journal[b.sha256]?.status === 'published') - Number(journal[a.sha256]?.status === 'published'))) {
  if (item.status !== 'ready' || !item.fingerprint) continue;
  const existing = fingerprints.get(item.fingerprint);
  if (existing && journal[item.sha256]?.status !== 'published') {
    item.status = 'duplicate'; item.duplicateOf = existing.filename;
    console.log(`Already included: ${item.filename} (${existing.filename})`);
  } else if (!existing) fingerprints.set(item.fingerprint, item);
}
await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2)); await rename(manifestPath + '.tmp', manifestPath);
