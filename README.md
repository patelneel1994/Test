# Lottery Inventory System

A web app for managing lottery scratch ticket books — receiving, activating, auditing, and reporting across multiple stations.

---

## Database Schema

### `lottery_games`
The game catalog. One row per scratch ticket game type.

| Column | Type | Description |
|---|---|---|
| `game_number` | text (PK) | Game identifier (e.g. `1234`) |
| `game_name` | text | Display name |
| `price` | numeric | Ticket price (e.g. `5.00`) |
| `tickets_per_pack` | int | Tickets per book (e.g. `300`) |
| `active` | boolean | Whether the game is still being sold |

Add a game once, then receive many packs of it. The catalog drives barcode parsing and price calculations everywhere.

---

### `lottery_packs`
Every physical book of tickets, from arrival to retirement.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | |
| `game_number` | text → `lottery_games` | |
| `pack_number` | text | Book serial from barcode |
| `raw_barcode` | text | Original scan string |
| `status` | text | `received` → `activated` → `soldout` / `removed` |
| `location` | text | Where the book is (Office, Station 1, etc.) |
| `start_ticket` | int | Current ticket position (next ticket to sell) |
| `last_shift_ticket` | int | Position at start of current shift (audit baseline) |
| `end_ticket` | int | Last ticket index in the book (`tickets_per_pack - 1`) |
| `loading_direction` | text | `asc` (0→299) or `desc` (299→0) |
| `station_line` | int (nullable) | Physical slot number at the current station (1-based). Null = unassigned. Cleared automatically when the book moves to a different location. |

The core operational table. Every audit, move, and sale traces back here.

**Ticket position convention:** 0-indexed. A 300-ticket book runs 0–299. `start_ticket` is the *next ticket to sell* (exclusive). Sold count = `start_ticket - last_shift_ticket` for ASC, `last_shift_ticket - start_ticket` for DESC. Sold-out adds +1 because the final ticket was also sold.

---

### `lottery_days`
One row per business day. Container for all shifts that day.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | |
| `opened_at` | timestamptz | When the day was opened |
| `closed_at` | timestamptz | When the day was closed |
| `status` | text | `open` or `closed` |
| `total_tickets_sold` | int | Rolled-up from all shifts |
| `total_revenue` | numeric | Rolled-up from all shifts |
| `notes` | text | Manager notes at day close |

A day must be open before a shift can be opened. Closing a day aggregates all shift totals into this row.

---

### `lottery_shifts`
One row per cashier shift within a day.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | |
| `day_id` | uuid → `lottery_days` | |
| `shift_type` | text | `shift` (mid-day) or `day` (legacy mode) |
| `opened_at` | timestamptz | |
| `closed_at` | timestamptz | |
| `status` | text | `open` or `closed` |
| `total_tickets_sold` | int | Sum of all entries for this shift |
| `total_revenue` | numeric | Revenue for this shift |
| `notes` | text | Notes entered at shift close |

Closing a shift triggers the audit — all active books are scanned, their positions recorded, and totals written here.

---

### `lottery_shift_entries`
One row per book per shift close. The line-item audit record.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | |
| `shift_id` | uuid → `lottery_shifts` | |
| `pack_id` | uuid → `lottery_packs` | |
| `ticket_at_open` | int | Book position when shift opened (baseline) |
| `ticket_at_close` | int | Book position when shift closed (scanned) |
| `tickets_sold` | int | `close - open` (direction-aware) |
| `revenue` | numeric | `tickets_sold × price` |

Granular audit trail — exactly how many tickets each book sold in each shift.

---

### `lottery_pack_events`
Append-only event log for every action taken on a book. Never updated.

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | |
| `pack_id` | uuid → `lottery_packs` | |
| `shift_id` | uuid → `lottery_shifts` | Which shift it happened in |
| `day_id` | uuid → `lottery_days` | Which day it happened in |
| `action` | text | `received`, `activated`, `moved`, `soldout`, `removed`, `restored`, `adjusted`, `discrepancy`, `returned_to_lottery`, `line_cleared` |
| `location_from` | text | Previous location (for moves) |
| `location_to` | text | New location (for moves/activations) |
| `ticket_before` | int | Position before change |
| `ticket_after` | int | Position after change |
| `notes` | text | Reason or detail |
| `created_at` | timestamptz | |

Powers the dashboard Activity Feed and Needs Attention panels. Full lifecycle history of every book.

---

## Table Relationships

```
lottery_games
    └── lottery_packs          (many books per game)
            └── lottery_pack_events    (every action on a book)
            └── lottery_shift_entries  (audit record per shift close)

lottery_days
    └── lottery_shifts         (multiple shifts per day)
            └── lottery_shift_entries  (links shift ↔ pack audit)
            └── lottery_pack_events    (events that happened in this shift)
```

---

## Book Lifecycle

```
Scan barcode
    → lottery_packs (status: received, location: Office)
        → Move to station
            → lottery_packs (status: activated, location: Station N)
                → Shift close audit
                    → lottery_shift_entries (tickets sold this shift)
                    → lottery_packs (last_shift_ticket updated)
                        → Sold out
                            → lottery_packs (status: soldout)
                            → lottery_pack_events (action: soldout)
```

---

## Locations

Stored in the `lottery_locations` table (Settings tab). Two types:

- **Stations** — audit-eligible locations (Station 1, 2…). Books here can be activated and audited.
- **Extra locations** — staging only. Books received here stay in `received` status.
- **Office / Extra** — always present, fixed. Default receive location.

### `lottery_locations`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | |
| `name` | text | Display name (e.g. `Station 1`) |
| `type` | text | `station` or `extra` |
| `sort_order` | int | Display order |
| `slot_count` | int (nullable) | Number of physical display slots at this station. Null = unstructured (no slot grid). Only applies to stations. |

---

## Station Line Numbers

Each station can have a configurable number of physical display slots ("lines"). Staff assign each active book to a slot so it can be identified by position during audit.

- **Admin setup**: Set `slot_count` on a station in Settings. This defines how many numbered slot buttons appear in the picker.
- **Assignment**: In the stock view (location view), each activated book at a station shows a blue **L3** badge (assigned) or a **+ slot** button (unassigned). Tapping opens the slot picker.
- **One-to-one**: Each slot holds at most one book. Assigning to an occupied slot is blocked — the existing book must be unassigned first.
- **Slot count decrease**: Cannot be reduced below the highest currently-assigned line number. Unassign those books first.
- **Clearing slot structure**: Removing a station's `slot_count` entirely requires confirming a warning if any books have line numbers. All line numbers are cleared and each is logged as a `line_cleared` event.
- **On move**: `station_line` is always cleared when a book moves to a different location. Staff reassign at the destination.
- **Audit**: Line numbers appear on audit cards and the list sorts by line number (nulls last). Unscanned books with a line number are highlighted amber so staff know exactly which physical slot to check.
