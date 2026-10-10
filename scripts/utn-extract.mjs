// Local-only CLI: extracts the UTN timetable PDF and writes a REVIEW dataset to ./import-output/.
// Usage: node scripts/utn-extract.mjs "<path to timetable pdf>"
// Nothing is uploaded and no calendar data is touched. import-output/ is git-ignored (it holds personal selections).
import fs from 'node:fs'
import path from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractFromPdf, findSessionClashes, selectSessions, toEventDraft } from '../src/timetable/utn/index.ts'

const pdfPath = process.argv[2]
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('Usage: node scripts/utn-extract.mjs "<timetable.pdf>"  (file not found)')
  process.exit(1)
}
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise
const ex = await extractFromPdf(doc)
const { selected, excluded } = selectSessions(ex.sessions)
const clashes = findSessionClashes(selected.filter((s) => s.session.date))

const out = path.resolve('import-output')
fs.mkdirSync(out, { recursive: true })
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 1))
write('layouts.json', ex.layouts)
write('all-sessions.json', ex.sessions)
write('selected-sessions.json', selected)
write('excluded-sessions.json', excluded)
write('anomalies.json', ex.anomalies)
write('clashes.json', clashes.map((c) => ({ date: c.date, a: c.a.session.sourceKey, b: c.b.session.sourceKey })))
write('event-drafts.json', selected.filter((s) => s.session.date).map((s) => toEventDraft(s)))
console.log(`weeks=${ex.tables.length} sessions=${ex.sessions.length} selected=${selected.length} excluded=${excluded.length} clashes=${clashes.length} anomalies=${ex.anomalies.length}`)
console.log(`written to ${out}`)
