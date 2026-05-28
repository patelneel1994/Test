# Lottery System — Behavioral Reference

Design decisions, non-obvious rules, and edge-case handling for the lottery inventory system.
For schema and table structure see [README.md](README.md).

---

## Admin Permission System

### How it works
Admin is a **session-level unlock** — once authenticated it stays active for a fixed window, then automatically expires.

- **Password:** ``
- **Session duration:** 2 minutes from the last admin action (`ADMIN_SESSION_MS` constant in `lottery.js`)
- **Timer resets** every time an admin-gated action is used, so active work stays unlocked
- **Expires silently** — the next admin action after timeout simply shows the password prompt again

### The `requireAdmin(callback)` pattern
All admin-gated features call `requireAdmin(fn)`:
- If already unlocked: calls `fn()` immediately and resets the timer
- If locked: shows the Admin Auth modal; calls `fn()` on successful password entry

**Never** gate a feature by checking `isAdmin()` at render time for button visibility alone — the button may render before unlock, or may not re-render after unlock. Route the action handler through `requireAdmin` instead.

### Admin-gated actions
| Action | Why gated |
|--------|-----------|
| ✎ Edit ticket position | Can corrupt audit baselines if wrong |
| ✕ Remove pack | Irreversible without a restore |
| ↩ Restore removed pack | Brings back something deliberately removed |
| ↩ Restore soldout pack | Corrects accidental soldouts |
| Edit game (name, price, tickets per pack) | Price changes affect all revenue calculations retroactively |
| Reactivate game | Brings back a game that was deliberately deactivated |
| ⚠ Reset All | Destructive; also requires typing the password directly inside the Reset modal |

### Actions NOT gated (normal staff workflow)
Activate, move, change shift, close day, receive packs, mark sold out (caution shown instead — see below).

---

## Sold Out: Two Paths, One Modal

The "Mark Sold Out" modal (`soldout-modal`) is shared by both contexts. `openSoldOutModal(id, _, e)` is the single entry point from everywhere. The path taken on confirm is determined automatically by `_invContext`.

### Stock view path (`_pendingSoldOutStage = false`)
- Triggered by the **Sold Out** button on an activated pack in the stock list
- On confirm: immediately PATCHes `lottery_packs.status = 'soldout'` and writes a `soldout` event to `lottery_pack_events`
- **Irreversible** without admin using the Restore Soldout flow

### Audit path (`_pendingSoldOutStage = true`)
- Triggered by the **Sold Out** button inside the inventory audit modal (during shift/day close)
- Detected automatically: `_invContext.startsWith('close')` is true
- On confirm: stages the pack in `_invSoldOut` (a local JS object) — **no database write yet**
- The pack card shows a "Sold Out" badge and an **Undo** button
- Undo removes it from `_invSoldOut` and restores the card to normal
- The actual DB write happens only when the user hits **Confirm** on the entire audit (`_invCommitClose`)
- This staging window is intentional — it lets staff catch accidental soldouts before the shift is locked

### Caution displayed in both paths
- The modal always shows the full formatted book identifier (`GAME_NUMBER-PACK_NUMBER`) in monospace
- If `_packNoSalesYet(info)` is true (pack is still at its initial ticket position, meaning no tickets appear to have been sold), an amber warning appears: **"Check Extra storage before marking sold out"**
- ASC packs: no sales if `start_ticket === 0`
- DESC packs: no sales if `start_ticket >= tickets_per_pack - 1`

---

## Restore Soldout vs Restore Removed

These are two different flows with different ticket-position behavior.

| | Restore Soldout | Restore Removed |
|---|---|---|
| Trigger | Admin; "Restore to" buttons on soldout pack row | Admin; station buttons on removed pack row |
| `start_ticket` | **Preserved** — pack continues from where it was | Reset to **0** — pack treated as full |
| `last_shift_ticket` | Set to the confirmed resume ticket | Reset to **0** |
| Reason | Accidental soldout; real position is already recorded | Removed for logistics; re-entering as fresh |

The restore modal pre-fills the ticket input with `last_shift_ticket` (the position at the last legit shift close), not `start_ticket` (which may have been overwritten to the theoretical final ticket by the soldout action). When they differ, the modal shows both values and an amber note.

---

## Shift Auto-Creation

Shifts are **never created manually** in normal operation. They are auto-created at two points:

1. **Day open** — `_invCommitOpenDay()` creates the first shift immediately after the day record is inserted
2. **Shift close (inventory path)** — `_invCommitClose('shift')` closes the current shift, then immediately opens the next one

The `doOpenShift()` function exists but is no longer wired to any button (see comment at line ~1024).

**Page reload does not create a shift.** `loadCurrentDayShift()` only reads the open day and open shift — it never creates them.

### Why multiple shifts can accumulate
Each "Change Shift" action (whether via full audit or skip) creates one new shift. A day with N shift changes has N+1 shifts total (the first is auto-created on day open, each close creates the next). If a day shows unexpectedly many shifts, check whether staff used the skip path multiple times without realizing each skip is a full shift change.

---

## Day Total Calculation (Race Condition Fix)

When closing a shift or day, the total is calculated **locally** rather than re-summing from the database:

1. Calculate `totalSold` and `totalRev` from the current audit data
2. Query only the **other** already-closed shifts for this day (`id=neq.${shiftId}&status=eq.closed`)
3. Add the local totals to the query result

This avoids a race where the PATCH to close the current shift hasn't propagated before the SELECT for the day total fires, which would cause the current shift to be excluded and the day total to be understated.

---

## Pack Information Cache (`_packInfoCache`)

`_packInfoCache[packId]` is a flat object populated whenever a pack row is rendered (stock view, audit list, location view). Shape:

```js
{
  ticketsPerPack, gameName, gameNumber, packNumber,
  startTicket, endTicket, lastShiftTicket,
  loadingDirection,   // 'asc' or 'desc'
  location, price
}
```

All modal operations (soldout, remove, edit, restore, move) read from this cache for display values and calculations. The cache is **always fresh enough** because it's updated every time `loadLotteryStock()` re-renders the pack list, which happens after every state-changing action.

---

## Ticket Position Conventions

| Direction | Start | End | Formula for sold |
|-----------|-------|-----|-----------------|
| ASC | 0 | `tickets_per_pack - 1` | `close - open` |
| DESC | `tickets_per_pack - 1` | 0 | `open - close` |

`last_shift_ticket` is the **audit baseline** — what the ticket was at the START of the current shift. It is updated only at shift close (never mid-shift). `start_ticket` is the **current position** — updated more frequently (e.g. when a pack is marked soldout mid-shift via the stock view).

When restoring a soldout pack: prefer `last_shift_ticket` as the resume point because `start_ticket` may have been overwritten to the pack's theoretical final ticket by the soldout action.

---

## Station Line Numbers

### What they are
Each station has numbered physical display slots ("lines"). `station_line` on a pack records which slot it sits in at its current location. It is 1-based and optional — null means unassigned.

### Assignment rules
- One book per slot (enforced in UI via occupancy check from `_packInfoCache`).
- Slot picker shows all slots 1..N as buttons; occupied slots are amber and unclickable.
- If no `slot_count` is configured for the station, a free-form number input is shown instead.

### When `station_line` is cleared
| Trigger | Behavior |
|---|---|
| Book moved to a different location | Cleared silently — staff assigns a new slot at the destination |
| Admin clears station `slot_count` | Confirmation modal shows all affected books; on confirm all `station_line` values are set to null and each is logged as `line_cleared` |
| Individual unassign via "Clear slot" | Cleared immediately, no log |

### Slot count guard (decrease)
Admin cannot reduce `slot_count` below the highest currently-assigned `station_line` at that station. The input resets and an error is shown naming the blocking line number.

### Clearing slot structure
If any books have line numbers when admin blanks out `slot_count`, a confirmation modal lists them all. On confirm: bulk PATCH clears all `station_line` values, each is individually logged as `line_cleared` with station and line number in the notes, then `slot_count` is removed.

### Audit behavior
- Audit list sorts within each station by `station_line` ascending (nulls last) — matches physical rack order.
- Unscanned books with a line number get the `audit-book-lined-pending` class (amber highlight) so staff know exactly which slot to check.
- Once scanned, the class is removed and normal matched/flagged state applies.

---

## Scan Feedback (Audio)

`AudioContext` is suspended by browsers until a user gesture occurs. The system:

1. Attaches a one-time unlock handler on `click / touchstart / keydown / pointerdown` to resume the context on first interaction
2. Also calls `_ac.resume()` inside every `_beep()` call as a fallback

### Sound map
| Event | Sound | Pattern |
|-------|-------|---------|
| Ticket matched / pack received | `beepSuccess` | Two rising tones (880 → 1320 Hz) |
| Book not in list / game unknown | `beepNotFound` | Low descending sawtooth buzz |
| Audit direction violation | `beepViolation` | Three descending square-wave tones |
| Duplicate scan | `beepDuplicate` | Two identical medium blips |

---

## Audit Scan Logging

Every barcode matched during an inventory audit (open-day, close-shift, close-day) fires a fire-and-forget `audit_scan` event to `lottery_pack_events`. It is non-blocking — the audit flow continues immediately regardless of whether the insert succeeds.

Each event records:
- `ticket_before` — the shift baseline (`last_shift_ticket` or `start_ticket`)
- `ticket_after` — the scanned ticket position
- `location_to` — the station where the book lives
- `created_at` — explicit client-side ISO timestamp at the moment of scan
- `notes` — context string: audit type, game name, book number, and scanned ticket number

These events appear in the dashboard **Recent Activity** feed as **Audit scan** entries (teal color) and provide a full traceable record of every scan with time and ticket detail.

---

## Audit Scan States

During inventory audit, a scanned barcode can resolve to:

| State | Sound | Visual |
|-------|-------|--------|
| Pack matched, position OK | `beepSuccess` | Card turns green, "Match" badge |
| Pack matched, direction violation | `beepViolation` | Card turns red, "Flag" badge, inline warning |
| Pack not in active list | `beepNotFound` | Input flashes red, placeholder shows error |
| Barcode unparseable | `beepNotFound` | Input flashes red |
