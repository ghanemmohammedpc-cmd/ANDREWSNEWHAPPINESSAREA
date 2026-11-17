import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest_path = ROOT / 'data/collection/manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
prepared = ROOT / 'data/collection/prepared'
nested_folder = ROOT / 'data/collection/nested'
prepared.mkdir(exist_ok=True)
nested_folder.mkdir(exist_ok=True)
extracted = {}
def save():
    temporary = manifest_path.with_suffix('.preparing')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(manifest_path)

for item in manifest['items']:
    if item['status'] != 'error':
        continue
    source = Path(item['file'])
    destination = prepared / item['filename']
    if destination.exists():
        continue
    actions = []
    try:
        with zipfile.ZipFile(source) as original:
            members = {}
            for entry in original.infolist():
                name = entry.filename.replace('\\', '/').lstrip('/')
                if entry.is_dir() or not name:
                    continue
                if '..' in name.split('/') or ':' in name:
                    raise ValueError('Unsafe archive path: ' + name)
                if name.lower().endswith(('.url', '.lnk')):
                    actions.append({'removedShortcut': name})
                    continue
                if name.lower().endswith('.zip'):
                    raw = original.read(entry)
                    with zipfile.ZipFile(io.BytesIO(raw)) as child:
                        if item['metadata']['type'] == 'map' and name.startswith('content/'):
                            for member in child.infolist():
                                if member.is_dir():
                                    continue
                                key = member.filename.replace('\\', '/').lstrip('/')
                                if '..' in key.split('/') or ':' in key:
                                    raise ValueError('Unsafe nested path')
                                members[key] = (copy.copy(member), child.read(member))
                            actions.append({'expandedMapFiles': name})
                        else:
                            digest = hashlib.sha256(raw).hexdigest()
                            target = nested_folder / Path(name).name
                            if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                                raise ValueError('Different nested mods share a filename.')
                            if not target.exists():
                                target.write_bytes(raw)
                            extracted[digest] = str(target)
                            actions.append({'separatedNestedMod': name})
                    continue
                members[name] = (copy.copy(entry), None)
            for entry in original.infolist():
                name = entry.filename.replace('\\', '/').lstrip('/')
                if name in members and members[name][1] is not None:
                    if name.endswith('/info.json'):
                        members[name] = (copy.copy(entry), None)
                    elif (entry.CRC, entry.file_size) != (members[name][0].CRC, members[name][0].file_size):
                        raise ValueError('Conflicting nested asset: ' + name)
            with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=5) as output:
                for name, (entry, raw) in members.items():
                    original_name = entry.filename
                    if item['filename'] == 'Tashaleh_cadenza_2021.zip':
                        name = 'vehicles/' + name
                    entry.filename = name
                    entry.orig_filename = name
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    if raw is not None:
                        output.writestr(entry, raw)
                    else:
                        with original.open(original_name) as source_stream, output.open(entry, 'w') as target_stream:
                            shutil.copyfileobj(source_stream, target_stream, 1024 * 1024)
        with zipfile.ZipFile(destination) as checked:
            if checked.testzip() is not None:
                raise ValueError('Prepared ZIP failed CRC verification.')
        item.update(originalFile=str(source), file=str(destination), status='prepared', packagingRepairs=actions)
        item.pop('error', None)
        save()
        print('Prepared ' + item['filename'], flush=True)
    except Exception as error:
        item['preparationError'] = str(error)
        save()
        print('Needs attention: ' + item['filename'] + ': ' + str(error), flush=True)

known = {item.get('sha256') for item in manifest['items']}
for digest, file in extracted.items():
    if digest not in known:
        manifest['items'].append({'file': file, 'filename': Path(file).name, 'sha256': digest, 'status': 'prepared', 'metadata': {'name': Path(file).stem.replace('_', ' '), 'creator': 'Unknown', 'type': 'addon'}, 'evidence': {'source': 'Nested archive in the collection'}})

toxic = next(item for item in manifest['items'] if item['filename'] == 'Toxic Street V1.1 - F33.zip')
override = Path(os.environ['LOCALAPPDATA']) / 'BeamNG/BeamNG.drive/current/levels/0toxic_street_v1_1'
if not toxic.get('userLevelOverrides'):
    source = Path(toxic['file'])
    destination = prepared / toxic['filename']
    files = {f'levels/0toxic_street_v1_1/{file.relative_to(override).as_posix()}': file for file in override.rglob('*') if file.is_file() and file.suffix.lower() not in ['.bak', '.tmp', '.log']}
    if not files:
        raise ValueError('The user level overrides were not found.')
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=5) as output:
        for entry in original.infolist():
            if entry.filename not in files:
                with original.open(entry) as src, output.open(entry, 'w') as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
        for name, file in files.items():
            output.write(file, name)
    with zipfile.ZipFile(destination) as checked:
        if checked.testzip() is not None:
            raise ValueError('The combined Toxic Street ZIP failed CRC verification.')
        for name, file in files.items():
            if checked.read(name) != file.read_bytes():
                raise ValueError('A user level override did not match.')
    toxic.update(originalFile=str(source), file=str(destination), status='prepared', userLevelOverrides=len(files), renameListing=True)
    toxic['metadata']['name'] = 'Toxic Street — Fixed by Team Razka Server (Exclusive) | مُصلّحة بواسطة سيرفر Team Razka (حصري)'
    print('Prepared Toxic Street with ' + str(len(files)) + ' user level files.', flush=True)

save()
