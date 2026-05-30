---
target: renderPackRowByLoc station_line display
total_score: 25
p0_count: 2
p1_count: 2
timestamp: 2026-05-30T04-58-21Z
slug: renderpackrowbyloc-station-line-display
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Status pill shows, but line assignment state is unclear |
| 2 | Match System / Real World | 2 | "L3" doesn't match how cashiers say "Line 3" |
| 3 | User Control and Freedom | 3 | Slot picker accessible but hard to discover |
| 4 | Consistency and Standards | 2 | Audit panel uses LINE 3 badge; stock view uses L3 |
| 5 | Error Prevention | 3 | n/a |
| 6 | Recognition Rather Than Recall | 2 | Cashier must hunt through 6 inline badges to find line number |
| 7 | Flexibility and Efficiency | 2 | 20px touch target — will misfire on tablet/phone |
| 8 | Aesthetic and Minimalist Design | 2 | Info row is badge soup, all at same visual weight |
| 9 | Error Recovery | 3 | n/a |
| 10 | Help and Documentation | 3 | n/a |
| **Total** | | **25/40** | **Below average** |

## Anti-Patterns Verdict

Not AI slop overall — but the station_line badge reads generic. Detector found 2 warnings: overused font (Space Grotesk, global) and flat type hierarchy (10-13px cluster).

## Priority Issues

**[P0] Touch target failure** — 20px height, needs 44px. Cashier will mis-tap on tablet.

**[P0] Wrong hierarchy** — Line number is the primary physical locator but is last in a row of 6 equal-weight badges.

**[P1] Label ambiguity** — "L3" cryptic. Audit panel uses "LINE 3" — inconsistency on first shift.

**[P1] Unset slot invisible** — dashed border in hint color disappears; an unassigned book is a data problem that should demand attention.

## What Was Fixed

Rebuilt the slot badge as a prominent 42x42px left-anchored block: JetBrains Mono 18px/800, blue background, blue shadow. Unassigned state is a dashed outline "+" button that turns red on hover. The book info and progress bar moved into a flex-column body wrapper so layout is stable on mobile.
