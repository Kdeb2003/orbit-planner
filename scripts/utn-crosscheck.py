"""Independent cross-check of the TypeScript extractor with a different PDF engine (PyMuPDF).

Usage:  node scripts/utn-extract.mjs "<pdf>"    (writes import-output/all-sessions.json)
        python scripts/utn-crosscheck.py "<pdf>"

Finds every painted grid cell and reads its text with MuPDF (own geometry, own text extraction), then compares
the cell set and the cell text with the cards the TypeScript pipeline produced. Needs `pip install pymupdf`.
Exit code 1 on any difference. The PDF stays local; nothing is uploaded.
"""
import json, sys, pymupdf
f = sys.argv[1]
d = pymupdf.open(f)
def lum(c): return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
mu = {}
for pi in range(8):
    p = d[pi]; m = p.rotation_matrix
    for x in p.get_drawings():
        fl = x.get('fill')
        if not fl: continue
        r = x['rect']
        if min(r.width, r.height) < 5: continue          # grid lines / thin
        if lum(fl) < 0.4 or lum(fl) > 0.97: continue     # dark title bars / white
        if abs(fl[0]-0.85)<0.02 and abs(fl[1]-0.89)<0.02 and abs(fl[2]-0.95)<0.02: continue  # header band
        v = (pymupdf.Rect(r) * m).normalize()
        nx = max(1, round(v.width/36.8)); ny = max(1, round(v.height/19.44))
        cw = v.width/nx; ch = v.height/ny
        for i in range(nx):
            for j in range(ny):
                c = pymupdf.Rect(v.x0+i*cw, v.y0+j*ch, v.x0+(i+1)*cw, v.y0+(j+1)*ch)
                clip = pymupdf.Rect(c.x0+0.3, c.y0+0.3, c.x1-0.3, c.y1-0.3)
                lines = [l.strip() for l in p.get_text('text', clip=(clip * p.derotation_matrix).normalize()).splitlines() if l.strip()]
                mu[(pi+1, round(c.x0), round(c.y0))] = lines
ts = {}
for s in json.load(open('import-output/all-sessions.json')):
    for src in s['source']:
        b = src['bbox']; ts[(src['page'], round(b['x0']), round(b['y0']))] = [l for l in src['rawLines'] if l]
print('mupdf cells', len(mu), 'ts cards', len(ts))
def near(k, table):
    for dx in (0,-1,1):
        for dy in (0,-1,1):
            q=(k[0],k[1]+dx,k[2]+dy)
            if q in table: return q
    return None
only_mu=[k for k in mu if near(k,ts) is None]
only_ts=[k for k in ts if near(k,mu) is None]
diff=[(k,mu[k],ts[near(k,ts)]) for k in mu if near(k,ts) and [l.replace('  ',' ') for l in mu[k]]!=ts[near(k,ts)]]
print('cells only in mupdf', len(only_mu), 'only in ts', len(only_ts), 'text differences', len(diff))
for k in only_mu[:5]: print('ONLY_MU', k, mu[k])
for k in only_ts[:5]: print('ONLY_TS', k, ts[k])
for k,a,b in diff[:8]: print('DIFF', k, a, b)

sys.exit(1 if (only_mu or only_ts or diff) else 0)
