import ast
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
manifest_path = ROOT / 'data/collection/manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
helper = ROOT.parent / 'work/njm-repair/prepare_collection.py'
tree = ast.parse(helper.read_text(encoding='utf-8'))
definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'write_zip')
exec(compile(ast.Module(body=[definition], type_ignores=[]), str(helper), 'exec'))

def checked_replace(source, mapping, replacements, omitted):
    stage = source.with_suffix('.preview.pending')
    if stage.exists():
        raise ValueError('A pending preview package already exists: ' + str(stage))
    write_zip(source, stage, mapping, replacements, omitted)
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(stage) as new:
        if new.testzip() is not None:
            raise ValueError('Preview ZIP failed CRC validation')
        for entry in old.infolist():
            if entry.filename in omitted or entry.filename in replacements:
                continue
            current = new.getinfo(mapping[entry.filename])
            if (current.CRC, current.file_size) != (entry.CRC, entry.file_size):
                raise ValueError('An unrelated asset changed: ' + entry.filename)
        for name, raw in replacements.items():
            if new.read(mapping[name]) != raw:
                raise ValueError('A preview replacement did not match')
    stage.replace(source)

toxic = next(item for item in manifest['items'] if item['filename'] == 'Toxic Street V1.1 - F33.zip')
with zipfile.ZipFile(toxic['file']) as archive:
    groups = {}
    for entry in archive.infolist():
        groups.setdefault(entry.filename.casefold(), []).append(entry)
    omitted = set()
    mapping = {}
    for entries in groups.values():
        chosen = next((entry for entry in reversed(entries) if entry.filename.startswith('levels/0toxic_street_v1_1/')), entries[-1])
        omitted.update(entry.filename for entry in entries if entry is not chosen)
        for entry in entries:
            mapping[entry.filename] = entry.filename.replace('levels/0Toxic_Street_v1_1/', 'levels/0toxic_street_v1_1/')
if omitted:
    checked_replace(Path(toxic['file']), mapping, {}, omitted)
    toxic['status'] = 'prepared'
    print('Merged case-insensitive Toxic Street overrides: ' + str(len(omitted)), flush=True)

plans = json.loads((ROOT.parent / 'work/njm-repair/embedded-preview-plan.json').read_text(encoding='utf-8'))
generated = json.loads((ROOT.parent / 'work/njm-repair/generated-embedded-preview-manifest.json').read_text(encoding='utf-8'))
known = {}
for plan in plans:
    image = next((row['path'] for row in generated if plan['id'].startswith(row['id'])), plan.get('reuse'))
    if image and Path(image).is_file():
        for asset in plan['assets']:
            known[(Path(asset['zip']).name.casefold(), asset['member'])] = image
audit = json.loads((ROOT / 'data/collection/blue-previews.json').read_text(encoding='utf-8'))
range_item = next(item for item in manifest['items'] if item['filename'] == 'Range Rover Vogue 2014 - car4k.zip')
range_item['cleanedPreview'] = str(ROOT.parent / 'outputs/car_previews/Range Rover Vogue 2014 - car4k.png')
for row in audit:
    item = next((item for item in manifest['items'] if item['filename'].casefold() == Path(row['path']).name.casefold()), None)
    if not item or item.get('embeddedPreviewsUpdated'):
        continue
    source = Path(item['file'])
    replacements = {}
    with zipfile.ZipFile(source) as archive:
        mapping = {entry.filename: entry.filename for entry in archive.infolist()}
        for member in row['teal']:
            image = known.get((item['filename'].casefold(), member))
            if item.get('cleanedPreview'):
                image = item['cleanedPreview']
            if image:
                raw = Path(image).read_bytes()
            elif row['clean']:
                raw = archive.read(row['clean'][0])
            else:
                raise ValueError('No clean preview for ' + item['filename'])
            preview = Image.open(io.BytesIO(raw)).convert('RGB')
            preview.thumbnail((1920, 1080))
            buffer = io.BytesIO()
            preview.save(buffer, 'PNG' if member.lower().endswith('.png') else 'JPEG', **({} if member.lower().endswith('.png') else {'quality': 94}))
            replacements[member] = buffer.getvalue()
    backup = Path('E:/BeamNG_Mods_Backups/Preview cleanup') / item['sha256'] / item['filename']
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        with source.open('rb') as src, backup.open('xb') as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
    if hashlib.file_digest(backup.open('rb'), 'sha256').hexdigest() != item['sha256']:
        raise ValueError('Preview backup checksum mismatch')
    checked_replace(source, mapping, replacements, set())
    item['status'] = 'prepared'
    item['embeddedPreviewsUpdated'] = list(replacements)
    print('Replaced embedded previews: ' + item['filename'], flush=True)
    pending = manifest_path.with_suffix('.repacking')
    pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    pending.replace(manifest_path)

pending = manifest_path.with_suffix('.repacking')
pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
pending.replace(manifest_path)
