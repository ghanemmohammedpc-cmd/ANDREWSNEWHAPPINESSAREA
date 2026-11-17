import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';
const origin = 'https://team-razka-program.team-razka-program.workers.dev', config = parse(await readFile('.env', 'utf8'));
const manifest = JSON.parse(await readFile('data/collection/manifest.json', 'utf8'));
const items = manifest.items.filter(item => item.status === 'ready' && item.metadata).map(item => ({ sha256: item.sha256, type: item.metadata.type, manufacturer: item.metadata.manufacturer, model: item.metadata.model, years: item.metadata.years, tags: item.metadata.tags, lightingUpdated: Boolean(item.metadata.lightingUpdated) }));
let updated = 0;
for (let offset = 0; offset < items.length; offset += 10) {
  const r = await fetch(`${origin}/api/v1/publish/metadata`, { method: 'POST', headers: { authorization: `Bearer ${config.PUBLISH_CALLBACK_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: config.ADMIN_DISCORD_IDS.split(',')[0].trim(), items: items.slice(offset, offset + 10) }), signal: AbortSignal.timeout(60000) });
  const result = await r.json(); if (!r.ok) throw new Error(`Metadata update failed (${r.status}): ${result.error?.code || 'Request failed'}`); updated += result.updated.length;
}
await writeFile('data/collection/metadata-sync.json', JSON.stringify({ updated, checked: items.length, completedAt: Date.now() }, null, 2));
console.log(`Updated metadata for ${updated} published listings.`);
