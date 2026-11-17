import { expect, it } from 'vitest';
import { DownloadPacer } from '../desktop/download-pace';
it('paces bytes to the current allocation rather than draining at unrestricted speed', async () => {
  const pacer = new DownloadPacer(1000), started = Date.now();
  await pacer.wait(150, new AbortController().signal);
  expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  expect(() => pacer.setRate(0)).toThrow();
});
it('cancels promptly while waiting for bandwidth', async () => {
  const pacer = new DownloadPacer(1), controller = new AbortController(), waiting = pacer.wait(1000, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
});
