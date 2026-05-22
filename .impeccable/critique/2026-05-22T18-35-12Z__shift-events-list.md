---
target: shift-events-list
total_score: 18
p0_count: 1
p1_count: 3
timestamp: 2026-05-22T18-35-12Z
slug: shift-events-list
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Time-only timestamps; no revenue impact per event |
| 2 | Match System / Real World | 2 | Detail strings mix prose + symbols inconsistently; no price context |
| 3 | User Control and Freedom | 3 | Informational only |
| 4 | Consistency and Standards | 1 | No badge style for `restored`; generic monospace not JetBrains Mono |
| 5 | Error Prevention | 2 | soldout detail gives no financial context |
| 6 | Recognition Rather Than Recall | 1 | sold out at #99 is meaningless without knowing book size or price |
| 7 | Flexibility and Efficiency | 2 | No filtering by event type |
| 8 | Aesthetic and Minimalist Design | 2 | 9px badge; unformatted sentence walls |
| 9 | Error Recovery | 2 | No empty-state copy explaining what events are |
| 10 | Help and Documentation | 1 | No legend, no section label |
| **Total** | | **18/40** | **Needs work** |

## Anti-Patterns Verdict
Not AI slop visually. Reads as data-dump-never-designed. Detector: flat-type-hierarchy confirmed (11/12/12.5/13px cluster); overused-font = false positive (project standard).

## Priority Issues
- [P0] Missing ev-badge-restored style — functional bug
- [P1] Detail strings carry critical data with no visual emphasis — soldout needs price × tickets
- [P1] 9px badge text illegible on mobile
- [P1] No section label separating events from entries
- [P2] .shift-history-entry-detail uses generic monospace not JetBrains Mono

## Persona Red Flags
- Manager: can't determine revenue impact from soldout event without cross-referencing catalog
- Cashier: 9px badge on phone at counter is unreadable
