import { readFile, writeFile, rename } from 'node:fs/promises';
import { inspectMod } from '../desktop/metadata';
const file = 'data/collection/manifest.json', manifest = JSON.parse(await readFile(file, 'utf8'));
const counts: Record<string, number> = {};
for (const item of manifest.items) {
  if (item.status !== 'ready' || item.metadata.type !== 'car') continue;
  const detected = await inspectMod(item.file);
  item.metadata.tags = [...new Set([...item.metadata.tags.filter((tag: string) => !['sedan', 'suv', 'pickup', 'coupe', 'hatchback'].includes(tag)), ...detected.tags])];
  for (const tag of detected.tags) counts[tag] = (counts[tag] || 0) + 1;
}
await writeFile(file + '.tmp', JSON.stringify(manifest, null, 2)); await rename(file + '.tmp', file);
console.log(JSON.stringify(counts));
