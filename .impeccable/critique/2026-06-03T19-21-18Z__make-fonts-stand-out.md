---
target: make fonts stand out
total_score: 25
p0_count: 0
p1_count: 1
timestamp: 2026-06-03T19-21-18Z
slug: make-fonts-stand-out
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Status pills are clear; loading text blends with body |
| 2 | Match System / Real World | 3 | Monospace for numbers is correct; label/value mapping works |
| 3 | User Control and Freedom | 3 | Not typography-limited |
| 4 | Consistency and Standards | 2 | Four different "label" sizes: 9px, 10px, 11px, 11.5px all doing the same job |
| 5 | Error Prevention | 2 | Destructive actions share same text weight as neutral actions |
| 6 | Recognition Rather Than Recall | 2 | Flat body scale forces reading; users cannot scan by hierarchy |
| 7 | Flexibility and Efficiency | 3 | Data density appropriate; hierarchy doesn't aid power scanning |
| 8 | Aesthetic and Minimalist Design | 2 | 15+ distinct font sizes, most within a 9-14px band |
| 9 | Error Recovery | 3 | Error banners visually distinct |
| 10 | Help and Documentation | 2 | Section labels and instructional text share size and weight |
| Total | | 25/40 | Below average; typography is the primary bottleneck |

## Anti-Patterns Verdict

LLM assessment: Not egregiously AI-slop. Tripartite font system is well-conceived. Execution compresses hierarchy into 9-14px band. JetBrains Mono underused. 2 detector findings: overused-font (Space Grotesk, warning), flat-type-hierarchy (11-13px cluster, warning).

## Priority Issues

[P1] Nine font sizes between 9px and 14px. Fix: collapse to 3 body steps: 11px metadata, 13px body/values, 15px card headings. Suggested: /impeccable typeset

[P2] JetBrains Mono under-deployed. Several classes use bare monospace or Inter for data output. Fix: apply JetBrains Mono to all count, dollar, ticket, and pack number elements. Suggested: /impeccable typeset

[P2] Weight 700 is the default for too many roles. Fix: labels 700, body values 500-600, metadata 400-500, reserve 800 for display tier. Suggested: /impeccable typeset

[P3] No realized strong heading tier inside content sections. Fix: 18-20px/800 section headings on Stock, Reports, Lottery tabs. Suggested: /impeccable layout

[P3] item-found-code and item-nf-sub use generic monospace. Fix: switch to JetBrains Mono. Suggested: /impeccable typeset

## Persona Red Flags

Alex (Manager): Must read each pack row rather than scan by shape; 3 data points within 2px of each other at similar weights.
Jordan (Cashier): Label/value distinction unclear at 11px when everything is muted; JetBrains Mono badge surrounded by same-size context labels.

## Minor Observations

Sidebar logo at 16px could push to 18-19px. Qty display (36-42px JetBrains Mono) is strongest typographic moment; propagate outward. item-found-code and item-nf-sub both use bare monospace.
