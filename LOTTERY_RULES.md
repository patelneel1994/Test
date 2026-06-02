# Lottery Module — Business Rules

This document is the authoritative reference for how the lottery module works.
Read this before making any changes to lottery logic.

---

## 1. Location Types

| Type | Examples | Books sold here? | Revenue-generating? |
|------|----------|-----------------|---------------------|
| **Station** | Station 1, Station 2 | Yes | Yes |
| **Office** | Office | No — staging only | No |
| **Extra** | Extra | No — staging only | No (audited for presence) |
| **Extra locs** | Configurable in Settings | No — staging only | No (audited for presence) |

- **Stations** are configured in Settings. They are the only locations that generate shift revenue.
- **Office** is fixed and always present. Books are received here before being loaded.
- **Extra** and **extra locs** are staging areas. Books stored there are tracked in the audit but their tickets sold do NOT count toward shift revenue.
- Moving a book **to a station** sets `status = activated`.
- Moving a book **to any non-station location** sets `status = received`.
- `_isStation(loc)` — checks if a location is a station.
- `_isFullAuditStaging(loc)` — true for `Extra` and all configured extra locs.

---

## 2. Book (Pack) Lifecycle

```
[Scanned at Receive tab]
       ↓
   received        ← stored at Office, Extra, or any staging location
       ↓  (Load to station)
   activated       ← at a station, contributing to shift revenue
       ↓
   soldout         ← final ticket reached; can be restored
   removed         ← pulled from floor; can be restored
```

### Status Rules

| Status | Where | Can sell? | Notes |
|--------|-------|-----------|-------|
| `received` | Office / Extra / staging | No | Default on scan-in. Also set when moved away from a station. |
| `activated` | Station | Yes | Set when loaded to a station. |
| `soldout` | Any (no location after marking) | No | `station_line` cleared on mark. Restorable by admin. |
| `removed` | (removed from system) | No | Restorable by admin with a ticket position. |

### Loading a Book to a Station
- Requires a day to be open (`_canMoveOrActivate()` returns true only when `_currentDay` is set, or DB tracking is disabled).
- Sets `status = 'activated'`, `location = <station>`, `start_ticket = ticket`, `last_shift_ticket = ticket`, `station_line = null`.
- Clears any previously assigned station line.

### Removing a Book (Remove / Return to Lottery)
- **Remove**: records the final ticket position; optionally logs a shift entry for partial tickets sold. Sets `status = removed`.
- **Return to Lottery**: same result as Remove but semantically means the book went back to the lottery warehouse.
- Both operations: if a shift is open and the book had activity this shift, a partial `lottery_shift_entries` record is written immediately so those tickets aren't lost.

### Restoring a Book
- **Restore sold-out**: admin-only. Resume ticket defaults to `last_shift_ticket` (the position at last real shift close), NOT `start_ticket` (which was overwritten by the soldout action to the theoretical final ticket).
- **Restore removed**: admin-only. Defaults to ticket #0 (full book); staff can enter a higher number if it was partially used.
- Both: moving to a station → `activated`; moving to staging → `received`.

---

## 3. Day & Shift Lifecycle

### Day States
```
(no day)  →  open  →  closed
```

### Shift States (within a day)
```
open  →  closed  →  open (new shift)  →  ...
```

### Open Day
1. Triggers inventory audit (`context = 'open-day'`).
2. All activated station books must be scanned.
3. All extra-location books must be verified (scan or bypass).
4. Discrepancies (scanned ticket ≠ last close baseline) are shown and must be explicitly acknowledged before opening.
5. On confirm:
   - Creates a `lottery_days` record (`status = 'open'`).
   - Updates each scanned book's `start_ticket` and `last_shift_ticket` to the scanned value.
   - Commits any staged sold-outs.
   - Updates extra book `last_shift_ticket` checkpoints.
   - Immediately opens the **first shift** automatically.

### Change Shift
1. Triggers inventory audit (`context = 'close-shift'`).
2. All activated station books must be scanned; direction violations block confirmation.
3. Extra books must all be verified.
4. On confirm:
   - Closes the current shift (`status = 'closed'`, writes `total_tickets_sold`, `total_revenue`).
   - Writes `lottery_shift_entries` for every book.
   - Updates every book's `start_ticket` / `last_shift_ticket` to the scanned value.
   - Immediately **opens a new shift** automatically.
5. User can skip the audit (closes shift with whatever data is already entered, or zero).

### Close Day
1. Triggers inventory audit (`context = 'close-day'`).
2. Same rules as Change Shift for scanning and extra books.
3. On confirm:
   - Closes the current shift (same as Change Shift).
   - Sums **all closed shifts for this day** (excluding current one, then adds current totals) to get day totals.
   - Sets `lottery_days.status = 'closed'`, writes `total_tickets_sold`, `total_revenue`, `closed_at`.
   - **No new shift is opened.**

### Constraints
- Only one day can be open at a time.
- Shift operations use `_shiftOpInProgress` semaphore to prevent concurrent close/open races.
- If a day is open with no open shift, one is auto-created on the next `loadCurrentDayShift()` call.
- `_currentDay` and `_currentShift` are in-memory state; always loaded from DB on page load via `loadCurrentDayShift()`.

---

## 4. Inventory Audit System

### Three Contexts

| Context | Triggered by | Purpose |
|---------|-------------|---------|
| `open-day` | Open Day button | Baseline all books for the new day |
| `close-shift` | Change Shift button | Record shift revenue and change shift |
| `close-day` | Close Day button | Record shift revenue and close the day |

### What Must Be Scanned
- **Station books** (`_invPacks`): every activated book at a station.
- **Extra books** (`_invExtraPacks`): every book at Extra or extra locs. Required in **all three contexts**.

### What Blocks the Confirm Button
1. Any station book not yet scanned (unless the context is in `_INV_OPTIONAL` — currently nothing is optional).
2. Any direction violation (scanned ticket is in the wrong direction vs baseline) in close contexts.
3. Any extra book not yet verified (scan + decision, bypass, or move-to-station).

### Ticket Direction
- `asc` (ascending): tickets run 0 → N. Current ticket must be **≥ baseline**.
- `desc` (descending): tickets run N → 0. Current ticket must be **≤ baseline**.
- Violations: shown with ⚠ flag, block confirm in close contexts. In open-day, violations are shown but allowed after acknowledgement.

### Baseline
- `last_shift_ticket` if set (the ticket position recorded at last shift close).
- Falls back to `start_ticket` if `last_shift_ticket` is null.

### Open-Day Discrepancy
- If a scanned ticket ≠ baseline, a discrepancy is shown.
- A summary modal appears before committing.
- User must tap "Open Day Anyway" to proceed. A `discrepancy` pack event is logged.

### Soldout Staging During Audit
- Marking a book sold-out during a close audit **stages** it locally (no DB write until shift confirm).
- `_invSoldOut[packId] = finalTicket` — staged; `_invData[packId] = finalTicket`.
- On audit confirm, staged sold-outs are committed along with shift entries.

### Recovery
- "Fill from log" button reads recent `audit_scan` pack events and pre-fills ticket numbers. Admin can adjust the time window.

---

## 5. Extra Books Audit Rules

Extra books are books at `Extra` or any configured extra loc.

### Fetch Logic
- Extra books have `status = 'received'` (moving to a non-station sets this).
- The audit fetches BOTH `status=activated` AND `status=received` for every context.
- Books at extra locs from the received fetch are separated into `_invExtraPacks`.

### Scan Outcome at Open-Day
| Scanned position | Expected position | Outcome |
|-----------------|------------------|---------|
| = expected | = expected | Auto-verified (clean ✓) |
| ≠ expected | ≠ expected | Shows prompt: "Was this book brought to a station?" |
| — | — | Awaits scan |

- "Yes — pick station": moves the book to a station (DB PATCH immediately), adds to station audit list.
- "No — keep at Extra": verifies with discrepancy noted. Updates `last_shift_ticket` as a checkpoint.

### Scan Outcome at Close-Shift / Close-Day
- Any scan → auto-verified (no miduse prompt). Discrepancy is noted but does not block.
- Updates `last_shift_ticket` as checkpoint on commit.

### Bypass
- Available for any unverified extra book.
- Requires typing a reason (free text). Empty reason is rejected.
- Logged as `extra_bypassed` pack event.
- Counts as verified for the purpose of unblocking confirm.

### Extra Books and Revenue
- Extra books do NOT contribute to shift revenue.
- They are NOT included in `lottery_shift_entries`.

---

## 6. Revenue Calculation

### Tickets Sold
```
asc:  sold = max(0, current_ticket - last_shift_ticket)
desc: sold = max(0, last_shift_ticket - current_ticket)
```
Implemented in `_soldTickets(current, last, dir)` in `lottery-stock.js`.

### Soldout Adjustment
When a book is marked sold-out, the final ticket is the very last ticket of the book:
- ASC: `finalTicket = tickets_per_pack - 1`
- DESC: `finalTicket = 0`

The sold count adds **+1** to include that final ticket:
```
sold = _soldTickets(finalTicket, lastShiftTicket, dir) + 1
```

### Shift Entry
Each `lottery_shift_entries` row stores:
- `pack_id`, `shift_id`
- `ticket_at_open` (= last shift's close ticket = baseline)
- `ticket_at_close` (= current scan)
- `tickets_sold`, `revenue`
- `station_line` (snapshot at close time)

### Mid-Shift Removed Books
If a book is removed mid-shift (Remove or Return to Lottery) and has a current shift open, a partial shift entry is written immediately with the revenue earned up to the removal point. These entries are summed along with the audit entries at shift close.

### Day Revenue
```
day.total_revenue = sum of all CLOSED shifts for that day
```
The close-day audit closes the current shift first, then fetches all OTHER closed shifts and adds the current shift's totals to avoid double-counting.

---

## 7. Station Lines (Slot System)

- A station can have a configured `slot_count` (set in Settings).
- Books at a station can be assigned a `station_line` (integer, 1-based).
- One book per line — enforced at assignment time via `_packInfoCache` occupancy check.
- `station_line` is included in `lottery_shift_entries` as a snapshot.
- Clearing a line (`clearPackSlot`) sets `station_line = null` in DB.
- Moving a book to a new station always clears `station_line = null` (the line belongs to the old station).

### Slot Count Not Configured
If `_getStationSlotCount(station)` returns `null`, the slot picker shows a free-form number input instead of a grid.

---

## 8. Admin Session

- Unlocked by typing the admin password in the admin modal.
- Auto-locks after **2 minutes** of inactivity (reset on any `requireAdmin` call).
- A countdown pill shows the remaining time.
- `isAdmin()` — currently returns `_adminUnlocked` (session-based, not persistent auth).

### Admin-Gated Actions
- Return to Lottery (opening the modal)
- Restore sold-out book
- Restore removed book
- Mark sold-out during open-day audit
- Remove a book from floor
- Reset data modal
- Any repair utilities (`lottery-repair.js`)

### Non-Admin Actions
- Receive new books
- Load a book to a station (activate)
- Move books between staging locations
- Mark sold-out during close-shift / close-day
- Run any audit

---

## 9. Barcode Format (TN Lottery)

Tennessee Lottery uses **ITF-14** barcodes.

| Barcode length | Game digits | Interpretation |
|---------------|-------------|----------------|
| 12 digits | 3-digit game | Legacy format |
| 13–14 digits | 4-digit game | Standard format |
| 15+ digits | Ambiguous | Try 3-digit, then 4-digit — resolve via DB |

### Structure (after cleaning non-digits)
```
[GAME_NUMBER (3 or 4 digits)] [PACK_NUMBER (6 digits)] [TICKET_POSITION (3 digits)] [optional check digit]
```

Ambiguous barcodes return both candidates; the caller resolves by matching against the active pack list or DB.

---

## 10. Key Invariants (Do Not Break)

1. **Revenue only comes from station books.** Extra/Office/staging books are never in `lottery_shift_entries`.
2. **Extra books must be verified in all three audit contexts**, not just open-day.
3. **Extra books: scan-only.** No manual ticket number input. Bypass requires a typed reason.
4. **Snapshot globals before awaits.** `_invCommitClose` and `_invCommitOpenDay` copy `_invPacks`, `_invData`, etc. into local variables before any `await`, because `closeInventoryModal()` can clear the globals mid-async.
5. **`_shiftOpInProgress` semaphore** prevents concurrent close operations. Any close path must set it to `true` and release in `finally`.
6. **`_invBusy` guard** prevents double-tap from opening the audit twice (which would create duplicate day records).
7. **Soldout restore uses `last_shift_ticket` as the resume point**, not `start_ticket` (which was overwritten to the theoretical final ticket by the soldout action).
8. **Moving a book to a non-station always sets `status = received` and clears `station_line`.**
9. **Day totals = sum of all closed shifts.** Do not recalculate from pack entries directly — always aggregate from `lottery_shifts`.
10. **`parseLotteryBarcode` is the single barcode parser.** Never parse barcodes inline elsewhere.
