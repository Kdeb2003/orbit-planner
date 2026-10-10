# UTN timetable PDF: structure analysis (Phase 4A.1)

Source analysed: *UTN WiSe 2026/27, AIR all courses*, "preliminary as of 28 September 2026 and subject to change", plus the *Course List winter semester 2026/27 AIR & HAI* PDF. The PDFs are personal working material and are **not** in this repository (the folder `orbit-import-inputs/` and the generated `import-output/` are git-ignored). Findings below were produced with PDF.js and, independently, PyMuPDF, and checked against rendered pages.

## Timetable PDF

| Fact | Finding |
|---|---|
| Pages | 9. Pages 1-8 are timetable pages stored **rotated 90°** (595 x 842 pt portrait, displayed landscape). Page 9 is a portrait legend. |
| Text layer | Present and selectable on all 9 pages (353-654 text items on timetable pages). **No OCR is needed.** |
| Weeks | 25 week tables (Semester Week 01-25, 5 Oct 2026 - 20 Mar 2027), 3-4 tables per page. |
| Table header | Dark title bar "Winter Semester 2026/2027 - Semester Week NN - AIR1 + AIR3", then a light band with `Monday`..`Saturday` and their dates (`dd.mm.yyyy`). There is **no Sunday** column. |
| Rows | Five principal slots: `Slot 1` 09:00-10:30, `Slot 2` 10:45-12:15, `Slot 3` 13:15-14:45, `Slot 4` 15:00-16:30, `Slot 5` 16:45-18:15. Breaks are 15 minutes, except a 60-minute gap between slot 2 and 3. Every table prints the same five labels and times. |
| Page breaks | A table can break across pages (week 4: slots 1-3 on page 1, slots 4-5 on page 2; week 25: slots 1-3 on page 7, 4-5 on page 8) and a table header can be separated from all of its rows (week 8: header at the bottom of page 2, rows on page 3). Continuation rows carry **no** title or date header. |
| Text direction | The rotated pages store text runs vertically (`transform = [0, 3, -3, 0, x, y]`, font size 3 pt). They must be mapped through the page viewport to get upright coordinates. |
| Text widths | Item widths are `0` unless PDF.js can load its standard-font data. The extractor does not depend on them (verified: identical output without font data). |

### Drawn geometry

The grid is **vector drawing**, which is what makes a geometric parser possible:

* Grid lines are thin filled rectangles (0.4 pt, `#d9dde3`), not strokes.
* The title bar is a dark filled rectangle (`#203864`), the header band a light one (`#d9e2f3`).
* **Cells with a course are filled rectangles**, one colour per course; the same colour appears in the legend. Empty cells have no fill.
* One grid cell is **36.8 pt wide x 19.4 pt high** (upright). Text inside a cell is clipped to it.

### Three table widths

The number of parallel sub-columns per weekday varies by week, so column boundaries cannot be hard-coded:

| Layout | Sub-columns per day | Day column width | Used by |
|---|---|---|---|
| narrow | 1 | 36.8 pt | weeks 1, 2, 14, 22 and 25 |
| medium | 2 | 73.6 pt | weeks 13, 15, 20, 23 and 24 |
| wide | 3 | 110.4 pt | the busy weeks 3-12, 16-19 and 21 |

Weekday columns are found from the header texts (centres of `Monday` and `Saturday`, equal spacing, verified), not from the layout class.

### How a card is encoded

A card is the text inside one grid cell, one text run per line, top to bottom:

```
W26M-AINBA            course code (one line; a joint card prints two code lines)
tutorial group B      session type and group (may be empty: German courses)
AIR1                  programme(s), e.g. "AIR3, HAI3" (absent on German cards)
NOP / ALC2            location: campus / room, or "online"; long lists wrap to a 2nd line
```

Observed values: types `main`, `tutorial`, `project group work`, `excursion`, `Student Conference`; groups `group A`, `group B`, `group B,C`; variants `main a`, `main b`, `main 1`, `main 2`; campuses `NOP` and `UL`; rooms `ALC1`, `ALC2`, `S31`, `S32`, `PC-Pool`, `Meeting 01`, `Eventspace`; and `online`.

### Concurrent courses

Parallel courses sit **side by side inside the weekday column** (up to 3), one sub-column each. Their order carries no meaning. The same course at the same time in two rooms (week 21, Student Conference in ALC1 and ALC2/Eventspace) is two cards.

### Multi-slot sessions: a painting artefact, not a cell

The PDF producer paints neighbouring cells of the **same colour as one merged rectangle**, both vertically (consecutive slots) and horizontally (neighbouring days in a narrow table, e.g. German A2 on Monday and Tuesday of week 25 is a single 73.6 pt rectangle). So a rectangle is **not** a card. Every merged rectangle is split on the grid, and each unit cell is read on its own; a session that continues over several slots simply prints the same card in each slot row. Splitting changes the cell count (672 rectangles, 684 cells) and was needed to get weekdays right.

Sessions are then formed by joining identical cards in consecutive slots **only across the 15-minute breaks**. The 60-minute lunch gap always separates sessions (a full-day block is two sessions: 09:00-12:15 and 13:15-18:15). Both rules are conventions of ORBIT, recorded on each session (`slots`, `merged-adjacent-cards`) so Phase 4A.2 can offer "one event per block" or "one per slot".

### Legend page

Three columns (course number, title, colour swatch), 32 rows. Observations: `W26M-AINBA` is titled "Artificial Intelligence Basic **group 1**" (a different notion of "group" than the A/B on the cards); `W26M-LiT` has a code but **no title**; `W26M-Deutsch A1.1` and `W26M-Deutsch A2` are **not listed at all**. Legend colours equal the card colours for every listed course, which is used as a consistency check.

## Problems in the source (reported, never corrected)

| Where | Problem | Treatment |
|---|---|---|
| Week 01 | No dates printed in the header; the table is empty and carries a red free-text notice ("preliminary as of 28 September 2026 ... may vary from week to week"). | Dates stay `null`; notice kept as stray text; anomaly `no-date` x6. |
| Week 23, Saturday | Header prints `05.03.2027`, identical to Friday, which makes Saturday a Friday. The sequence suggests 06.03.2027. | The Saturday date is **withheld** (`null`), anomalies `date-weekday-mismatch` + `duplicate-date`. No sessions depend on it today. **A human must confirm the intended date.** |
| Legend | Deutsch A1.1/A2 not listed; LiT without title. | Info issue `code-not-in-legend`; display name comes from the user's course selection. |
| Whole document | Preliminary; "the scheduling of individual sessions may vary from week to week". | Every session is traced to its week/page; re-extraction is idempotent (see design doc). |

## Course List PDF

Four pages, **no usable text layer** (only bullet glyphs; the content is images). It was read visually. It contains general rules (registration 2-7 October 2026, spot distribution), the module table for AIR and HAI (which confirms every selected course is an offered module: Advanced Modules, Interdisciplinary Module 2 / Elective, German A1.1 / A2 as "program unrelated") and the note that German A2 requires A1 proficiency with max. 20 participants. It carries **no dates, times, rooms or groups**, so it is used only to validate the existence and naming of courses, not for extraction.
