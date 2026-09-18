# AGENTS.md — OpenRepurpose Frontend Rules

These rules apply to all frontend work within `apps/web/`.

## Authority and source-of-truth relationship

1. Follow project-wide engineering and architecture rules from the repository root `AGENTS.md`.
2. Follow the permanent frontend rules in this file.
3. Once it exists, follow `.interface-design/system.md` as the authoritative visual design system.
4. Once it exists, follow `docs/UI_ARCHITECTURE.md` for frontend component organization and extension rules.
5. Reuse existing design-system components and tokens before creating new ones.
6. Extend the design system only when it cannot express a genuinely reusable requirement.

If instructions conflict, prefer the more specifically scoped instruction. Never weaken accessibility,
safety, data integrity, or architectural constraints. Report unresolved conflicts instead of silently
choosing.

The selected permanent visual direction is **Routing Workbench structure + Workshop Ledger
approachability**. This file defines permanent frontend quality, accessibility, interaction, and product
requirements; it does not replace the future visual specification.

# Permanent Frontend Rules

These rules are mandatory for all current and future OpenRepurpose frontend work.

Use MUST / SHOULD / NEVER exactly as requirements.

## Interactions

### Keyboard

- MUST: Full keyboard support per WAI-ARIA Authoring Practices Guide patterns.
- MUST: Visible, unobscured focus rings using `:focus-visible`; group controls with `:focus-within` when useful.
- MUST: Sticky/fixed elements never cover the currently focused element.
- MUST: Manage focus correctly for dialogs, menus, drawers, popovers, and similar interaction patterns, including focus trap/move/return where required.
- NEVER: Use `outline: none` without providing an equally visible focus replacement.

### Targets & Input

- MUST: Hit target at least 24 px; on mobile prefer at least 44 px.
- MUST: If the visible control is smaller than the required hit target, expand its interactive area.
- MUST: Mobile `<input>` font size at least 16 px to prevent unwanted iOS zoom.
- NEVER: Disable browser zoom with `user-scalable=no`, `maximum-scale=1`, or equivalent.
- MUST: Use `touch-action: manipulation` where appropriate to prevent accidental double-tap behavior.
- SHOULD: Set `-webkit-tap-highlight-color` to harmonize with the design.

### Forms

- MUST: Inputs remain hydration-safe; hydration must not lose focus or entered values.
- NEVER: Block paste in `<input>` or `<textarea>`.
- MUST: Loading buttons show a spinner/progress indicator while keeping the original action label understandable.
- MUST: Enter submits the focused single-line form input where expected.
- MUST: In multiline text entry, support Ctrl+Enter / Cmd+Enter submission where the interaction calls for it.
- MUST: Keep submit enabled until the request actually starts; then disable appropriately and show loading state.
- MUST: Accept free text while typing and validate after; do not prevent users from entering temporarily incomplete values.
- MUST: Allow incomplete form submission when needed to surface validation errors clearly.
- MUST: Show errors inline next to relevant fields.
- MUST: On failed submission, move/focus attention to the first actionable validation error.
- MUST: Use `autocomplete`, meaningful `name`, appropriate `type`, and appropriate `inputmode`.
- SHOULD: Disable spellcheck for email addresses, codes, identifiers, and usernames.
- SHOULD: Placeholders use the ellipsis character `…` where appropriate and show an example format when helpful.
- MUST: Warn about unsaved changes before destructive navigation away from edited content.
- MUST: Remain compatible with password managers and 2FA flows.
- MUST: Allow users to paste verification codes.
- MUST: Trim values where trailing spaces would create accidental errors.
- MUST: Checkboxes and radios have no dead zone; the visible label and control form one useful hit target.

### State & Navigation

- MUST: URL reflects meaningful navigable state such as tabs, filters, pagination, selected resource, or expanded view when deep linking/back-forward behavior benefits from it.
- MUST: Browser Back/Forward restores expected state and scroll position.
- MUST: Real navigation uses `<a>` / router `<Link>` rather than generic clickable `<div>`.
- MUST: Navigation supports normal browser behavior such as Ctrl/Cmd-click and middle-click where appropriate.
- NEVER: Use `<div onClick>` as a substitute for semantic navigation.

### Feedback

- SHOULD: Use optimistic UI where it improves responsiveness and can be safely reconciled.
- MUST: On failed optimistic operations, roll back or provide a clear recovery/undo path.
- MUST: Destructive actions require confirmation or a meaningful undo window.
- MUST: Use polite `aria-live` for relevant toasts and inline validation feedback.
- SHOULD: Use the single-character ellipsis `…` for actions that open follow-up steps such as `Rename…` and for loading labels such as `Loading…`.

### Touch & Drag

- MUST: Use generous targets and clear affordances; avoid precision-dependent interactions.
- MUST: Tooltips should not appear instantly on the first hover; subsequent related tooltips may appear more quickly.
- MUST: Use `overscroll-behavior: contain` in modals/drawers where needed.
- MUST: During drag operations, disable accidental text selection.
- MUST: Use `inert` where appropriate to prevent interaction with content that should be temporarily unavailable.
- MUST: Drag, swipe, pinch, and path gestures have a click/tap and keyboard alternative unless the gesture itself is essential.
- MUST: Anything that visually appears clickable must actually be clickable.

### Autofocus

- SHOULD: Autofocus only when there is a clear single primary input, mostly on desktop.
- SHOULD: Avoid routine autofocus on mobile.

## Animation

- MUST: Respect `prefers-reduced-motion`.
- MUST: Provide a reduced-motion variant or disable nonessential motion.
- SHOULD: Prefer CSS animation/transition over Web Animations API, and Web Animations API over heavier JavaScript animation libraries when the behavior can be achieved cleanly.
- MUST: Animate compositor-friendly properties such as `transform` and `opacity`.
- NEVER: Animate layout properties such as `top`, `left`, `width`, or `height` for ordinary interface transitions.
- NEVER: Use `transition: all`; explicitly list transitioned properties.
- SHOULD: Use animation only to clarify cause/effect, orientation, state change, or deliberate product character.
- SHOULD: Match easing to distance, scale, and interaction trigger.
- MUST: Interactive animations are interruptible and responsive to input.
- MUST: Autoplay is limited to muted, nonessential loops.
- MUST: Motion lasting more than 5 seconds alongside other content has pause, stop, or hide controls when required.
- MUST: Set correct `transform-origin`.
- MUST: Apply SVG transforms on a suitable `<g>` wrapper with `transform-box: fill-box` when needed.

## Layout

- SHOULD: Use optical alignment where ±1 px improves perceived alignment.
- MUST: Every alignment should be deliberate relative to a grid, baseline, or neighboring edge.
- SHOULD: Balance icon/text lockups for weight, size, spacing, and contrast.
- MUST: Verify responsive behavior on mobile, normal laptop/desktop, and ultra-wide layouts.
- MUST: Simulate ultra-wide behavior where useful, including zoomed-out inspection.
- MUST: Respect safe areas via `env(safe-area-inset-*)` where relevant.
- MUST: Prevent unwanted horizontal/vertical scrollbars and fix overflow at the source.
- SHOULD: Prefer CSS flex/grid for layout instead of JavaScript measurement.

## Content & Accessibility

- SHOULD: Prefer inline help to tooltips when the information is important for successful task completion.
- MUST: Skeletons mirror final layout closely enough to avoid layout shift.
- MUST: `<title>` matches the current context/page.
- MUST: Avoid dead ends; provide an obvious next step, recovery path, or navigation route.
- MUST: Design empty, sparse, dense, loading, stale, success, and error states where relevant.
- SHOULD: Use typographic curly quotes where normal prose requires quotation marks.
- SHOULD: Avoid awkward widows/orphans where practical; use `text-wrap: balance` where appropriate.
- MUST: Use `font-variant-numeric: tabular-nums` for data intended for numeric comparison.
- MUST: Status is never communicated by color alone.
- MUST: Status uses redundant cues such as text, icon, shape, or pattern.
- MUST: Accessible names exist even when visual labels are omitted.
- MUST: Use the `…` character rather than three periods in interface copy.
- MUST: Use `scroll-margin-top` on headings when sticky UI could cover anchored content.
- MUST: Provide a “Skip to content” mechanism where the application shell makes it useful.
- MUST: Maintain meaningful hierarchical headings (`h1`–`h6`).
- MUST: Components remain resilient to short, average, and very long user-generated content.
- MUST: Format locale-sensitive dates, times, and numbers with platform locale APIs such as `Intl.DateTimeFormat` and `Intl.NumberFormat`.
- SHOULD: Use `translate="no"` for brand names, code tokens, paths, and identifiers that should not be machine-translated.
- MUST: `aria-label` text accurately describes the action/control.
- MUST: Decorative elements are hidden from assistive technology.
- MUST: Icon-only buttons have descriptive accessible names.
- MUST: Prefer native semantic elements such as `button`, `a`, `label`, and `table` before adding ARIA.
- MUST: Media has captions, transcripts, or descriptions where applicable.
- MUST: Media controls are keyboard-operable.
- MUST: Decorative media is hidden from assistive technologies.
- MUST: Use non-breaking spaces where splitting units/short technical combinations would reduce readability, such as `10&nbsp;MB` or `Ctrl&nbsp;K`.

## Content Handling

- MUST: Text containers handle long content using suitable truncation, clamping, or word-breaking.
- MUST: Flex children that need truncation use `min-width: 0` / equivalent.
- MUST: Empty strings and empty arrays must not produce broken layouts.

## Performance

- SHOULD: Test important UI paths under constrained conditions such as low-power/mobile and Safari when practical.
- MUST: Measure performance using a clean environment where browser extensions do not distort results.
- MUST: Track and minimize avoidable React/component re-renders using suitable tools where useful.
- MUST: Profile meaningful flows using CPU and network throttling.
- MUST: Batch layout reads/writes and avoid unnecessary reflow/repaint loops.
- MUST: User-visible mutations such as `POST`, `PATCH`, and `DELETE` should target responsive feedback, ideally under about 500 ms when the backend can support it.
- SHOULD: Prefer uncontrolled inputs when they materially reduce render cost and do not complicate correctness.
- MUST: Controlled inputs remain cheap per keystroke.
- MUST: Virtualize genuinely large lists when rendering more than roughly 50 expensive rows/items would harm performance.
- MUST: Preload above-the-fold images where useful and lazy-load noncritical images.
- MUST: Prevent cumulative layout shift by reserving image/media dimensions.
- SHOULD: Use `preconnect` for important external/CDN origins when justified.
- SHOULD: Preload critical fonts when appropriate and use `font-display: swap`.
- SHOULD: Prefer efficient video formats over animated GIF for nonessential animation.
- SHOULD: Provide still/reduced-motion fallbacks for looping media.

## Dark Mode & Theming

- MUST: When using a dark theme, set an appropriate `color-scheme` so native controls match.
- SHOULD: Set `<meta name="theme-color">` to match the current major application background where useful.
- MUST: Native `<select>` controls receive explicit background and text colors to avoid platform/Windows rendering problems.
- MUST: The token model must allow future light/dark themes without redesigning components.

## Hydration

- MUST: React/framework inputs using `value` provide `onChange`, otherwise use `defaultValue` appropriately.
- SHOULD: Guard date/time rendering where server/client locale or time differences could cause hydration mismatch.

## Design Quality

- SHOULD: Use layered shadows only where elevation is actually part of the design language.
- SHOULD: Prefer crisp edges produced by deliberate borders/rings and restrained shadows.
- SHOULD: Nested radii remain visually concentric; child radius must not visually exceed its parent container.
- SHOULD: Keep border, shadow, and text hues coherent with surrounding surfaces.
- MUST: Charts and data visualization are accessible to users with common color-vision deficiencies.
- MUST: Meet strong contrast requirements; APCA may be used as an additional modern contrast check.
- MUST: Hover, active, and focus states remain at least as legible as the default state.
- SHOULD: Browser/native UI should visually harmonize with the application background.
- SHOULD: Avoid visible dark-gradient banding; if a dark gradient is truly required, use an implementation that renders cleanly.

## OpenRepurpose-specific permanent UI principles

In addition to the general rules above, all future OpenRepurpose UI work must follow these product principles.

### Progressive complexity

Progressive complexity is a core OpenRepurpose design principle.

The existence of an inspector, navigator, activity shelf, advanced control, or technical detail does not mean it should always be visible.

Expose only the complexity needed for the current task while preserving immediate access to advanced capabilities.

Examples:

- Inspector remains closed until a selection/context makes it useful.
- Activity shelf remains collapsed when nothing requires attention.
- First-run/setup screens use simpler, more readable layouts.
- Technical details live deeper in inspectors, diagnostics, and logs.
- Advanced controls remain available without dominating beginner workflows.
- As the user creates more resources and workflows, the full workbench becomes progressively more useful.

The same design system must support both:

Beginner:
`Sources → Workflows → Destinations`

Experienced:
`Resource rail + navigator + workspace/canvas + inspector + live activity`

Do not create separate beginner and advanced visual systems.

### Product character

The UI should feel:

- dependable;
- precise;
- calm;
- local/self-hosted;
- durable;
- professional;
- creator/operator focused.

Avoid making it feel like:

- a generic SaaS admin template;
- an IDE clone;
- a marketing dashboard;
- an analytics dashboard;
- a consumer creator app.

### Platform identity

OpenRepurpose owns:

- shell;
- navigation;
- surfaces;
- typography;
- controls;
- spacing;
- status language;
- general visual hierarchy.

External platforms such as YouTube, TikTok, and future integrations may use:

- logo;
- icon;
- platform name;
- restrained identity accent where useful.

Platform colors must not take over:

- navigation;
- entire cards;
- primary actions;
- general application surfaces.

### Future scalability

The frontend architecture must accommodate future features without requiring a visual redesign, including:

- scheduling;
- additional platforms;
- workflow actions;
- media management;
- job history;
- logs;
- notifications;
- diagnostics;
- plugins/integrations;
- advanced platform capabilities;
- future automation functionality.

Future features must enter the existing resource/workspace/component model instead of creating independent visual systems.
