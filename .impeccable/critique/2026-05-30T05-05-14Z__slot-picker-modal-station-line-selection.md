---
target: slot picker modal station_line selection
total_score: 26
p0_count: 2
p1_count: 2
timestamp: 2026-05-30T05-05-14Z
slug: slot-picker-modal-station-line-selection
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Current slot clearly blue; taken state amber but no mobile label |
| 2 | Match System / Real World | 2 | "Assign slot" missing location/book context until JS updates title |
| 3 | User Control and Freedom | 3 | Cancel present; Clear slot visible when relevant |
| 4 | Consistency and Standards | 2 | .modal used on centered overlay but has bottom-sheet border-radius |
| 5 | Error Prevention | 2 | Taken slots give no feedback on mobile tap — silent fail |
| 6 | Recognition Rather Than Recall | 2 | No book identity — cashier must remember which book they tapped |
| 7 | Flexibility and Efficiency | 3 | Grid + free-form fallback covers all station configs |
| 8 | Aesthetic and Minimalist Design | 3 | Clean grid, no clutter |
| 9 | Error Recovery | 3 | Occupancy double-check in JS prevents double-assignment |
| 10 | Help and Documentation | 3 | n/a |
| **Total** | | **26/40** | **Below average** |

## Priority Issues Fixed

- **[P0]** Border-radius mismatch: `.modal-overlay-center .modal { border-radius: var(--radius) !important }` added
- **[P0]** Modal handle removed for centered modals: `.modal-overlay-center .modal-handle { display: none }`
- **[P1]** Taken slots: added `.slot-btn-taken-lbl` with pack number shown inline (visible on mobile)
- **[P1]** Book identity: `.slot-picker-book` div populated with game name + pack number
- **[P2]** Clear slot: removed red text, now neutral secondary styling via `.slot-picker-clear-btn`
- Slot buttons upgraded: 48×48px, 16px/800, 10px gap, flex-column for label support
