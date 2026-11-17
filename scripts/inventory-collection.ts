import { readdir, readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import yauzl from 'yauzl';
import sharp from 'sharp';
import { fileHash } from '../desktop/installer';
import { inspectMod } from '../desktop/metadata';
import { validateArchive } from '../server/archive';
import { metadataSchema, safeFilename } from '../shared/schema';

const root = path.resolve(process.argv[2] || 'E:/leaked mods'), destination = path.resolve('data/collection');
await mkdir(destination, { recursive: true }); await mkdir(path.join(destination, 'pictures'), { recursive: true });
const manifestPath = path.join(destination, 'manifest.json');
let manifest: any = { root, items: [], startedAt: Date.now() };
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
async function save() { manifest.updatedAt = Date.now(); await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2)); await rename(manifestPath + '.tmp', manifestPath); }
async function walk(folder: string): Promise<string[]> { const files: string[] = []; for (const entry of await readdir(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) files.push(...await walk(file)); else if (/\.zip$/i.test(entry.name)) files.push(file); } return files; }
function arrayFromScript(html: string) {
  const start = /const\s+mods\s*=\s*\[/.exec(html); if (!start) return [];
  const from = start.index + start[0].length - 1; let depth = 0, string = false, escaped = false;
  for (let i = from; i < html.length; i++) { const c = html[i]; if (string) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') string = false; } else if (c === '"') string = true; else if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') { depth--; if (!depth) return JSON.parse(html.slice(from, i + 1)); } }
  return [];
}
const catalog = arrayFromScript(await readFile(path.join(root, 'Mods List.html'), 'utf8'));
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const byFilename = new Map<string, any>(catalog.filter((m: any) => m.file).map((m: any) => [path.basename(decode(m.file)).toLowerCase(), m]));
const brands: Record<string, string> = { camry: 'Toyota', corolla: 'Toyota', avalon: 'Toyota', yaris: 'Toyota', hilux: 'Toyota', fortuner: 'Toyota', landcruiser: 'Toyota', 'land cruiser': 'Toyota', j70: 'Toyota', accord: 'Honda', civic: 'Honda', sonata: 'Hyundai', elantra: 'Hyundai', accent: 'Hyundai', azera: 'Hyundai', optima: 'Kia', caprice: 'Chevrolet', cruze: 'Chevrolet', impala: 'Chevrolet', patrol: 'Nissan', safari: 'Nissan', maxima: 'Nissan', altima: 'Nissan', sunny: 'Nissan', dmax: 'Isuzu', 'd-max': 'Isuzu', crown: 'Toyota', cadenza: 'Kia', cerato: 'Kia', tahoe: 'Chevrolet', yukon: 'GMC', '280zx': 'Nissan' };
async function entries(file: string): Promise<{ fingerprint: string; picture?: Buffer }> {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) return reject(error); const rows: string[] = []; let best: yauzl.Entry | undefined, rank = -1;
    zip.on('error', reject);
    zip.on('entry', entry => {
      rows.push(`${entry.fileName}\0${entry.uncompressedSize}\0${entry.crc32}`);
      if (/\.(png|jpe?g|webp)$/i.test(entry.fileName) && entry.uncompressedSize < 12000000) {
        const score = /\/(default|preview)\.(png|jpe?g|webp)$/i.test(entry.fileName) ? 100 : /^(vehicles|levels)\/[^/]+\/[^/]+\.(png|jpe?g|webp)$/i.test(entry.fileName) ? 50 : 0;
        if (score > rank && score > 0) { rank = score; best = entry; }
      } zip.readEntry();
    });
    zip.on('end', () => { const fingerprint = createHash('sha256').update(rows.sort().join('\n')).digest('hex'); if (!best) { resolve({ fingerprint }); return; } zip.openReadStream(best, (e, stream) => { if (e || !stream) { reject(e); return; } const chunks: Buffer[] = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject); stream.on('end', () => { zip.close(); resolve({ fingerprint, picture: Buffer.concat(chunks) }); }); }); });
    zip.autoClose = false; zip.on('end', () => { if (!best) zip.close(); }); zip.readEntry();
  }));
}
const files = (await walk(root)).sort((a, b) => a.localeCompare(b));
for (let n = 0; n < files.length; n++) {
  const file = files[n], info = await stat(file); let item = manifest.items.find((m: any) => m.file === file);
  if (item?.size === info.size && item?.modified === info.mtimeMs && ['ready', 'duplicate', 'published'].includes(item.status)) continue;
  if (!item) { item = { file }; manifest.items.push(item); } Object.assign(item, { size: info.size, modified: info.mtimeMs, filename: path.basename(file), status: 'checking' }); await save();
  try {
    safeFilename(item.filename); item.normalizedName = item.filename.replace(/\.zip$/i, '').normalize('NFKC').toLowerCase().replace(/[ _.-]+/g, ' ').trim(); item.nameAndSizeMatches = manifest.items.filter((other: any) => other.file !== file && other.size === item.size && other.normalizedName === item.normalizedName).map((other: any) => other.file); item.sha256 = await fileHash(file);
    const archive = await entries(file); item.fingerprint = archive.fingerprint;
    const duplicate = manifest.items.find((other: any) => other.file !== file && ['ready', 'published'].includes(other.status) && (other.sha256 === item.sha256 || other.fingerprint === item.fingerprint));
    if (duplicate) { item.status = 'duplicate'; item.duplicateOf = duplicate.file; await save(); continue; }
    const detected = await inspectMod(file), curated = byFilename.get(item.filename.toLowerCase());
    const stem = item.filename.replace(/\.zip$/i, ''), name = curated?.name || stem.replace(/ - [^-]+$/, '').replace(/_/g, ' ').trim();
    const creator = curated?.creator && !/unverified|unknown/i.test(curated.creator) ? curated.creator : detected.creator;
    let manufacturer = detected.manufacturer;
    const explicit = /\b(Toyota|Honda|Hyundai|Kia|Nissan|Chevrolet|GMC|Lexus|Ford|Isuzu|BMW|Mercedes(?:-Benz)?|Genesis|Dodge|Jeep|Suzuki|Mazda|Mitsubishi)\b/i.exec(name);
    if (explicit) manufacturer = explicit[0];
    if (!manufacturer) for (const [model, brand] of Object.entries(brands)) if (name.toLowerCase().includes(model)) { manufacturer = brand; break; }
    const model = name.replace(/\b(?:19|20)\d{2}(?:\s*-\s*(?:19|20)\d{2})?\b/g, '').replace(new RegExp(`^${manufacturer}\\s*`, 'i'), '').trim();
    item.metadata = metadataSchema.parse({ name, creator: creator || 'Unknown', type: path.relative(root, file).startsWith('Maps' + path.sep) ? 'map' : detected.type, manufacturer, model, years: detected.years, description: '' });
    item.evidence = { catalog: Boolean(curated), creator: curated?.creator === creator ? 'existing catalog' : detected.creator !== 'Unknown' ? 'filename or embedded metadata' : 'unverified', sourcePicture: null };
    let image: Buffer | undefined;
    if (curated?.image) { const candidate = path.resolve(root, decode(curated.image)); if (candidate.startsWith(root + path.sep)) { try { image = await readFile(candidate); item.evidence.sourcePicture = candidate; } catch {} } }
    image ||= archive.picture;
    if (image) { const picture = path.join(destination, 'pictures', item.sha256 + '.jpg'); await sharp(image, { limitInputPixels: 85000000 }).resize({ width: 960, height: 600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(picture); item.picture = picture; }
    item.validation = await validateArchive(file); item.status = 'ready'; delete item.error;
  } catch (error) { item.status = 'error'; item.error = error instanceof Error ? error.message : 'Archive inspection failed.'; }
  await save(); console.log(`${n + 1}/${files.length}: ${item.status} — ${item.filename}`);
}
manifest.completedAt = Date.now(); await save();
console.log(JSON.stringify({ archives: files.length, ready: manifest.items.filter((m: any) => m.status === 'ready').length, duplicates: manifest.items.filter((m: any) => m.status === 'duplicate').length, errors: manifest.items.filter((m: any) => m.status === 'error').length }));
