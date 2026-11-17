import json
import pathlib
import re
import zipfile
import json5

root = pathlib.Path(__file__).resolve().parents[1]
manifest_path = root / 'data/collection/manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
work = root.parent / 'work'
sources = [work / 'njm-repair/lighting-state.json', work / 'njm-repair/existing-lighting-state.json', work / 'repo-bulb-sonata-reference/installation-state.json', work / 'repo-bulb-sonata-reference/remaining-installation.json']
sources += [work / 'safari-2024/lighting-state.json', work / 'lc70-2025/lighting-state.json']
targets = {}
for source in sources:
    data = json.loads(source.read_text(encoding='utf-8-sig'))
    records = data.values() if isinstance(data, dict) else data
    for record in records:
        if not isinstance(record, dict):
            continue
        for change in record.get('changes', []):
            if isinstance(change, dict) and all(key in change for key in ['asset', 'material', 'nits']) and '/common/' not in change['asset'].lower():
                targets.setdefault(change['asset'].lower(), []).append((change['material'], change['nits'], str(source)))
for source in (work / 'new-hub-cars').glob('*.lighting.json'):
    data = json.loads(source.read_text(encoding='utf-8-sig'))
    for asset, materials in data.get('targets', {}).items():
        for material, nits in materials.items():
            targets.setdefault(asset.lower(), []).append((material, nits, str(source)))

brands = {'mustang': 'Ford', 'taurus': 'Ford', 'sierra': 'GMC', 'silverado': 'Chevrolet', 'sequoia': 'Toyota', 'suburban': 'Chevrolet', 'expedition': 'Ford', 'explorer': 'Ford', 'malibu': 'Chevrolet', 'impala': 'Chevrolet', 'challenger': 'Dodge', 'charger': 'Dodge', 'durango': 'Dodge', 'cerato': 'Kia', 'pegas': 'Kia', 'k4': 'Kia', 'k5': 'Kia', 'lx570': 'Lexus', 'lx600': 'Lexus', 'es350': 'Lexus'}
for item in manifest['items']:
    metadata = item.get('metadata')
    if not metadata:
        continue
    filename = item['filename']
    parts = pathlib.PureWindowsPath(item.get('originalFile', item['file'])).parts
    if ('Extras' in parts and metadata['type'] != 'car') or re.search(r'wheel|rim|engine.pack|license.plate|passenger|universal.dummy|weapons|معزز', filename, re.I):
        metadata['type'] = 'addon'
        metadata['manufacturer'] = ''
        metadata['model'] = ''
        metadata['years'] = ''
    elif 'Maps' in parts:
        metadata['type'] = 'map'
        metadata['manufacturer'] = ''
        metadata['model'] = ''
        metadata['years'] = ''
    elif not metadata.get('manufacturer'):
        for model, brand in brands.items():
            if re.search(r'(?<![a-z0-9])' + re.escape(model) + r'(?![a-z0-9])', metadata['name'], re.I):
                metadata['manufacturer'] = brand
                break
    verified = set()
    if item['status'] == 'ready' and metadata['type'] == 'car':
        try:
            with zipfile.ZipFile(item['file']) as archive:
                names = {name.lower(): name for name in archive.namelist()}
                for asset in names.keys() & targets.keys():
                    raw = archive.read(names[asset]).decode('utf-8-sig')
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = json5.loads(raw)
                    for material, nits, evidence in targets[asset]:
                        record = data.get(material, {})
                        stages = record.get('Stages', [])
                        if any(isinstance(stage, dict) and stage.get('emissiveIntensityNits') == nits for stage in stages):
                            verified.add((asset, material, evidence))
        except Exception as error:
            item['lightingReviewError'] = str(error)[:200]
    metadata['lightingUpdated'] = bool(verified)
    item['lightingEvidence'] = [{'asset': asset, 'material': material, 'record': evidence} for asset, material, evidence in sorted(verified)]
    item['normalizedName'] = re.sub(r'[^\w]+', ' ', metadata['name'].casefold()).strip()
    item['nameAndSizeMatches'] = [other['file'] for other in manifest['items'] if other is not item and other.get('size') == item['size'] and re.sub(r'[^\w]+', ' ', other.get('metadata', {}).get('name', '').casefold()).strip() == item['normalizedName']]

pending = manifest_path.with_suffix('.reviewing')
pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
pending.replace(manifest_path)
summary = {'archives': len(manifest['items']), 'lightingVerified': sum(bool(item.get('metadata', {}).get('lightingUpdated')) for item in manifest['items']), 'categories': {kind: sum(item.get('metadata', {}).get('type') == kind for item in manifest['items']) for kind in ['car', 'map', 'addon']}, 'nameAndSizeCandidates': sum(bool(item.get('nameAndSizeMatches')) for item in manifest['items'])}
(root / 'data/collection/metadata-review.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps(summary))
