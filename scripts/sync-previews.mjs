import { readFile, writeFile, rename } from 'node:fs/promises';
import sharp from 'sharp';
import { parse } from 'dotenv';
const config = parse(await readFile('.env', 'utf8'));
const manifestPath = 'data/collection/manifest.json', manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const journal = JSON.parse(await readFile('data/collection/publication.json', 'utf8'));
for (const item of manifest.items) {
  if (!item.thumbnailNeedsSync || !item.picture || journal[item.sha256]?.status !== 'published') continue;
  const bytes = await readFile(item.picture), info = await sharp(bytes).metadata();
  const response = await fetch('https://team-razka-program.team-razka-program.workers.dev/api/v1/publish/thumbnail', { method: 'POST', headers: { authorization: `Bearer ${config.PUBLISH_CALLBACK_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: config.ADMIN_DISCORD_IDS.split(',')[0].trim(), sha256: item.sha256, body: bytes.toString('base64'), width: info.width, height: info.height }), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Thumbnail update ${response.status}: ${result.error?.code || 'failed'}`);
  item.thumbnailNeedsSync = false;
  console.log(`Live preview: ${item.filename}`);
  await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2)); await rename(manifestPath + '.tmp', manifestPath);
}
