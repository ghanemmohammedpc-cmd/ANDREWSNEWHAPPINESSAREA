import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { HubError } from '../shared/schema';

export async function validateArchive(filename: string): Promise<{ files: number; unpackedBytes: number }> {
  const magic = await new Promise<Buffer>((resolve, reject) => {
    const stream = createReadStream(filename, { start: 0, end: 3 }); const chunks: Buffer[] = [];
    stream.on('data', c => chunks.push(c as Buffer)); stream.on('end', () => resolve(Buffer.concat(chunks))); stream.on('error', reject);
  });
  if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new HubError('INVALID_ZIP', 'This file is not a supported ZIP archive.');
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: true }, (error, zip) => {
      if (error || !zip) return reject(new HubError('INVALID_ZIP', 'The ZIP archive is damaged.'));
      let files = 0, unpackedBytes = 0, modContent = false, done = false;
      const names = new Set<string>();
      const fail = (message: string) => { if (done) return; done = true; zip.close(); reject(new HubError('UNSAFE_ZIP', message)); };
      zip.on('error', () => fail('The ZIP archive could not be verified.'));
      zip.on('entry', async (entry: yauzl.Entry) => {
        if (done) return;
        const name = entry.fileName.replace(/\\/g, '/');
        if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\0') || name.split('/').some(part => part === '..' || part.includes(':'))) return fail('The ZIP contains an unsafe file path.');
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) return fail('Encrypted files and symbolic links are not supported.');
        if (names.has(name.toLowerCase())) return fail('The ZIP contains duplicate file paths.');
        names.add(name.toLowerCase());
        if (name.endsWith('/')) { zip.readEntry(); return; }
        if (/\.(exe|msi|com|cmd|bat|ps1|vbs|scr|dll|lnk|url|sys|jar)$/i.test(name)) return fail('This archive contains an executable. Installable mods must not run programs.');
        if (/\.zip$/i.test(name)) return fail('Select the installable mod ZIP, not an archive containing other ZIP files.');
        files++; unpackedBytes += entry.uncompressedSize;
        if (files > 100000 || unpackedBytes > 12 * 1024 ** 3 || entry.uncompressedSize > 4 * 1024 ** 3 || entry.uncompressedSize > Math.max(entry.compressedSize, 1) * 2000) return fail('This ZIP exceeds the supported archive limits.');
        if (/^(vehicles|levels|lua|art|ui|settings)\//i.test(name)) modContent = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail('The ZIP contains a damaged entry.');
          let checksum = 0, actualSize = 0;
          stream.on('data', (chunk: Buffer) => { actualSize += chunk.length; checksum = crc32(chunk, checksum); if (actualSize > entry.uncompressedSize) { stream.destroy(); fail('The ZIP entry size is invalid.'); } });
          stream.on('error', () => fail('The ZIP contains a damaged compressed file.'));
          stream.on('end', () => {
            if (done) return;
            if (actualSize !== entry.uncompressedSize || checksum >>> 0 !== entry.crc32 >>> 0) return fail('The ZIP checksum does not match.');
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (done) return;
        if (!files || !modContent) return fail('This ZIP does not contain a directly installable BeamNG mod.');
        done = true; resolve({ files, unpackedBytes });
      });
      zip.readEntry();
    });
  });
}
