---
target: Move books modal
total_score: 27
p0_count: 1
p1_count: 2
timestamp: 2026-06-01T18-29-28Z
slug: move-books-modal
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Count badge and scan feedback are solid; no status for "destination selected, pending commit" |
| 2 | Match System / Real World | 3 | Physical-world language throughout; queue shows source locations |
| 3 | User Control and Freedom | 2 | Queue items are removable; but tapping a destination has no escape — the commit is instant |
| 4 | Consistency and Standards | 3 | Button styles and color coding match the rest of the app |
| 5 | Error Prevention | 1 | Destination buttons are immediate commit triggers — no confirmation step for any book status |
| 6 | Recognition Rather Than Recall | 3 | Destinations named, not just colored; queue shows game names, pack numbers, source locations |
| 7 | Flexibility and Efficiency | 3 | Barcode scan + paste; queue allows pre-commit removal |
| 8 | Aesthetic and Minimalist Design | 3 | Clean layout; station green tint is semantic, not decorative |
| 9 | Error Recovery | 2 | No undo after commit; recovery requires full re-scan and re-move |
| 10 | Help and Documentation | 3 | Admin note surfaces contextually; mode-mixing error message is clear |
| **Total** | | **27/40** | **Functional but error-prone at the commit boundary** |

## Anti-Patterns Verdict

**Does this look AI-generated?** No. The modal is appropriately restrained — warm neutrals, no gradient text, no hero metrics, no glassmorphism. The station buttons' green tint is a meaningful semantic signal. The queue-then-commit pattern is a real UX choice, not a template fill.

**Deterministic scan:** 2 warnings, both pre-existing: overused font (Space Grotesk), flat type hierarchy. Neither is specific to Move Books and neither was introduced by this feature. Exit code 2.

## Overall Impression

The queue build-up is well-designed: scan, see the list grow, remove mistakes, then commit. The flaw is in the final step — the destination buttons look and behave like filter pills, but they're actually the database-write trigger. Tap the wrong station and all your queued books land there, silently. The word "confirm" even appears in the existing admin note copy as a promise the UI doesn't yet keep.

The single biggest opportunity: a two-step destination selection that adds one deliberate tap and eliminates accidental batch commits entirely.

## What's Working

**Queue management is clean.** The ability to remove individual books from the queue before committing is exactly right. The game emoji + name + source location gives enough context to catch scan errors before they become move errors.

**Count badge placement is smart.** Showing "3 books" in the modal title keeps the tally visible while the user is still scanning. It doesn't need its own section.

**Mode consistency enforcement is solid.** Blocking mixed received/active batches and showing a clear error is the right guard — enforced before the user gets to the destination step.

## Priority Issues

### [P0] Destination tap commits immediately — no confirmation

**What:** `confirmMoveBooks(loc, e)` either calls `requireAdmin(() => _doMoveBooks(loc))` or calls `_doMoveBooks(loc)` directly. Tapping a destination button IS the commit. The modal closes on success with no intermediate step showing what was about to happen.

**Why it matters:** A cashier scanning 5 books with a line of customers will tap the wrong station at least occasionally — the destination grid has buttons 130px wide in a 2-col auto-fill layout; adjacent stations are one column apart. On a phone that's a single thumb-width. When it happens, the only recovery is re-opening the modal, re-scanning all 5 books, and moving them to the correct location. For active books, that means calling the admin back.

**Fix:** After tapping a destination, replace the destination grid with a confirmation panel instead of committing:

```
┌──────────────────────────────────────────────┐
│  Moving 5 books → Station 1                  │
│  [← Change destination]  [Confirm move →]    │
└──────────────────────────────────────────────┘
```

`confirmMoveBooks()` becomes `_selectMoveDest(loc)` — renders the panel, stores the selected destination. The Confirm button calls the existing `_doMoveBooks(loc)` (and `requireAdmin()` for active books). The Back button calls `_updateMoveDestButtons()` to restore the grid. No modal-within-modal. No new screens.

**Suggested command:** `/impeccable harden`

---

### [P1] No undo path after commit

**What:** Once `_doMoveBooks` fires, all moves are persisted via `Promise.all`. The modal closes silently. There is no success message, no toast, and no undo window.

**Why it matters:** A wrong destination is only discovered after the cashier has moved on. At that point the manager has to manually re-trace what happened and re-scan everything. The audit log shows individual move events with no indicator that they were part of a batch, so even identifying what went wrong is non-trivial.

**Fix:** After `_doMoveBooks` succeeds, instead of closing silently, show a brief success toast with a 5-second undo window: "Moved 5 books to Station 1 — [Undo]". The undo handler calls `_commitMovePack` for each book in reverse (restoring their original locations from the queue's recorded `location` field). No new screen needed; a toast component already exists in the app.

**Suggested command:** `/impeccable harden`

---

### [P1] "Moving all" vs "moving one" is ambiguous at the commit moment

**What:** The count badge shows "3 books" in the title, but when the user hovers over a destination button, there's no reinforcement that tapping it will move ALL queued books — not just the last one scanned. New users may assume each destination tap is per-book.

**Why it matters:** An operator who thinks they're routing books one by one will be surprised when all 3 move to a single destination. This is especially confusing if they scanned books from multiple source locations intending different destinations.

**Fix:** The confirmation panel (P0 fix) solves this by explicitly stating "Moving 3 books →" before commit. Additionally, the `move-dest-label` text "Move to location" could read "Move all N books to:" — a one-word change that surfaces the "all" implication.

**Suggested command:** `/impeccable clarify`

## Persona Red Flags

**Rosa (Cashier, scan station):** Scanning a restock of 4 books with a queue behind her. She taps "Station 1" on the grid but her thumb lands on "Station 2" — one column over, ~130px away. The modal closes. She doesn't check. Twenty minutes later the tracking shows 4 books at the wrong station. Finding this in the audit trail looks like an individual series of moves, not a batch error. The P0 confirmation step would have caught this: she would have seen "Moving 4 books → Station 2" and noticed the wrong name.

**Marcus (Manager, oversight):** He wants to verify a batch move happened correctly. Opening the shift audit, he sees 4 individual move events for the same timestamp. He can tell they were simultaneous, but he can't tell if this was one intentional batch or four separate scans. There's also no way to see what the books were moved FROM in a consolidated way. A batch-move audit entry (or a linked event group) would make this review significantly faster.

## Minor Observations

- `.move-queue-sub { font-size: 11px }` is below the 12px mobile readability floor established in the responsive layer. Should be 12px to match `.att-loc`, `.act-sub`.
- The `move-dest-label` text "Move to location" is a section label, not an instruction. "Where are these going?" or "Select destination" is more direct and sets up the two-step interaction better.
- The existing admin note reads: "you'll be prompted on confirm" — the word "confirm" implies a confirmation step that doesn't exist yet. This copy is accidentally correct for the post-fix flow. Keep it as-is once the P0 fix lands.
- `.move-books-list { max-height: 220px }` shows 3-4 rows before scrolling. For a batch of 6-10 books (common in a restocking run), this means the user can't see the full list at a glance when making the destination decision. Consider `280px` or `40dvh`.
- Destination buttons use `onmousedown` + `ontouchstart` instead of `onclick`. This prevents the default 300ms touch delay but also means tapping and dragging (common in scroll recovery) can accidentally fire. Worth testing on touch.

## Questions to Consider

- "What if the destination buttons showed the current book count at that station?" — knowing Station 1 has 6 books before adding 4 more gives context that the current grid doesn't.
- "Is a wrong batch move distinguishable from correct individual moves in the audit log?" — if not, error recovery for managers is much harder than it needs to be.
- "What if scanning a book showed a preview of which destinations are valid before the user reaches the grid?" — surface the active-only-to-station constraint in the scan feedback, not just on error.
