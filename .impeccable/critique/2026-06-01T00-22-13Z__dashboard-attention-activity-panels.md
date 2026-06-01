---
target: dashboard-attention-activity-panels
total_score: 23
p0_count: 1
p1_count: 2
timestamp: 2026-06-01T00-22-13Z
slug: dashboard-attention-activity-panels
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Loading shown. Activity has timestamps. Attention items had no date — temporal context missing entirely. |
| 2 | Match System / Real World | 3 | Plain-language titles. "⚠ Scan discrepancy recorded" slightly technical. |
| 3 | User Control and Freedom | 2 | Refresh on activity, nothing on attention. No way to acknowledge or resolve a flagged item. |
| 4 | Consistency and Standards | 3 | Follows design system. Emoji icons on attention vs letter initials on activity is inconsistent icon language. |
| 5 | Error Prevention | 2 | Missing date on attention items causes misinterpretation — cashier can't distinguish urgent from stale. |
| 6 | Recognition Rather Than Recall | 2 | Flagged items show what happened but not what to do. No visible next step. |
| 7 | Flexibility and Efficiency | 2 | No quick actions. Managers can't act on anything from this panel. |
| 8 | Aesthetic and Minimalist Design | 3 | Clean. Refresh button in activity header takes prime real estate for an infrequent action. |
| 9 | Error Recovery | 1 | No way to dismiss, acknowledge, or resolve a discrepancy from this panel. |
| 10 | Help and Documentation | 2 | No contextual guidance for what "needs attention" means or what to do. |
| **Total** | | **23/40** | **Needs Work** |

## Anti-Patterns Verdict

**LLM assessment**: Not AI slop overall, but the letter-initial avatar icons in Recent Activity are the generic "activity log SaaS component" reflex. Emoji on attention items is tonally wrong — discrepancy = urgency, not playfulness. The composition is clean and product-native otherwise.

**Deterministic scan**: 2 findings — overused fonts (Space Grotesk/Inter) and flat type hierarchy (11–13px cluster with only color separation, no weight contrast).

## Priority Issues

**[P0] Attention items have no temporal anchor** — Fixed: added _fmtAttentionDate(), .att-when/.att-when-label/.att-when-val CSS, and "Logged" timestamp in render.

**[P1] Activity timestamps too subtle** — Fixed: .act-time bumped to 12px, --text-muted (was 11px, --text-hint), added weight 500.

**[P1] No next-step affordance on flagged items** — Outstanding. Users see problem but not action.

**[P2] Emoji icons on attention items tonally wrong** — Outstanding. Game emojis undercut urgency.

**[P2] Flat type hierarchy** — Partially addressed: .att-note weight increased from 500 to 600.

## Persona Red Flags

**Fatima (Cashier)**: Sees flagged item with no date. Can't triage if urgent. Panel fails its primary job. (Addressed with date fix.)

**Marco (Manager)**: Can't determine if discrepancies are from today or last week. No resolution path from panel.

**Sam (Accessibility)**: .att-bc span has no screen reader context. .att-dot emoji has no aria-label. --text-hint at 11px fails WCAG AA contrast.
