# Timetable import (Phase 4A.1 — extraction feasibility)

| Document | Content |
|---|---|
| [pdf-structure-analysis.md](pdf-structure-analysis.md) | How the UTN semester timetable PDF is built, and what is wrong or ambiguous in it |
| [extraction-design.md](extraction-design.md) | Deterministic extraction method, intermediate data model, mapping onto calendar events, identity/re-import, selection rules, tooling, privacy |
| [baseline.md](baseline.md) | Frozen counts, source revision (SHA-256) and the independent verification record |
| [phase-4a2-plan.md](phase-4a2-plan.md) | Handoff plan for the user-facing import, schema limitations, open questions |

Scope of this phase: parse and validate only. Nothing is uploaded, no existing calendar data is touched, and there is no import UI. Code: `src/timetable/utn/`.
