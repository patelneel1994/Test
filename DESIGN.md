# Design

## Theme

Light.

Physical scene: a cashier or manager at a retail counter, scanning lottery tickets on a tablet or phone in a well-lit store during business hours. Warm ambient light, busy environment, glance-driven interactions. A light, cream-toned surface reads faster in that context than a dark one, and matches the warm, trustworthy feel of a well-run small business.

## Color Palette

Strategy: **Restrained** — warm cream neutrals as the base, brand red as the single functional accent (≤10% surface area), with semantic roles for amber (warning/staging), green (success/active), and red (error/destructive).

### Primitives

```
--cream:        #FAF7F0   background, page canvas
--cream-dk:     #F2EDE0   subtle section backgrounds, table headers
--ink:          #1A1612   primary text, sidebar, strong UI elements
--card:         #FFFFFF   card surfaces
--accent:       #FFCB45   amber/gold accent, active states
--accent-dk:    #8A6A00   amber text on light backgrounds
--brand-red:    #E13B3B   primary brand color, CTA, active nav
--brand-dk:     #9B1F1F   brand red dark (hover, pressed states)
--design-green: #0E8F5A   success, activated books, positive states
--blue:         #1E5DD8   directional/informational use (ASC direction)
```

### Ink Scale (opacity-based, all derived from --ink)

```
--ink-80:  rgba(26,22,18, .78)   primary text
--ink-70:  rgba(26,22,18, .68)   secondary text
--ink-60:  rgba(26,22,18, .54)   muted text, labels
--ink-50:  rgba(26,22,18, .42)   placeholder, hint
--ink-30:  rgba(26,22,18, .28)   subtle borders, dividers on focus
--ink-15:  rgba(26,22,18, .14)   borders, dividers
--ink-10:  rgba(26,22,18, .09)   card borders, very subtle separators
```

### Semantic Aliases

```
--bg:              var(--cream)
--surface:         var(--card)
--border:          var(--ink-15)
--text:            var(--ink)
--text-muted:      var(--ink-60)
--text-hint:       var(--ink-50)

--primary:         var(--brand-red)
--primary-dark:    var(--brand-dk)
--primary-bg:      rgba(225,59,59, .10)
--primary-border:  rgba(225,59,59, .25)

--red-bg:          rgba(185,28,28, .08)
--red-border:      rgba(185,28,28, .28)
--red-text:        #B91C1C

--green:           var(--design-green)
--green-bg:        rgba(14,143,90, .10)
--green-border:    rgba(14,143,90, .30)
--green-text:      var(--design-green)

--amber-bg:        rgba(255,203,69, .18)
--amber-border:    rgba(255,203,69, .45)
--amber-text:      var(--accent-dk)
```

### Price-tier Color Map

Used for lottery price pills only. Each price tier has a dedicated gradient:

| Price | Gradient |
|---|---|
| $1  | `linear-gradient(135deg, #22c55e, #16a34a)` — green |
| $2  | `linear-gradient(135deg, #06b6d4, #0891b2)` — cyan |
| $3  | `linear-gradient(135deg, #818cf8, #6366f1)` — indigo |
| $5  | `linear-gradient(135deg, #a78bfa, #7c3aed)` — violet |
| $10 | `linear-gradient(135deg, #fb923c, #ea580c)` — orange |
| $20 | `linear-gradient(135deg, #f43f5e, #e11d48)` — rose |
| $25 | `linear-gradient(135deg, #f43f5e, #be123c)` — crimson |
| $30 | `linear-gradient(135deg, #ec4899, #be185d)` — pink |
| $50 | `linear-gradient(135deg, #1A1612, #44403c)` — near-black |

## Typography

Three typefaces, each with a distinct role:

| Family | Role | Weights |
|---|---|---|
| **Space Grotesk** | Display, navigation, labels, buttons, headings | 400, 500, 600, 700, 800 |
| **Inter** | Body text, descriptions, prose | 400, 500, 600, 700 |
| **JetBrains Mono** | Barcodes, ticket numbers, monetary values, data | 400, 500, 600, 700, 800 |

### Scale (approximate)

```
Page title:       38px / 800 / Space Grotesk / tracking -.02em
Section title:    16–17px / 800 / Space Grotesk
Card heading:     15–16px / 700 / Space Grotesk
Body:             13–14px / 400–600 / Inter
Label (caps):     10–11px / 700 / Space Grotesk / uppercase / tracking .06–.12em
Mono data:        11–14px / 700–800 / JetBrains Mono
Badge/pill:       10–11px / 700 / Space Grotesk / uppercase
```

Hierarchy uses weight contrast, not just size. 800 vs. 400 in the same size creates clear primary/secondary reading order.

## Spacing & Layout

No universal container. Content pads directly inside the scrolling `app-content` div.

### Main padding (responsive)

```
Mobile (< 500px):  10px 12px 40px
Base:              28px 36px 80px
Tablet (768px+):   18px 24px 56px
Desktop (960px+):  20px 32px 56px
Large (1200px+):   20px 32px 56px  (wider scan column)
```

### Gap scale (within components)

```
4px   — tight inline gaps (badge + label, icon + text)
6px   — pill/tag row gaps
8px   — card grid gap, form field gap
10px  — pack row gap, meta grid gap
12px  — card padding rhythm
14px  — section margin-bottom, card interior spacing
16px  — catalog grid gap, card padding (mobile)
20px  — dashboard section margin, desktop card padding
```

### Grid patterns

- Stat grid: `repeat(4, 1fr)` → `repeat(2, 1fr)` at 900px
- Catalog grid: `repeat(auto-fill, minmax(340px, 1fr))`
- Dashboard two-col: `1.2fr 1fr` → 1col at 860px
- Audit shell: `340px 1fr` → 1col at 700px
- Scan layout (desktop 960px+): `420px 1fr` → `460px 1fr` at 1200px

## Border Radius

```
--radius:     16px   cards, modals, panels
--radius-sm:  12px   scan inputs, secondary cards, form elements
--radius-xs:   8px   inline badges, small buttons, inputs
999px          —      pills, tags, full-round buttons
```

## Elevation

No box-shadow on resting state by default. Shadow appears on hover only:

```
Card hover:      0 4px 20px rgba(26,22,18, .07)
Station hover:   0 4px 14px rgba(26,22,18, .09)
Sidebar icon:    0 4px 14px rgba(0,0,0, .30)       (on dark)
Price pills:     0 3px 10px {color-specific}
```

Borders carry the primary structural separation. Shadow is for elevation during interaction.

## Borders

Default: `1px solid var(--border)` — `rgba(26,22,18, .14)`.

Interactive/focused: `1.5px solid` with semantic color (brand-red for primary inputs, ink-30 for neutral focus).

Cards use `1px solid var(--ink-10)` (slightly more subtle than `--border`).

## Motion

Fast and functional. No decorative animation.

```
Default transition:   .12s–.15s  — background, color, border-color
Chevron rotate:       .18s–.20s  — ease
Progress bar fill:    .25s–.40s  — ease
New item flash:       .35s        — ease (newItem keyframe)
Success fade:         2.5s        — fadeOut keyframe (forward fill)
Scale press:          .08s–.10s  — transform: scale(.91–.96)
```

No bounce. No elastic. No layout-property animation. Exponential ease-out curves only.

Reduced motion: not yet wired up; should be added when motion becomes more pervasive.

## Component Patterns

### Pills / Badges

All use `border-radius: 999px`. Two sizes:

- **Filter/sort pills**: `font-size: 11px / font-weight: 700 / padding: 4–5px 12–14px / Space Grotesk`
- **Status badges**: `font-size: 10px / font-weight: 700 / uppercase / padding: 2px 8px`

Active state: fills with `--ink` background + `--cream` text (for filter pills) or semantic color (for status pills).

### Cards

White (`--card`) surface, `border: 1px solid --ink-10`, `border-radius: var(--radius)`. No default shadow. Section headers inside cards use `--cream-dk` background with a bottom border, not a separate card.

Never nest cards inside cards.

### Section Labels (UPPERCASE)

`font-size: 10–11px / font-weight: 700 / text-transform: uppercase / letter-spacing: .05–.12em / color: --ink-50 or --text-muted`. Used above sections, inside card headers, and as input labels.

### Buttons (full-round)

Primary action: `background: --ink / color: --cream / border-radius: 999px / Space Grotesk 700 / font-size: 14–16px / padding: 11–16px`.

Destructive: `background: --red-bg / color: --red-text / border: 1.5px solid --red-border`.

Secondary: `background: --surface / border: 1.5px solid --border / color: --text-muted`.

### Sidebar (dark)

`background: --ink`. Nav items use `rgba(250,247,240, .65)` text with `.10` background on active. Active indicator: 3px accent bar on the left edge (`--accent` yellow).

### Audit Panel (dark)

Left panel mirrors the sidebar: `--ink` background, cream text, subtle `rgba(255,255,255, .07)` backgrounds for nested elements.

## Fonts Loading

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
```

`font-display: swap` is included via `&display=swap` in the Google Fonts URL.
