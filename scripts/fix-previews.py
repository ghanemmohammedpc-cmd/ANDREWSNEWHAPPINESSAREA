import hashlib
import io
import json
from pathlib import Path
import re
import sys
import zipfile
from PIL import Image
import json5

ROOT = Path(__file__).resolve().parents[1]
manifest_path = ROOT / 'data/collection/manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
new_only = '--new-cars' in sys.argv
used = set()
def signature(raw):
    return hashlib.sha256(Image.open(io.BytesIO(raw)).convert('RGB').resize((96, 54)).tobytes()).hexdigest()

def blue_background(raw):
    image = Image.open(io.BytesIO(raw)).convert('RGB').resize((96, 54))
    pixels = list(image.getdata())
    top = pixels[:96 * 16]
    return sum(g > 60 and b > 55 and r < g * .55 and r < b * .7 for r, g, b in top) / len(top) > .48
for item in manifest['items']:
    if item.get('metadata', {}).get('type') != 'car' or new_only and not item.get('sourceFile'):
        continue
    try:
        with zipfile.ZipFile(item['file']) as archive:
            names = archive.namelist()
            pcs = {name[:-3].lower() for name in names if name.lower().endswith('.pc')}
            defaults = set()
            for name in names:
                if re.match(r'^vehicles/(?!common/)[^/]+/info.json$', name, re.I):
                    try:
                        data = json5.loads(archive.read(name).decode('utf-8-sig'))
                        defaults.add(name.rsplit('/', 1)[0] + '/' + str(data.get('default_pc', '')))
                    except Exception:
                        pass
            candidates = [name for name in names if re.match(r'^vehicles/(?!common/)[^/]+/[^/]+\.(png|jpe?g|webp)$', name, re.I) and (name.rsplit('.', 1)[0].lower() in pcs or re.search(r'/(default|preview|thumbnail)\.', name, re.I))]
            candidates.sort(key=lambda name: (0 if name.rsplit('.', 1)[0] in defaults else 1 if re.search(r'/default\.', name, re.I) else 2 if re.search(r'/standard\.', name, re.I) else 3, name.lower()))
            chosen = None
            if item.get('cleanedPreview'):
                chosen = (Path(item['cleanedPreview']).read_bytes(), 'Saved cleaned preview for this mod')
            else:
                for name in candidates:
                    raw = archive.read(name)
                    if signature(raw) in used or blue_background(raw):
                        continue
                    im = Image.open(io.BytesIO(raw)).convert('RGB')
                    if im.width < 200 or im.height < 100:
                        continue
                    chosen = (raw, name)
                    break
            if chosen:
                raw, member = chosen
                used.add(signature(raw))
                image = Image.open(io.BytesIO(raw)).convert('RGB')
                image.thumbnail((960, 600))
                picture = ROOT / 'data/collection/pictures' / (item['sha256'] + '.jpg')
                buffer = io.BytesIO()
                image.save(buffer, 'JPEG', quality=85)
                previous = Path(item['picture']).read_bytes() if item.get('picture') and Path(item['picture']).is_file() else b''
                current = buffer.getvalue()
                if previous != current:
                    item['thumbnailNeedsSync'] = True
                picture.write_bytes(current)
                item['picture'] = str(picture)
                item.setdefault('evidence', {})['sourcePicture'] = {'zip': item['file'], 'member': member}
                print('Selected own preview: ' + item['filename'], flush=True)
    except Exception as error:
        item['previewError'] = str(error)[:200]
temporary = manifest_path.with_suffix('.previews')
temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
temporary.replace(manifest_path)
