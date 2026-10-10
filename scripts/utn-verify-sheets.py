"""Builds visual verification sheets: for representative selected sessions, a crop of the week header
(weekday + date above the column) and of the slot row(s) (time label ... card) straight from the rendered PDF.

Usage:  node scripts/utn-extract.mjs "<pdf>"
        python scripts/utn-verify-sheets.py "<pdf>"        -> import-output/verify/sheet_N.png + verify/samples.json
Needs `pip install pymupdf pillow`. The PDF stays local.
"""
import json, os, sys, pymupdf
from PIL import Image, ImageDraw

pdf = sys.argv[1]
doc = pymupdf.open(pdf)
layouts = json.load(open('import-output/layouts.json'))
selected = json.load(open('import-output/selected-sessions.json'))
sessions = [x['session'] for x in selected]
DPI = 300
K = DPI / 72
cache = {}


def page_img(n):
    if n not in cache:
        pix = doc[n - 1].get_pixmap(dpi=DPI)
        cache[n] = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
    return cache[n]


def crop(n, box, zoom):
    im = page_img(n).crop(tuple(int(v * K) for v in box))
    return im.resize((max(1, int(im.width * zoom / K)), max(1, int(im.height * zoom / K))), Image.LANCZOS)


def title_of(week):
    for lay in layouts:
        for t in lay['texts']:
            if f'Semester Week {week:02d}' in t['str']:
                return lay['page'], t
    return None, None


# ---- representative selection -------------------------------------------------------------
def feats(s):
    pages = {r['page'] for r in s['source']}
    f = {('course', s['courseCode']), ('ck', s['courseCode'], s['kind'], tuple(s['groups'])), ('room', s['location']['raw']), ('wd', s['weekday']), ('week', s['semesterWeek'])}
    if s['spansMultipleSlots']: f.add(('multi',))
    if len(pages) > 1: f.add(('pagebreak',))
    if s['location']['kind'] == 'online': f.add(('online',))
    tp, _ = title_of(s['semesterWeek'])
    if tp not in pages: f.add(('headerOtherPage',))
    return f


forced = [('2026-10-20', 'W26M-INSIN'), ('2026-10-20', 'W26M-MMFAD'), ('2026-10-22', 'W26M-NLGAD'), ('2026-10-22', 'W26M-RBTAD'),
          ('2026-11-02', 'W26M-Deutsch A2'), ('2026-10-19', 'W26M-Deutsch A2'), ('2027-02-08', 'W26M-MMFAD'), ('2027-03-16', 'W26M-Deutsch A2')]
picked = []
for d, c in forced:
    for s in sessions:
        if s['date'] == d and s['courseCode'] == c and s not in picked:
            picked.append(s)
seen = set().union(*[feats(s) for s in picked])
weeks = sorted({s['semesterWeek'] for s in sessions})
for w in weeks:
    have = sum(1 for p in picked if p['semesterWeek'] == w)
    for _ in range(max(0, 2 - have)):
        best = max((s for s in sessions if s['semesterWeek'] == w and s not in picked), key=lambda s: (len(feats(s) - seen), -sum(1 for p in picked if p['courseCode'] == s['courseCode'] and p['kind'] == s['kind'])), default=None)
        if best:
            picked.append(best)
            seen |= feats(best)
# make sure every course, group-B kind, layout and special feature is covered
for s in sessions:
    if s['courseCode'] not in {p['courseCode'] for p in picked}:
        picked.append(s)
picked.sort(key=lambda s: (s['date'], s['startTime']))
os.makedirs('import-output/verify', exist_ok=True)
json.dump([{k: s[k] for k in ('sourceKey', 'semesterWeek', 'date', 'weekday', 'startTime', 'endTime', 'courseCode', 'typeText')} | {'room': s['location']['raw']} for s in picked],
          open('import-output/verify/samples.json', 'w'), indent=1)
print('samples', len(picked), 'weeks', len({s['semesterWeek'] for s in picked}), 'courses', len({s['courseCode'] for s in picked}))

# ---- sheets -------------------------------------------------------------------------------
tiles = []
for i, s in enumerate(picked, 1):
    first = s['source'][0]
    bx = first['bbox']
    tp, title = title_of(s['semesterWeek'])
    hdr = crop(tp, (max(0, bx['x0'] - 45), title['y'] - 8, bx['x1'] + 45, title['y'] + 27), 3)
    by_page = {}
    for r in s['source']:
        by_page.setdefault(r['page'], []).append(r['bbox'])
    strips = []
    for pg, boxes in by_page.items():
        y0 = min(b['y0'] for b in boxes) - 1
        y1 = max(b['y1'] for b in boxes) + 1
        x1 = max(b['x1'] for b in boxes) + 6
        strips.append((pg, crop(pg, (54, y0, x1, y1), 2.2)))
    cap = (f"#{i} wk{s['semesterWeek']} {s['date']} {s['weekday'][:3]} {s['startTime']}-{s['endTime']} {s['courseCode'].replace('W26M-', '')} | "
           f"{s['typeText'] or '-'} | {s['location']['raw']} | header p{tp}, rows p{','.join(str(p) for p, _ in strips)}")
    w = max([hdr.width, 900] + [im.width for _, im in strips])
    h = 16 + hdr.height + 4 + sum(im.height + 4 for _, im in strips)
    tile = Image.new('RGB', (w, h), 'white')
    ImageDraw.Draw(tile).text((4, 2), cap, fill='black')
    tile.paste(hdr, (0, 16))
    y = 16 + hdr.height + 4
    for _, im in strips:
        tile.paste(im, (0, y))
        y += im.height + 4
    tiles.append(tile)
PER = 6
for k in range(0, len(tiles), PER):
    grp = tiles[k:k + PER]
    out = Image.new('RGB', (max(t.width for t in grp), sum(t.height + 6 for t in grp)), '#cccccc')
    y = 0
    for t in grp:
        out.paste(t, (0, y))
        y += t.height + 6
    out.save(f'import-output/verify/sheet_{k // PER + 1}.png')
print('sheets', (len(tiles) + PER - 1) // PER)
