import yauzl from 'yauzl';
import path from 'node:path';
export async function inspectMod(file: string): Promise<{ creator: string; type: 'car' | 'map' | 'addon'; manufacturer: string; model: string; years: string }> {
  const suffix = / - ([^/]+)\.zip$/i.exec(path.basename(file))?.[1]?.trim();
  const result = { creator: suffix && !/^\d/.test(suffix) ? suffix : 'Unknown', type: 'addon' as 'car' | 'map' | 'addon', manufacturer: '', model: '', years: /\b(?:19|20)\d{2}(?:\s*-\s*(?:19|20)\d{2})?\b/.exec(path.basename(file))?.[0] || '' };
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error); return; }
    let inspected = 0;
    zip.on('error', reject);
    zip.on('entry', entry => {
      if (/^vehicles\//i.test(entry.fileName)) result.type = 'car'; else if (/^levels\//i.test(entry.fileName)) result.type = 'map';
      if (inspected >= 8 || entry.uncompressedSize > 512000 || !/^(vehicles|levels)\/[^/]+\/info\.json$/i.test(entry.fileName)) { zip.readEntry(); return; }
      inspected++;
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) { zip.readEntry(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        stream.on('data', chunk => { bytes += chunk.length; if (bytes <= 512000) chunks.push(chunk); else stream.destroy(); });
        stream.on('error', () => zip.readEntry());
        stream.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
            const author = data.Authors || data.Author || data.authors || data.author;
            if (result.creator === 'Unknown' && typeof author === 'string' && author.trim() && !/^(beamng(?:\.drive)?|njm|unknown)$/i.test(author.trim())) result.creator = author.trim().slice(0, 120);
            if (typeof data.Brand === 'string') result.manufacturer = data.Brand.slice(0, 80);
            if (typeof data.Name === 'string') result.model = data.Name.slice(0, 100);
          } catch {}
          zip.readEntry();
        });
      });
    });
    zip.on('end', () => resolve(result)); zip.readEntry();
  }));
}
