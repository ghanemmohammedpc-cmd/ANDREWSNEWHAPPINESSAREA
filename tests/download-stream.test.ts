import { afterEach, expect, it, vi } from 'vitest';
import { verifiedStream } from '../cloudflare/download';
afterEach(() => vi.unstubAllGlobals());
it('uses the native fixed-length stream and records transfer only after it finishes', async () => {
  const native = vi.fn(function (_length: number) { return new TransformStream<Uint8Array, Uint8Array>(); });
  vi.stubGlobal('FixedLengthStream', native);
  const completed = vi.fn(async () => {}), background: Promise<unknown>[] = [];
  const bytes = new Uint8Array(1024 * 1024).fill(17);
  const output = verifiedStream(new Response(bytes).body!, bytes.length, completed, { waitUntil: promise => background.push(promise) });
  expect(native).toHaveBeenCalledWith(bytes.length); expect(completed).not.toHaveBeenCalled();
  expect(new Uint8Array(await new Response(output).arrayBuffer())).toEqual(bytes);
  await Promise.all(background); expect(completed).toHaveBeenCalledTimes(1);
});
it('rejects truncated input without marking the download as transferred', async () => {
  vi.stubGlobal('FixedLengthStream', undefined);
  const completed = vi.fn(async () => {});
  await expect(new Response(verifiedStream(new Response('short').body!, 100, completed)).arrayBuffer()).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
  expect(completed).not.toHaveBeenCalled();
});
