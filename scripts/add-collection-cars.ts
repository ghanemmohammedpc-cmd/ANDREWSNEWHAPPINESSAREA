import { readFile, writeFile, rename, stat, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileHash } from '../desktop/installer';
import { validateArchive } from '../server/archive';
import { inspectMod } from '../desktop/metadata';
import { metadataSchema } from '../shared/schema';
const manifestPath = path.resolve('data/collection/manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const additions = [
  { source: 'E:/Tesla_Cybertruck_PACK_v1.0_by_Kenemation.zip', name: 'Tesla Cybertruck', creator: 'Kenemation', manufacturer: 'Tesla', model: 'Cybertruck', years: '' },
  { source: 'E:/Land_Cruiser_Lc70_2025.zip', name: 'Toyota Land Cruiser LC70 2025', creator: 'KHWYLD', manufacturer: 'Toyota', model: 'Land Cruiser LC70', years: '2025' },
  { source: 'E:/leaked mods/Safari_2024_KHwylD.zip', name: 'Nissan Safari 2024', creator: 'KHWYLD', manufacturer: 'Nissan', model: 'Safari', years: '2024' },
];
for (const item of additions) {
  const digest = await fileHash(item.source);
  if (manifest.items.some((row: any) => row.sha256 === digest)) continue;
  await validateArchive(item.source); const detected = await inspectMod(item.source);
  const file = path.join('E:/leaked mods', path.basename(item.source));
  if (path.resolve(file).toLowerCase() !== path.resolve(item.source).toLowerCase()) {
    try { await copyFile(item.source, file, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fileHash(file) !== digest) throw error; }
  }
  const info = await stat(file), metadata = metadataSchema.parse({ ...detected, ...item, type: 'car', years: item.years || detected.years });
  manifest.items.push({ file: path.resolve(file), sourceFile: path.resolve(item.source), filename: path.basename(file), size: info.size, modified: info.mtimeMs, sha256: digest, status: 'ready', metadata, evidence: { creator: 'User supplied archive and vehicle identifiers', sourcePicture: null } });
  console.log(`Added ${item.name} by ${item.creator}`);
}
await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2)); await rename(manifestPath + '.tmp', manifestPath);
