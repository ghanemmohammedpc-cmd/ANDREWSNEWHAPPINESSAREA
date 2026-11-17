import { HubError } from '../shared/schema';
export function downloadRange(size: number, range: string | null, response: Response) {
  let start = 0, end = size - 1;
  if (range) {
    const parsed = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!parsed) throw new HubError('INVALID_RANGE', 'Invalid download range.', 416);
    start = Number(parsed[1]); end = parsed[2] ? Math.min(Number(parsed[2]), size - 1) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new HubError('INVALID_RANGE', 'Invalid download range.', 416);
    if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) throw new HubError('INVALID_RANGE', 'The download server returned a different range.', 502);
  } else if (response.status !== 200) throw new HubError('SIZE_MISMATCH', 'The download server returned an incomplete file.', 502);
  const length = end - start + 1, header = response.headers.get('content-length');
  if (header !== null && Number(header) !== length) throw new HubError('SIZE_MISMATCH', 'The download size did not match the listing.', 502);
  return { start, end, length, reachesEnd: end === size - 1 };
}
export async function boundedBytes(request: Request, maximum: number) {
  if (Number(request.headers.get('content-length')) > maximum) throw new HubError('FILE_TOO_LARGE', 'The picture is too large.', 413);
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > maximum) throw new HubError('FILE_TOO_LARGE', 'The picture is too large.', 413); chunks.push(chunk.value); } }
  catch (error) { await reader.cancel(); throw error; }
  return new Uint8Array(Buffer.concat(chunks));
}
