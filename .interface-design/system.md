# OpenRepurpose Design System

**Version:** OpenRepurpose Design System: 1.0  
**Status:** Permanent visual specification  
**Source of truth:** the implemented CSS tokens under `apps/web/src/styles/tokens/`

This document defines OpenRepurpose's visual language. It records the implemented Phase 5 token foundation and the selected product direction. If prose here and the source implementation ever differ, the implementation must be reconciled deliberately; feature code must not choose one ad hoc.

## Product direction

OpenRepurpose combines a **Routing Workbench** structural foundation with **Workshop Ledger** approachability.

- It is a desktop management and automation tool accessed through a local web interface, not a marketing site or generic SaaS dashboard.
- It is dark-first. A complete light semantic mapping exists so components can be theme-compatible without owning theme-specific values.
- It is information-dense, quiet, durable, and legible during long-running use.
- It is designed for creators and operators managing accounts, sources, destinations, workflows, media, jobs, and future automation.
- The shell exposes system structure and status quickly without allowing infrastructure detail to dominate routine work.
- Complexity is progressive: beginner workflows remain direct while experienced operators can reveal denser navigation, inspection, and activity tools.
- OpenRepurpose owns the application identity. Platform branding is local, restrained, and subordinate.

## Token architecture

The permanent dependency direction is:

```text
Reference tokens -> Semantic tokens -> Component tokens -> Components/features
```

All canonical custom properties use the `--or-*` prefix.

| Layer        | Implemented path                            | Responsibility                                                                                                                         |
| ------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Reference    | `apps/web/src/styles/tokens/reference.css`  | Raw palettes, type scale, spacing, geometry, motion, breakpoints, and z-index values                                                   |
| Semantic     | `apps/web/src/styles/tokens/semantic.css`   | Dark and light meanings for surfaces, text, structure, actions, status, routes, selection, and elevation                               |
| Component    | `apps/web/src/styles/tokens/components.css` | Stable measurements and contracts for the shell, controls, navigation, tables, panes, feedback, workflow routes, and platform identity |
| Global entry | `apps/web/src/styles.css`                   | Import order, global defaults, focus treatment, text selection, and reduced-motion enforcement                                         |

Tailwind v4 `@theme inline` variables and shadcn-compatible variables are aliases to OpenRepurpose semantic tokens. They contain no independent design values and are not a second token source.

## Reference values

### Color

The neutral palette is warm enough to feel approachable while remaining appropriate for a technical workbench.

| Token          | Value     | Token          | Value     |
| -------------- | --------- | -------------- | --------- |
| `--or-ink-0`   | `#ffffff` | `--or-ink-25`  | `#fbfaf7` |
| `--or-ink-50`  | `#f5f3ed` | `--or-ink-100` | `#e9e7e0` |
| `--or-ink-200` | `#d6d4cd` | `--or-ink-300` | `#b9b9b4` |
| `--or-ink-400` | `#969996` | `--or-ink-500` | `#767b7b` |
| `--or-ink-600` | `#596062` | `--or-ink-700` | `#3d4448` |
| `--or-ink-800` | `#292f35` | `--or-ink-850` | `#22282e` |
| `--or-ink-900` | `#191e24` | `--or-ink-925` | `#13171c` |
| `--or-ink-940` | `#101419` | `--or-ink-950` | `#0d1014` |

Routing copper identifies OpenRepurpose, deliberate selection, and active workflow paths. It is not a general warning color.

| Token             | Value     | Token             | Value     |
| ----------------- | --------- | ----------------- | --------- |
| `--or-copper-50`  | `#fff4ed` | `--or-copper-100` | `#ffe4d3` |
| `--or-copper-200` | `#ffc7a6` | `--or-copper-300` | `#f5a273` |
| `--or-copper-400` | `#e78652` | `--or-copper-500` | `#cb6c3d` |
| `--or-copper-600` | `#a95330` | `--or-copper-700` | `#844027` |
| `--or-copper-800` | `#623120` | `--or-copper-900` | `#45231a` |

Status palettes keep operational meaning distinct from copper.

| Meaning                      | 100       | 300       | 500       | 700       | 900       |
| ---------------------------- | --------- | --------- | --------- | --------- | --------- |
| Green / success              | `#e1f5e7` | `#9ddaae` | `#4ea76c` | `#287041` | `#153822` |
| Blue / information and focus | `#e3f1ff` | `#93c9ff` | `#4c93db` | `#27659f` | `#163a5d` |
| Yellow / warning             | `#fff1c2` | `#eec65b` | `#b98a20` | `#77550c` | `#3e2d08` |
| Red / danger                 | `#ffe6e7` | `#f4a0a3` | `#d45a5f` | `#93363b` | `#4d2023` |

### Typography

The approved interface family is Fira Sans and the approved technical family is Fira Mono.

```css
--or-font-interface:
  'Fira Sans', ui-sans-serif, system-ui, -apple-system, blinkmacsystemfont, 'Segoe UI', sans-serif;
--or-font-technical:
  'Fira Mono', ui-monospace, sfmono-regular, consolas, 'Liberation Mono', monospace;
```

The font binaries are not yet bundled. The approved fallback stacks above are the current implementation and must remain in place until the repository's asset mechanism safely self-hosts the approved families. A different design font must not be substituted silently.

| Role      | Size / line height     | Intended use                                   |
| --------- | ---------------------- | ---------------------------------------------- |
| Micro     | `0.6875rem / 1rem`     | Dense auxiliary markers only                   |
| Metadata  | `0.75rem / 1rem`       | Timestamps, IDs, counts, compact status detail |
| Interface | `0.8125rem / 1.125rem` | Dense controls, labels, navigation             |
| Body      | `0.875rem / 1.25rem`   | Default application copy                       |
| Section   | `1rem / 1.5rem`        | Pane and section headings                      |
| Page      | `1.25rem / 1.75rem`    | Workspace title                                |
| Title     | `1.5rem / 2rem`        | Setup and high-emphasis title                  |
| Display   | `2rem / 2.5rem`        | Rare onboarding or major empty-state display   |

Weights are `400`, `500`, and `600`. Tracking is `-0.015em` for page titles, `-0.01em` for section headings, `0.01em` for metadata, and `0.08em` for overlines. Prose measure is capped at `65ch`. Technical values, logs, identifiers, paths, and code use `--or-font-technical`; the interface does not use monospace as decoration.

### Spacing and geometry

Spacing follows a four-pixel grid with one two-pixel micro-step.

| Token suffix | Value      | Pixels at 16px root |
| ------------ | ---------- | ------------------- |
| `0`          | `0`        | 0                   |
| `0-5`        | `0.125rem` | 2                   |
| `1`          | `0.25rem`  | 4                   |
| `1-5`        | `0.375rem` | 6                   |
| `2`          | `0.5rem`   | 8                   |
| `3`          | `0.75rem`  | 12                  |
| `4`          | `1rem`     | 16                  |
| `5`          | `1.25rem`  | 20                  |
| `6`          | `1.5rem`   | 24                  |
| `8`          | `2rem`     | 32                  |
| `10`         | `2.5rem`   | 40                  |
| `12`         | `3rem`     | 48                  |
| `16`         | `4rem`     | 64                  |

Radii are restrained: none `0`, xs `2px`, sm `4px`, md `6px`, lg `8px`, xl `12px`, and full `999px`. Most workbench controls use the 4px small radius; panels and dialogs stop at 8px. Full radius is reserved for intrinsically circular controls or indicators, not generic pills.

Borders use `1px` by default and `2px` for emphasis. Focus rings are `2px` with a `2px` offset.

### Motion

Motion communicates state and spatial continuity; it is not decorative.

| Token                    | Value                             |
| ------------------------ | --------------------------------- |
| Instant                  | `0ms`                             |
| Fast                     | `100ms`                           |
| Standard                 | `160ms`                           |
| Deliberate               | `220ms`                           |
| Exit/response easing     | `cubic-bezier(0.23, 1, 0.32, 1)`  |
| Spatial movement easing  | `cubic-bezier(0.77, 0, 0.175, 1)` |
| Small movement distance  | `0.25rem`                         |
| Medium movement distance | `0.5rem`                          |
| Press scale              | `0.98`                            |

Under `prefers-reduced-motion: reduce`, component durations become `0ms`, movement distances become `0`, and press scale becomes `1`. The global stylesheet additionally suppresses animation repetition, clamps animation and transition duration, and disables smooth scrolling.

### Responsive modes and layering

| Boundary token            | Value            | Mode beginning at boundary |
| ------------------------- | ---------------- | -------------------------- |
| `--or-breakpoint-compact` | `40rem` / 640px  | Narrow                     |
| `--or-breakpoint-narrow`  | `64rem` / 1024px | Workbench                  |
| `--or-breakpoint-wide`    | `90rem` / 1440px | Wide workbench             |

The modes are behavioral, not merely scaling points:

- Below 640px: one primary pane; secondary panes become full-screen sheets.
- 640–1023px: one primary pane with overlay navigator and inspector.
- 1024–1439px: rail, navigator, and workspace may coexist; the inspector is generally an overlay.
- 1440px and above: the optional inspector may coexist when useful.

Do not squeeze multiple workbench panes below their readable minimum widths.

Layer values are base `0`, sticky `10`, shell `20`, backdrop `30`, drawer `40`, popover `50`, dialog `60`, toast `70`, and tooltip `80`. Components must use these layers instead of locally escalating arbitrary z-index values.

## Semantic themes

Dark is the shipped default through `:root` and `[data-theme='dark']`. Light is fully mapped through `[data-theme='light']`. Both themes expose the same semantic contracts.

### Surfaces, text, and structure

| Semantic token                           | Dark mapping             | Light mapping            |
| ---------------------------------------- | ------------------------ | ------------------------ |
| `--or-bg-canvas`, `--or-bg-shell`        | ink 950                  | ink 100                  |
| `--or-bg-workspace`                      | ink 940                  | ink 25                   |
| `--or-bg-navigator`, `--or-bg-inspector` | ink 925                  | ink 50                   |
| `--or-bg-surface`                        | ink 900                  | ink 0                    |
| `--or-bg-surface-raised`                 | ink 850                  | ink 0                    |
| `--or-bg-overlay`                        | ink 800                  | ink 0                    |
| `--or-bg-control`                        | `#0b0e12`                | ink 100                  |
| `--or-bg-hover`                          | ink 850                  | `rgb(214 212 205 / 0.6)` |
| `--or-bg-selected`                       | `rgb(231 134 82 / 0.14)` | copper 100               |
| `--or-bg-backdrop`                       | `rgb(0 0 0 / 0.64)`      | `rgb(13 16 20 / 0.36)`   |
| `--or-text-primary`                      | ink 50                   | ink 950                  |
| `--or-text-secondary`                    | ink 200                  | ink 800                  |
| `--or-text-tertiary`                     | ink 400                  | ink 600                  |
| `--or-text-disabled`                     | ink 500                  | ink 400                  |
| `--or-text-inverse`                      | ink 950                  | ink 0                    |
| `--or-text-link`                         | copper 300               | copper 700               |
| `--or-border-subtle`                     | warm white at 7%         | ink 200                  |
| `--or-border-default`                    | warm white at 11%        | ink 300                  |
| `--or-border-strong`                     | warm white at 18%        | ink 400                  |
| `--or-border-selected`                   | copper 400               | copper 700               |
| `--or-focus-ring`                        | blue 300                 | blue 700                 |

Controls inherit semantic control backgrounds, text, placeholders, and borders. Disabled controls use ink 900/500 in dark and ink 100/400 in light.

### Actions and status

Primary actions use copper 400/300/500 in dark and copper 700/800/900 in light for default/hover/active. Secondary and ghost actions use neutral surfaces. Destructive actions use red 500/300 in dark and red 700/900 in light. Disabled action values remain neutral.

| Meaning     | Dark foreground / background / border              | Light foreground / background / border |
| ----------- | -------------------------------------------------- | -------------------------------------- |
| Success     | green 300 / green 500 at 12% / green 500 at 35%    | green 700 / green 100 / green 300      |
| Information | blue 300 / blue 500 at 12% / blue 500 at 35%       | blue 700 / blue 100 / blue 300         |
| Warning     | yellow 300 / yellow 500 at 14% / yellow 500 at 40% | yellow 700 / yellow 100 / yellow 300   |
| Danger      | red 300 / red 500 at 14% / red 500 at 40%          | red 700 / red 100 / red 300            |
| Neutral     | ink 300 / ink 300 at 8% / default border           | ink 700 / ink 100 / ink 300            |

Status color never carries meaning alone. Pair it with text, an icon, a route pattern, or another perceivable cue.

### Routes, selection, and depth

Workflow routes map as follows:

| Route state | Dark          | Light         |
| ----------- | ------------- | ------------- |
| Default     | strong border | strong border |
| Selected    | copper 400    | copper 700    |
| Running     | blue 300      | blue 700      |
| Completed   | green 300     | green 700     |
| Waiting     | yellow 300    | yellow 700    |
| Failed      | red 300       | red 700       |
| Disabled    | ink 500       | ink 500       |

Default route width is `2px`; active route width is `3px`. Copper denotes the selected routing path, not completion or warning.

Depth is structural and rare. Dark popovers use `0 8px 24px rgb(0 0 0 / 0.32)` plus a subtle one-pixel ring; dark dialogs use `0 20px 48px rgb(0 0 0 / 0.42)` plus a subtle ring. Light popovers use `rgb(13 16 20 / 0.14)` and light dialogs use `rgb(13 16 20 / 0.2)` with corresponding rings. Base panes are separated by backgrounds and borders, not card shadows.

## Density and component measurements

Default controls and rows are 40px high. Compact controls and rows are 32px; comfortable rows are 48px and comfortable/setup controls are 44px. Minimum desktop target size is 40px and mobile target size is 44px.

- Icons: 12, 16, 20, and 24px.
- Buttons: 32/40/44px high; 10/14/16px inline padding; 6/8px gaps; 4px radius; icon-only target 40px.
- Fields: 40px high, 44px in setup; 12px inline padding; 4px radius; 13px labels; 12px help copy; textarea minimum 96px.
- Navigation: 40px rows, 16px nested indent, 3px active edge.
- Tables: 32px headers; 32/40/48px density rows; 12px inline cell padding.
- Panes: 12px compact or 16px default padding; inspector block gap 16px.
- Setup: 24px section padding, 32px section gap, 48px major gap, 8px section radius.
- Dialogs: 420/560/720px widths, 24px padding, 8px radius.
- Sheets: 360/420px widths before compact full-screen behavior.
- Alerts: 12px block and 16px inline padding, 6px radius.
- Status badges: 22/24px high, 4px radius.
- Toast maximum width: 360px. Empty-state maximum width: 480px.
- Workflow nodes: 176px minimum, 208px preferred, 256px maximum; 12px padding; 8px gap; 6px radius; 32px minimum header; 3px status rail.

## Application shell

The permanent shell is a workbench composed of independently useful regions:

1. **Top command bar** — 48px high. It contains product identity, high-level context, global commands, and system-level status. It is not a marketing header.
2. **Resource rail** — 56px wide with 40px controls. It provides fast switching among major resource families such as sources, workflows, destinations/accounts, media, jobs, and settings.
3. **Navigator** — 240px default, 200px minimum, 288px maximum. It provides contextual lists, saved views, filtering, and local navigation for the active resource family.
4. **Workspace** — the primary working area, with a 560px minimum before the responsive mode changes. It holds tables, editors, canvases, configuration flows, and detailed resource views.
5. **Optional inspector** — 320px default, 280px minimum, 384px maximum. It opens for selection-specific properties, validation, metadata, and advanced controls; it is closed until useful.
6. **Activity shelf** — 36px collapsed, 240px default, and no more than 40vh. It shows active and recent jobs, progress, warnings, and operational detail. It stays quiet or collapsed while idle.

**Focus mode** suppresses nonessential navigator, inspector, and activity chrome while preserving a clear path back and keeping critical system status accessible. It is suitable for involved workflow editing, logs, or setup tasks.

**Setup and configuration** use the same system but a simpler, more spacious composition. Content is capped at 760px or 920px for wide setup content. Setup must not display every workbench pane merely because the shell supports them.

## Progressive complexity

The existence of an inspector, navigator, activity shelf, advanced control, or technical detail does not imply it must always be visible.

**Beginner path:** Sources -> Workflows -> Destinations.

**Experienced workspace:** Resource rail + navigator + workspace/canvas + inspector + activity.

The same design system supports both.

- The inspector is closed until useful.
- Activity is quiet or collapsed while idle.
- Setup is simpler and more spacious.
- Technical details live deeper in inspectors, diagnostics, and logs.
- Primary task paths appear before advanced controls.
- Advanced disclosure must preserve discoverability, current state, and the reason an action is unavailable.

## Component design rules

### Buttons and icon buttons

- Use primary buttons for the single most important scoped action, secondary buttons for ordinary actions, ghost buttons for low-emphasis chrome, and danger buttons only for destructive outcomes.
- Labels use verbs and remain specific. Loading preserves the control width, identifies the action in progress, and prevents duplicate submission.
- Icon buttons require an accessible name and a tooltip when the icon's meaning is not already explicit. Use the 40px minimum target; use 44px on compact/mobile surfaces.
- Disabled actions must explain why when the reason is not obvious. Do not use disabled styling to hide a platform limitation.

### Fields and form sections

- Every field has a persistent label. Placeholder text is an example or hint, never the only label.
- Help text precedes an error until validation fails; an error then appears adjacent to the field and is programmatically associated.
- Use 40px fields in workbench contexts and 44px fields in setup. Group related fields into named sections rather than building a wall of controls.
- Put advanced and platform-specific settings behind deliberate disclosure without concealing required configuration.
- Preserve entered values after recoverable submission errors.

### Badges and status

- Badges are compact metadata, not primary actions.
- Status badges use semantic status tokens and explicit text. Copper is not a success or warning badge color.
- Connection state, queue state, and job outcome remain distinct concepts even when visually adjacent.

### Lists and tables

- Use lists for browse/select workflows and tables for repeated, comparable fields.
- Tables keep headers visible when useful, align numeric and technical data consistently, and preserve keyboard navigation and accessible names.
- Density is chosen per surface, not per row. Row hover cannot be the only affordance; selected and focused states remain distinct.
- On smaller screens, reduce columns or switch to a structured list. Do not create unreadable horizontal compression.

### Navigation and panes

- The rail switches resource families; the navigator changes context within the current family. Do not duplicate the same level in both.
- Active navigation uses more than color: the 3px active edge, foreground contrast, and selection background work together.
- Pane borders and surface changes establish hierarchy. Avoid wrapping every group in a floating card.
- Pane headers keep title, local status, and actions in consistent locations.

### Dialogs and sheets

- Dialogs interrupt for bounded decisions or required input; sheets preserve workbench context for inspection or secondary tasks.
- Focus is trapped while modal, returns to the invoking control, and the Escape key closes when doing so is safe.
- Destructive confirmation names the affected object and consequence.
- On compact screens, sheets become full-screen and dialogs respect the viewport.

### Toasts and alerts

- Toasts confirm transient outcomes that do not require immediate action. Persistent or actionable failures belong inline, in an alert, or in activity.
- Alerts carry a clear status, title, message, and recovery action where possible.
- Success feedback is concise and does not obscure the next task.

### Empty, loading, and error states

- Empty states explain whether the resource has never existed, is filtered out, is disconnected, or could not load. Offer one clear next action when available.
- Prefer local skeletons or stable progress regions. Avoid replacing the entire shell for a local load.
- Loading states preserve layout and announce meaningful progress without decorative indefinite animation.
- Error states use plain language, retain actionable diagnostic context, and distinguish retryable, validation, permission, platform, and local-system failures.
- A fatal render failure remains contained by the application error boundary and must not expose secrets.

### Workflow nodes and routes

- Nodes express source, transform/filter, and destination roles consistently. Header, status rail, platform mark, title, and essential metadata occupy stable positions.
- Selected, focused, running, completed, waiting, failed, disabled, and disconnected states remain distinguishable.
- Routes use semantic route tokens. A route is not decorative: it communicates topology and execution state.
- Node or route animation must not be the only indication of processing and must respect reduced motion.

### Activity and progress

- The activity shelf prioritizes currently running, waiting, retrying, failed, and recently completed work.
- Progress distinguishes indeterminate work from measurable progress and names the affected job or destination.
- Idle activity collapses. Failures and required user actions may elevate the shelf without stealing focus unexpectedly.
- Cancellation, retry, and diagnostic actions reflect actual job semantics and never imply completion before platform processing has completed.

## Platform branding

OpenRepurpose owns the shell, typography, surface hierarchy, selection, focus, actions, and semantic status language.

- Platform marks are 16px or 20px, with a 3px local accent when needed and default identity opacity `0.88`.
- A platform color may identify a mark, a narrow local accent, or a platform-specific metadata region.
- Platform color never replaces semantic application color, becomes a global token, floods a panel, controls focus, or changes the meaning of success, warning, danger, selection, or workflow state.
- Platform-specific colors remain metadata local to the integration/presentation mapping.

## State design

Every interactive component implements the states that apply to it:

| State        | Contract                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| Default      | Clear role, readable label, stable geometry                              |
| Hover        | Subtle semantic surface/border response; never the only affordance       |
| Focus        | Visible `2px` semantic focus ring with `2px` offset                      |
| Selected     | Selection surface plus border/edge/text cue distinct from focus          |
| Disabled     | Reduced affordance, preserved legibility, and an explanation when needed |
| Loading      | Stable layout, duplicate-action prevention, accessible progress text     |
| Success      | Green semantic treatment plus explicit outcome text/icon                 |
| Warning      | Yellow semantic treatment plus consequence and next action               |
| Error        | Red semantic treatment plus actionable message and retained context      |
| Empty        | Explanation of cause plus a relevant next action, if any                 |
| Disconnected | Explicit connection state; never represented as generic disabled alone   |
| Processing   | Blue/informational execution state, progress when measurable             |
| Queued       | Explicit waiting order/state, distinct from processing                   |
| Cancelled    | Neutral terminal state with time/context and retry when valid            |

## Accessibility contracts

The permanent frontend accessibility rules in `apps/web/AGENTS.md` are authoritative and must be followed rather than copied into feature-local conventions.

Visual-system-specific contracts are:

- Semantic foreground/background pairs must maintain WCAG AA contrast; text and meaningful icons target 4.5:1 and large text targets 3:1.
- Status, selection, route state, and platform state never rely on color alone.
- `:focus-visible` remains clearly visible in both themes and is not removed without an equivalent token-based treatment.
- Desktop targets are at least 40px; compact/mobile targets are at least 44px.
- Native semantics are preferred. Custom composite widgets implement the applicable keyboard pattern and accessible state.
- Dense information remains zoomable and reflows without forcing unreadable pane compression.
- Motion is optional reinforcement and reduced-motion behavior is part of the token contract.
- Errors are associated with their controls, progress is announced appropriately, and live updates avoid excessive interruption.

## Governance

- Existing tokens and components must be reused before new ones are created.
- Feature code cannot invent raw colors.
- Feature code cannot introduce a new spacing, type, radius, or shadow system.
- New semantic tokens require genuinely new meaning, not a one-off visual preference.
- New reusable UI patterns extend the design system before feature use.
- Dark and light semantic mappings change together.
- Platform-specific colors are not global design tokens.
- Progressive complexity must be preserved.
- Reference tokens are not consumed directly by features when a semantic or component token expresses the intent.
- Tailwind and shadcn aliases always resolve to canonical `--or-*` tokens.
- Changes to visual vocabulary update this document in the same change. Technical architecture changes update `docs/UI_ARCHITECTURE.md`.

## Current implementation note

Phase 5 installed the token foundation. Phase 7 added the shared primitive layer at `apps/web/src/components/ui/`. Phase 8 added the v0.5-justified domain-pattern layer at `apps/web/src/components/patterns/`: restrained platform identity, connection presentation, job and workflow status, resource empty states, and the read-only source-to-stage-to-destination workflow route. Phase 9 migration group 1 added the shell foundation at `apps/web/src/components/layout/`: application shell, top command bar, workspace, page header, and skip link. Phase 9 migration group 2 added token-backed global resource navigation in the same layout layer: a 56px icon-led rail at workbench widths and a labeled horizontal strip below the workbench breakpoint. It preserves the existing route set and history behavior, uses a 3px copper active edge plus surface and foreground cues, and does not add a contextual navigator where v0.5 has no contextual collection. Optional shell regions consume no space when absent, the inspector defaults closed, and activity expansion is caller-controlled. This work implements the visual vocabulary already specified above, so the design-system version remains 1.0.
