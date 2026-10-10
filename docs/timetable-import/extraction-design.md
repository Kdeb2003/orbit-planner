# UTN timetable extraction: method, data model and mapping (Phase 4A.1)

Status: **feasibility and parser only.** Nothing is uploaded, no calendar data is created or changed, no UI exists yet. Structure of the PDF: [pdf-structure-analysis.md](pdf-structure-analysis.md).

## 1. Is reliable client-side parsing feasible?

**Yes, for this document.** The text layer and the drawn grid are both present, so a deterministic geometric parser works with PDF.js alone (no OCR, no AI service, no server). Verified on the real PDF:

* all 25 week tables, 684 grid cells and every card's text were reproduced and then **independently cross-checked with PyMuPDF** (`scripts/utn-crosscheck.py`: the same 684 cells and identical text in every cell, 0 differences);
* 43 sessions (all active weeks, all courses) were compared by eye with rendered page crops (date header, slot label, card text), see [baseline.md](baseline.md);
* output is identical with and without PDF.js standard-font data, so a browser build does not need to ship fonts.

Limits, stated plainly:

* The parser depends on the **producer's drawing conventions** (filled rectangles for cells, thin filled rectangles for grid lines, dark title bar, light header band, `Slot N` labels, 36.8 x 19.4 pt cell). A re-export from a different tool, or a scanned/flattened PDF, can break it. It then fails loudly (structure issues such as `title-bar-not-found`, `missing-slot-rows`, `header-incomplete`) rather than guessing, and the golden test will fail.
* The PDF is **preliminary**; a new revision must be re-extracted and compared (see §5).
* The `Course List` PDF has no text layer and is not machine-readable; it was only read visually.

Unsupported input fails loudly: `extractFromLayouts` returns `supported: false`, `sessions: []` and a `problems` entry (`no-text-layer` for scans/image-only files, `no-week-tables` for another kind of PDF, `no-cards` for the right text with a different drawing). Malformed dates are withheld and flagged, never repaired.

## 2. Pipeline

```
PDF bytes --PDF.js--> PageLayout[]            src/timetable/utn/pdfLayout.ts   (text boxes + filled rectangles, upright coordinates)
PageLayout[] -> WeekTable[] (RawCard[])       tables.ts      geometry: title bar, header band, slot rows, grid cells
RawCard[] ----> TimetableSession[]            sessions.ts    merging of consecutive identical slot cards, identity, validation
              legend page ----> titles/colours legend.ts
TimetableSession[] -> SelectedSession[]       selection.ts   the user's course choices, group filter, clashes
SelectedSession -> EventDraft (not persisted) mapping.ts     shows the mapping onto CalendarEvent
```

`PageLayout` is plain JSON, so everything after the first step is pure and runs in Node, tests, or a browser. PDF.js is injected, not imported, and the operator codes it needs are guarded by `tests/utn/pdfjs-compat.test.ts`.

How a card is found (no regular expression over concatenated page text):

1. A dark rectangle containing "Semester Week NN" opens a table; the light band below it holds the weekday names (column centres, equal width) and dates.
2. `Slot N` labels plus the thin horizontal grid lines give the row bands. Rows keep belonging to the open table across page breaks.
3. Every filled non-grid rectangle is **split on the grid** (cell width x one slot row); each unit cell is a candidate card. Its centre gives the weekday, its row the slot, and the text boxes inside it the card lines.
4. Lines are parsed positionally (code lines, type line(s), programme line, location line(s)).
5. Text inside a table body that no cell claims is kept as `strayText` (the red notice on page 1).

## 3. Intermediate model (`src/timetable/utn/types.ts`)

`TimetableSession` (what a later import UI would show, one per proposed event):

| Field | Meaning |
|---|---|
| `sourceKey` | stable identity: `utn-wise2627\|<date>\|<start>-<end>\|<codes>\|<normalised type text>` |
| `semesterWeek`, `date` (`YYYY-MM-DD` or `null`), `weekday` | `date` is taken from the printed header; `null` when the header has none or an unusable one |
| `startTime`, `endTime`, `timeZone` (`Europe/Berlin`), `slots`, `spansMultipleSlots` | local wall-clock time, never week arithmetic |
| `courseCode`, `jointWith`, `courseTitle` (legend) | a joint card prints two codes |
| `kind` (`main/tutorial/project/excursion/language/other`), `typeText`, `groups`, `variant` | `typeText` is the printed text; `groups` e.g. `['B']`, `['B','C']`; `variant` e.g. `a`, `2` |
| `programs`, `location` (`room` / `online` / `unknown`, campus, room, raw) | |
| `source[]` | provenance per slot card: page, bounding box (upright points), week, **the exact text lines** |
| `confidence` (`high/medium/low`), `issues[]` (`info/warning/error` with stable codes) | `low` when any error exists |

Provenance is enough to find a session again on the rendered page: week + page + bounding box + original lines. The model is deliberately separate from `CalendarEvent`; nothing converts it implicitly.

## 4. Mapping onto the existing calendar model (not wired in)

Inspected: `src/types` (`CalendarEvent`, `UniversityMeta`), `src/utils/time.ts` (`zonedTimeToUtc`), `src/utils/conflicts.ts`, `src/cloud/ids.ts` (`deterministicUuid`), `src/migration/*`, `docs/cloud-sync.md`.

* **One-off dated events, not weekly series.** The timetable changes from week to week (different rooms, sessions that disappear around the holidays, block formats); a weekly `RecurringSeries` would invent sessions the PDF does not contain. 168 selected sessions are simply 168 one-off events.
* `toEventDraft` (`mapping.ts`) shows the mapping and is unit-tested: title = course name (+ " — Tutorial"), `category` `university` (`german` for German A2), `start`/`end` as UTC instants via `zonedTimeToUtc(date, time, 'Europe/Berlin')` (DST-correct: 09:00 on 20 Oct 2026 is 07:00Z, in December 08:00Z), `courseCode`, `sessionType` (`main`/`tutorial`; project, excursion and German map to `other` because the existing `SessionType` has no equivalent), `groupLabel` ("Group B"), `location` ("Online" for online), and a description naming the semester week and PDF page.
* **Identity and safe re-import.** `sourceKey` is content-based (course, date, time, type/group) and deliberately excludes page, coordinates **and room**. A later import should derive the row id with `deterministicUuid(`${userId}:event`, importKey)` (already used by `src/migration`), then use the existing `ON CONFLICT (id) DO NOTHING` insert + read-back verification. Importing the same PDF twice then creates nothing new; a re-issued PDF with a moved room produces the same id, so the import must **detect "same id, different content"** (the existing migration already reports such conflicts and never overwrites) and show it to the user instead of replacing events.
* **Conflicts.** `findSessionClashes` mirrors `conflicts.ts` (strict overlap, touching ends do not clash). Clashes between selected sessions are information for the user, never blocking; the calendar's own conflict dialog continues to apply once events exist.
* Not changed: deployed SQL migrations, cloud code, local stores. No cloud write path was added.

## 5. Re-importing a revised timetable

The PDF is preliminary, so Phase 4A.2 must treat a new PDF as a *diff*, not a replacement: extract again, compare `sourceKey`s with what was imported, and show added / removed / changed (room, time) sessions for confirmation. Events the user edited by hand must never be overwritten silently.

## 6. Selection rules (`selection.ts`)

Selected course codes (configuration, not extraction): `W26M-AINBA` (**Group B only**), `W26M-RBTAD`, `W26M-NLGAD`, `W26M-NLUAD`, `W26M-MMFAD`, `W26M-LLMAD`, `W26M-INSIN`, `W26M-Deutsch A2`. A session is *excluded* when a single different group is printed (AI Group A), *needs-review* when a group/variant is printed for a course without a group rule, when several groups are listed, when no group is printed for the AI course, when it is a joint card, when its date is unusable or a duplicate candidate exists, and is otherwise *confirmed*. Attendance is never assumed. (The course list is hard-coded for this phase; Phase 4A.2 should make it a user setting stored with the account, not in a public repository.)

## 7. Tooling

| Command | Purpose |
|---|---|
| `npm run timetable:extract -- "<pdf>"` | local CLI: writes review data to the git-ignored `import-output/` |
| `python scripts/utn-crosscheck.py "<pdf>"` | independent PyMuPDF cell/text comparison (needs `pip install pymupdf`) |
| `node scripts/make-utn-fixture.mjs "<pdf>"` | regenerates the public test fixture (layouts of weeks 1, 4, 5, 8, 12, 13, 14, 20, 21, 23, 25 + legend) |
| `npm test` | unit tests + fixture tests; `tests/utn/real-pdf.test.ts` additionally runs against the real PDF when it exists and is skipped otherwise |

## 8. Privacy

The raw PDFs and `import-output/` (it contains the user's selected schedule) are git-ignored (`/orbit-import-inputs/`, `/import-output/`, `/private/`); `*.pdf` is deliberately **not** blanket-ignored so intentional documentation can still be tracked. The committed fixture is minimal: table structure (titles, headers, grid, slot labels, dates) of eleven weeks plus **only the cards of the ~17 courses the tests need**; every other course's cards and legend rows are removed. It holds positioned text and rectangle geometry only (no PDF bytes, file names, metadata or personal data).
