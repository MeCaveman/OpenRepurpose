# OpenRepurpose UI Architecture

**Applies to:** `apps/web`  
**Design specification:** `.interface-design/system.md`  
**Frontend rules:** `apps/web/AGENTS.md`

This document defines how frontend code implements the permanent OpenRepurpose design system. It separates the repository's current v0.5 structure from the target structure to be introduced incrementally during page migration.

## Current implementation

The current frontend is React 19 with Vite 8 and Tailwind CSS 4.

| Responsibility                               | Current path                                 | Current shape                                                                                                               |
| -------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Browser entry                                | `apps/web/src/main.tsx`                      | Mounts `ErrorBoundary` and `App`                                                                                            |
| Application, routing, data access, and pages | `apps/web/src/App.tsx`                       | A single application component using `window.location`, history events, direct API requests, and conditional page rendering |
| Render failure boundary                      | `apps/web/src/components/ErrorBoundary.tsx`  | Shared class error boundary composed from `ErrorState` and `Button` primitives                                              |
| Workflow editor                              | `apps/web/src/components/WorkflowEditor.tsx` | Shared workflow-specific editor and view types; consumes the primitive layer                                                |
| UI primitives                                | `apps/web/src/components/ui/`                | Accessible, token-backed, domain-neutral controls and their internal style helpers                                          |
| Layout components                            | `apps/web/src/components/layout/`            | Token-backed application shell, command bar, resource navigation, workspace, page header, and skip-link composition         |
| Domain patterns                              | `apps/web/src/components/patterns/`          | Reusable platform identity, connection, workflow-route, job-status, and resource-empty-state presentation                   |
| Setup feature presentation                   | `apps/web/src/features/setup/`               | Setup readiness page composed from shared primitives and platform identity; receives normalized status from `App.tsx`       |
| Global CSS entry                             | `apps/web/src/styles.css`                    | Imports Tailwind and token layers; applies global focus, selection, font, surface, and reduced-motion behavior              |
| Reference tokens                             | `apps/web/src/styles/tokens/reference.css`   | Raw values                                                                                                                  |
| Semantic tokens                              | `apps/web/src/styles/tokens/semantic.css`    | Dark/light meanings plus Tailwind and shadcn-compatible aliases                                                             |
| Component tokens                             | `apps/web/src/styles/tokens/components.css`  | Stable component and shell measurements                                                                                     |

The current routes are `/`, `/setup`, `/accounts`, `/sources`, `/media`, `/workflows`, `/jobs`, and `/settings`, plus the existing unknown-route fallback. Routing semantics are currently owned by `App.tsx`; this document does not change them.

The primitive, layout, and domain-pattern layers now exist. Shared navigation presentation lives in the layout layer, and `/setup` presentation is extracted to `features/setup/`. Route-level composition, global-navigation configuration/state, shared credential state, and data access remain in `App.tsx`; other routes have not yet been extracted. Future feature directories remain migration targets rather than claims about the existing repository.

## Permanent layer model

Dependency direction is one way:

```text
Pages/features
    |-- use domain patterns
    |-- compose layout components
    `-- use UI primitives

Domain patterns ----> UI primitives
Layout components --> UI primitives
UI primitives ------> tokens and framework utilities
```

Lower layers must not import pages, features, application API clients, or domain-specific workflow behavior. Unrelated feature modules must not import one another's internal implementation.

### 1. UI primitives

**Responsibility:** Accessible, domain-neutral controls such as buttons, icon buttons, fields, selects, checkboxes, badges, tables, dialogs, sheets, alerts, toasts, tooltips, skeletons, and focus/visually-hidden helpers.

**Current:** `apps/web/src/components/ui/` contains the Phase 7 primitives justified by v0.5: `Alert`, `Badge`, `Button`, `Checkbox`, `ErrorState`, `FormField`, `Input`, `Panel`, `Select`, `Spinner`, and `Textarea`. `index.ts` is the public primitive entry point. `control-styles.ts` and `utils.ts` are private implementation helpers. The primitives use native semantics, React, Tailwind CSS, and the canonical OpenRepurpose tokens; no second component or styling framework was added.

**Target:** Extend this same directory only when a migrated component demonstrates a real requirement. Stateful composite controls such as dialogs, popovers, and tabs should use an accessible shadcn-compatible headless primitive when first required, rather than introducing custom interaction machinery preemptively. Any generated or adapted component must consume the existing Tailwind aliases, which resolve to canonical OpenRepurpose tokens.

Primitive rules:

- Accept semantic variants and sizes, not raw color or arbitrary geometry props.
- Own keyboard behavior, focus treatment, disabled/loading behavior, accessible naming hooks, and other generic interaction contracts.
- Remain ignorant of platforms, jobs, workflows, and API payloads.
- Expose `className` only as a composition escape hatch; it must not permit feature code to create a parallel visual system.
- Forward refs when consumers need focus, measurement, or composition.
- Prefer native HTML semantics before introducing custom widget behavior.

### 2. Layout components

**Responsibility:** Application shell and spatial composition: command bar, resource rail, navigator, workspace, inspector, activity shelf, focus mode, pane headers, setup frame, and responsive sheets.

**Current:** `apps/web/src/components/layout/` contains `ApplicationShell`, `TopCommandBar`, `ResourceNavigation`, `Workspace`, `PageHeader`, and `SkipLink`. `ApplicationShell` exposes optional resource-rail, contextual-navigator, inspector, and activity-shelf slots without rendering unused regions. `ResourceNavigation` presents the existing routes as a 56px icon-led resource rail at workbench widths and a labeled, horizontally scrollable navigation strip at narrower widths. The inspector is closed unless explicitly opened, activity expansion is controlled by the caller, and secondary pane slots yield to the workspace below the workbench breakpoint. `App.tsx` owns the unchanged route list and history behavior while route-level page content remains in place for later migration groups.

**Target:** Continue extending `apps/web/src/components/layout/` only as later migration groups demonstrate a current need. Layout components may know route/navigation presentation and pane state, but not API payload shapes or business rules.

Layout components:

- Consume shell/component measurements from `components.css`.
- Implement compact, narrow, workbench, and wide behavior from the design system.
- Preserve children and state while panes move between inline and overlay presentation where practical.
- Do not compress navigator, workspace, or inspector below their tokenized minimum widths.
- Do not decide whether a platform action is allowed; they render the state and actions supplied by features.

### 3. OpenRepurpose/domain patterns

**Responsibility:** Reusable product-specific presentations such as account connection rows, source summaries, workflow nodes/routes, job status/progress, destination capability notices, media summaries, operational empty states, and platform identity marks.

**Current:** `apps/web/src/components/patterns/` contains the Phase 8 patterns justified by v0.5: `PlatformIdentity`, `ConnectionStatus`, `ConnectionCard`, `WorkflowStatus`, `WorkflowNode`, `WorkflowRoute`, `WorkflowCard`, `JobStatus`, and `ResourceEmptyState`. Its `index.ts` is the public pattern entry point. `platform-metadata.ts` owns the restrained platform display mapping separately from generic connection and route presentation. The existing workflow editor and limited repeated shells in `App.tsx` consume these patterns; route-level page composition remains in `App.tsx`.

**Target:** Extend the existing `apps/web/src/components/patterns/` layer for patterns reused across feature families. A pattern used only within one cohesive feature remains inside that feature rather than being promoted prematurely.

Domain-pattern rules:

- Compose UI primitives; do not recreate their interaction states.
- Accept normalized view data and event callbacks, not repositories, server services, or direct network access.
- Preserve domain distinctions such as queued versus processing, disconnected versus disabled, and upload success versus remote processing completion.
- Use semantic status and route tokens. Platform identity remains local metadata and never changes global semantic meaning.

### 4. Pages and features

**Responsibility:** Route-level composition, feature state, API translation, mutations, and orchestration of primitives, layout, and domain patterns.

**Current:** `apps/web/src/features/setup/` owns the migrated `/setup` readiness presentation and its normalized view contracts. It composes existing primitives and domain patterns and contains no request or business logic. `App.tsx` continues to own the unchanged `/api/setup` request and shared YouTube/TikTok credential state because those same values are also consumed by current account, source, workflow, and media flows. All other route-level UI, direct `fetch` calls, mutation handlers, and most frontend data types remain in `App.tsx`.

**Target:** `apps/web/src/features/<feature>/` for cohesive feature modules introduced one migrated route or responsibility at a time. A feature may contain its page component, feature-local components, normalized view types, hooks, API adapter, and tests. The application entry retains route registration and top-level composition without becoming a global feature registry with business behavior.

Features call existing APIs and application services through typed frontend boundary code. They do not reproduce business rules from `packages/core`, integrations, or server application services. Route paths, API contracts, persistence, and workflow semantics remain unchanged unless a separately scoped product change explicitly changes them.

## Current-to-target migration rule

The remaining target directories are created only when a later phase migrates a real component. Do not scaffold empty architecture. Extract along stable boundaries and keep each migration behavior-preserving.

A reasonable sequence is:

1. Establish shared primitives needed by the existing surface.
2. Extract the existing shell into layout components without changing route behavior.
3. Continue replacing repeated status, form, list/table, and feedback patterns as their owning pages migrate.
4. Move one route at a time from `App.tsx` into a feature module.
5. Move API translation and feature state with that route while keeping domain logic on the application/core side.

## Tokens and styling

The only token source is:

- `apps/web/src/styles/tokens/reference.css`
- `apps/web/src/styles/tokens/semantic.css`
- `apps/web/src/styles/tokens/components.css`

`apps/web/src/styles.css` owns import order and global defaults. Canonical token names begin with `--or-`. Tailwind v4 aliases and shadcn-compatible variables in `semantic.css` resolve to those canonical tokens and must not gain independent values.

Styling conventions:

- Use Tailwind utilities backed by the `@theme inline` aliases where an appropriate utility exists.
- Use semantic or component `var(--or-*)` values for contracts that are not represented by a Tailwind alias.
- Feature code must not use raw hex, RGB, HSL, or named colors.
- Feature code must not invent arbitrary spacing, font sizes, radii, shadows, z-index values, control heights, pane widths, or animation timings.
- Direct reference-palette use is limited to defining semantic mappings. Components consume semantic meaning.
- Keep global selectors in `styles.css` limited to true document-wide behavior. Component-specific styling stays with the component using the project's established Tailwind approach.
- Platform color is presentation metadata supplied locally by an integration-facing view model; it is not added to the global token palette.
- A theme switch, when implemented, changes `data-theme` at an application boundary. Components do not branch on dark versus light.

## Platform metadata and presentation

Platform capability and configuration data belong to typed application/integration contracts and feature boundary code. Presentation components receive normalized view models such as display name, mark/icon reference, connection state, capability messages, and allowed actions.

- Integration identifiers and capability facts are not inferred from visual branding.
- A platform presentation mapping may choose a restrained mark or local accent, but semantic application state comes from OpenRepurpose tokens.
- UI primitives never import integration modules.
- Domain patterns do not issue platform requests.
- Pages/features translate API responses into view data and call the existing API for user actions.
- Platform limitations remain visible and actionable; presentation must not imply that unsupported or unavailable behavior exists.

## Component API conventions

- Name components for role and meaning, not appearance: `JobStatus`, not `GreenPill`; `InspectorPane`, not `RightCard`.
- Prefer explicit, typed props. Boolean names describe state (`isLoading`, `isSelected`) and callback names describe events (`onRetry`, `onOpenChange`).
- Keep data props serializable and presentation-oriented where practical. Avoid passing oversized service objects or whole API responses through generic components.
- Components with async actions accept loading/disabled/error state from their owner and prevent duplicate activation.
- Controlled state is preferred when the parent must coordinate URL, selection, dialog, or workflow state. Local ephemeral state remains local.
- Preserve native event and accessibility behavior when wrapping an element. Polymorphism is allowed only when semantics remain correct.
- Variants must be finite, typed, visually specified, and backed by semantic/component tokens.

### When a variant is allowed

Add a variant when the component keeps the same semantics and interaction contract but needs a recurring, named treatment such as primary/secondary/danger or compact/default/comfortable. Every variant must be used or immediately required by more than a one-off page composition, and all applicable states must be defined.

Do not add a variant to hide a different semantic role. A selectable navigation row and a button are separate components even if their boxes look similar.

### When a new component is justified

Create a new shared component when at least one is true:

- The pattern is already repeated or is being introduced in multiple known places.
- It owns nontrivial accessibility or keyboard behavior.
- It expresses an OpenRepurpose domain concept with stable semantics.
- It protects a token, responsive, or state contract that callers should not reproduce.

Otherwise, keep the composition local until a stable abstraction is visible. Do not create wrapper components that only rename a `div` or a single utility string.

### When page-specific styling is acceptable

Page-specific styling may arrange unique content, set grid areas, or constrain a one-off composition using existing tokens. It may not introduce a new color, type scale, spacing scale, radius, shadow, density, feedback treatment, or duplicated interactive state. When a page-specific pattern becomes reusable, move it to the appropriate shared layer before copying it.

## Duplication rules

- Search current primitives, layout components, patterns, and feature components before creating anything.
- Repeated markup with the same semantics and states becomes one shared component.
- Similar-looking markup with different semantics should share primitives/tokens, not be forced into a single ambiguous component.
- Do not duplicate loading, empty, error, status, dialog, field, or table behavior per page.
- Do not create feature-local aliases for global tokens.
- Do not copy API/domain logic into components to make them self-contained.

## UI state boundaries

Use the narrowest appropriate owner:

- **Primitive-local state:** transient mechanics such as uncontrolled tooltip visibility when no parent coordination is needed.
- **Layout state:** pane visibility, focus mode, and responsive presentation. Preserve meaningful user context across layout mode changes.
- **Feature state:** fetched resources, request status, selection, filters, drafts, mutations, and recoverable errors for one cohesive feature.
- **URL/history state:** route identity and state that must be navigable or restorable. Preserve the existing v0.5 route semantics during migration.
- **Application/core state:** workflow validity, job transitions, platform capabilities, retry semantics, and persistence. These do not move into React components.

The current direct requests in `App.tsx` may be moved into typed feature-local boundary modules as features are extracted. This does not authorize a new state-management or data-fetching dependency. Introduce a major dependency only for a demonstrated need and follow the repository ADR rule.

## Responsive implementation

Responsive behavior follows design-system modes, not device-name guesses:

- **Compact, below 40rem:** one primary pane; navigator and inspector become full-screen sheets; 44px targets; tables reduce columns or become structured lists.
- **Narrow, 40rem to below 64rem:** one primary pane with overlay navigator/inspector.
- **Workbench, 64rem to below 90rem:** resource rail, navigator, and workspace may coexist; inspector is generally overlay.
- **Wide, 90rem and above:** optional inspector may coexist with rail, navigator, and workspace.

Components own their local reflow, while layout components own pane mode. Do not use JavaScript viewport checks when CSS media/container behavior can express the layout. When JavaScript must coordinate modality or focus, use one shared responsive boundary and keep it synchronized with the implemented tokens.

The document minimum width remains 320px. No critical action or state may become inaccessible at that width or at 200% zoom.

## Accessibility

`apps/web/AGENTS.md` is the permanent frontend accessibility authority. The visual contracts in `.interface-design/system.md` apply in addition.

Implementation requirements include:

- Semantic HTML and native controls first.
- Full keyboard operation, logical focus order, and visible token-based focus.
- Accessible names for icon-only controls and programmatic labels/descriptions/errors for fields.
- Correct dialog/sheet focus containment and focus return.
- Status and workflow state conveyed by text or icon/pattern as well as color.
- At least 40px desktop and 44px compact/mobile interaction targets.
- AA contrast in both semantic themes.
- Reduced-motion behavior using the existing media-query foundations.
- Announced asynchronous progress and restrained live regions.
- Responsive reflow that preserves reading order, task order, and access to errors/actions.

## Testing expectations

Use the lowest-cost useful test and cover all affected states.

- UI primitives with interaction logic receive focused component/unit tests for keyboard, focus, labeling, disabled, and loading behavior.
- Domain patterns receive tests for semantic state mapping, especially queued/processing/succeeded/failed/cancelled/disconnected cases.
- Layout changes receive viewport coverage for compact, narrow, workbench, and wide modes, plus keyboard/focus checks for overlays.
- Feature changes test API-to-view translation and user-visible success/error recovery without duplicating server business-logic tests.
- Existing browser journeys in `tests/e2e/` remain the home for a small number of critical end-to-end flows.
- Existing Vitest suites in `tests/unit/` and `tests/integration/` continue to cover shared domain, server, and reliability behavior.
- Theme-aware components are checked in dark and light mappings when introduced, even while dark remains the shipped default.
- Visual changes include loading, empty, error, long-content, narrow-screen, zoom, and reduced-motion checks as applicable.

Repository validation remains formatter, lint, TypeScript checking, relevant Vitest/Playwright tests, production build, and `git diff --check` as appropriate to the work packet.

## Future-feature extension process

1. Read the root `AGENTS.md` and `apps/web/AGENTS.md` UI rules.
2. Read `.interface-design/system.md`.
3. Inspect existing components.
4. Reuse an existing component where possible.
5. Extend a reusable component if required.
6. Create a new shared pattern only for genuinely new requirements.
7. Update `.interface-design/system.md` when visual vocabulary changes.
8. Update `docs/UI_ARCHITECTURE.md` when technical UI architecture changes.
9. Then implement the feature.
10. Test all affected states.

## Open architecture decisions

These decisions are intentionally unresolved because v0.5 does not yet require or implement them:

- Whether pathname/history routing should remain custom or move to a routing library during modularization.
- Whether future frontend scale justifies a shared data-fetching/cache library; no such dependency exists today.
- Which accessible shadcn-compatible headless dependency to use when the first stateful composite primitive such as a dialog or popover is required; native controls cover the current Phase 7 set.
- The repository asset mechanism and licensing record for self-hosted Fira Sans and Fira Mono binaries.
- Whether a future graphical workflow canvas needs a dedicated library; the current editor does not establish that requirement.

Resolve each only in the work packet that demonstrates the need. Do not preemptively add infrastructure.
