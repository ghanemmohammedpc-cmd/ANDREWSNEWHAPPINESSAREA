import { afterEach, expect, it } from 'vitest';
import path from 'node:path';
import { inspectMod } from '../desktop/metadata';
import { cleanup, temporary, zipFile } from './fixtures';
let folder = '';
afterEach(async () => { if (folder) { await cleanup(folder); folder = ''; } });
it('recognizes a complete car with configurations and JBeam even without vehicle info metadata', async () => {
  folder = await temporary(); const file = path.join(folder, 'Cadenza 2021.zip');
  await zipFile(file, { 'vehicles/cadenza/standard.pc': '{}', 'vehicles/cadenza/main.jbeam': '{}' });
  expect(await inspectMod(file)).toMatchObject({ type: 'car', years: '2021', tags: ['sedan'] });
});
it('keeps common vehicle parts in Extra', async () => {
  folder = await temporary(); const file = path.join(folder, 'Parts.zip');
  await zipFile(file, { 'vehicles/common/part.pc': '{}', 'vehicles/common/part.jbeam': '{}' });
  expect(await inspectMod(file)).toMatchObject({ type: 'addon' });
});
