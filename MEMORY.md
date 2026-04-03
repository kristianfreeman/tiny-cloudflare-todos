# Session Learnings

## Analytics Throughput Pitfalls (Timezone Boundaries, SQL Variable Limits, and Cross-User Tag Visibility)

- Analytics daily windows must use caller timezone (`timeZone` query) instead of hardcoded UTC to avoid off-by-one start dates in UI.
- Avoid huge SQL `IN (...)` lists for analytics task/tag aggregation; chunk list-id queries to stay under SQLite variable limits.
- Analytics owner/project breakdowns should include tags across all readable list members, not only `task_tags.user_id = auth.userId`.

- Added a web UI served at `/app` via Worker assets (`dist/client`) built by Vite.
- UI auth is separate from API bearer auth:
  - `WEB_UI_PASSWORD_HASH` gates login (`/ui/session`).
  - `WEB_UI_SESSION_SECRET` signs session cookies.
  - `WEB_UI_BEARER_TOKEN` is used by `/ui/api/*` proxy calls.
- Worker now supports full task CRUD including `DELETE /tasks/:taskId`.
- Root route now serves the web app (`/`) and `/app` redirects to `/`; static assets are under `/assets/*`.
- `favicon.ico` is handled as `204` to avoid noisy bearer-token 401s.
- UI task board is grouped primarily by `project:*` tags; `owner:*` tags are not their own groups.
- Task rows show owner icons on the left (agent/user) based on `owner:agent`/`owner:user` tags.
- Closed tasks are collapsed by default in the UI and shown in a separate bottom section.
- Prod gotcha: if `WEB_UI_BEARER_TOKEN` maps to a different user, UI can show empty tasks until that user has list membership access.
- Raycast private publish gotchas: `package.json` needs `owner: "freeman-labs"`; CI publish must pass token as `RAY_TOKEN` (not only `RAYCAST_ACCESS_TOKEN`); publish can fail with org free-plan command limits.

## New Machine Bootstrap for tiny-todo (Clone URLs Plus Two Secret Artifacts)

- Minimal setup should stay simple: clone `opencode` and `tiny-cloudflare-todos`, symlink `~/.config/opencode/bin/tiny-todo`, ensure PATH, install deps, run `tiny-todo list --status open`.
- Git repos alone are not enough; cross-machine bootstrap still requires two local secret artifacts: encrypted global secrets file (`~/.config/opencode/secrets/agents.enc.env`) and SOPS age key (`~/Library/Application Support/sops/age/keys.txt` on macOS).
- Prefer giving copy-ready command blocks for both directions: export from old machine and import on new machine.

## UI Daily Throughput Label Off-by-One (Parse `YYYY-MM-DD` as UTC for Chart Labels)

- Frontend labels for analytics daily bars must format with `timeZone: "UTC"` when converting API day keys (`YYYY-MM-DD`) to readable dates.
- Using `new Date("YYYY-MM-DDT00:00:00Z")` without forcing UTC in `toLocaleDateString` can render the previous calendar day for negative-offset local timezones (for example America/Chicago).
- Backend buckets can be correct while labels look one day behind; fix display formatting before changing analytics aggregation logic.

## CLI Project Tag Safety (Infer from Current Git Root and Require `--confirm` for Cross-Project Tags)

- Project tag inference should come directly from the current working directory's git root basename, not from broader project registry heuristics.
- When `add`/`edit --tag` includes a `project:*` value that differs from cwd-inferred project tag, reject by default and require `--confirm` for intentional cross-project writes.
- Keep `TINY_TODO_PROJECT_TAG` as explicit override, but still gate mismatched manual tag values behind `--confirm`.

## tiny-todo Wrapper CWD Passthrough and Legacy Tag Flattening Cleanup

- `bin/tiny-todo` launches CLI with `npm --prefix`, so CLI must read `TINY_TODO_CALLER_CWD` (forwarded from wrapper `$PWD`) to infer project tags from caller location instead of repo path.
- Historical tasks created before strict tag validation can carry invalid project tags (for example dots/underscores) or multiple project tags; cleanup requires bulk retagging through API patch.
- For cleanup scripts, if only tags change, include `status` in patch payload to bypass Worker `no updates provided` guard that otherwise ignores tag-only updates.

## Closed Task Count Accuracy Requires API Totals, Not Client List Length

- If UI fetches done tasks with a hard `limit`, header counts based on `closedTasks.length` cap at that limit and appear stuck (for example always 500).
- `/tasks` should return pagination metadata (`total`, `limit`, `offset`, `hasMore`) so UI can show true totals while rendering only the latest page.
- For closed-task recency views, use a completion-based sort (`completed_at_desc`) rather than default due-date sorting.

## Recurrence Freshness Guardrails (Monthly Cadence, Filter Param Drift, and Active Rule Visibility)

- Recurrence contract drifted over time: CLI `recur-list` reused task-style filters (`search`, `sort`, `list_id`) while recurrence API only supported `listId`; keep a dedicated recurrence filter path and accept both `listId`/`list_id` server-side for backward compatibility.
- Monthly recurring tasks need first-class fields (`cadence: monthly`, optional `dayOfMonth`) instead of overloading weekly/day math; month-day scheduling must clamp to shorter months instead of skipping runs.
- UI recurrence management needs `active=all` listing to support both pause and resume actions; returning only active rules makes paused rules disappear and becomes a one-way toggle.

## Secret-Scoped API Calls for tiny-todo Wrapper Sessions

- The `tiny-todo` wrapper injects `TODO_API_TOKEN` via `sec run` only for that subprocess; raw shell commands will not automatically inherit token env vars.
- For direct API calls outside CLI commands (for example manual recurrence materialization), use `sec get TODO_API_URL --scope global` plus `sec run TODO_API_TOKEN --scope global -- ...` in the same command chain.

## Recurrence Materialization Tag Safety (Prevent Untagged Generated Tasks)

- Recurrence-generated tasks can bypass create-task tag validation because they are inserted by materializer internals, so tags must be assigned explicitly during materialization.
- Defaulting recurrence-generated tasks to `owner:user` + `project:general` prevents untagged operational tasks and keeps owner/project dashboards consistent.

## Recurrence Rule Tag Templates and Completion Policy for One-at-a-Time Tasks

- Recurrence rules now carry `tags` and generated tasks inherit those tags; this prevents drift between manually created seed tasks and future generated instances.
- Rule creation should infer tags from existing same-title tasks in the same list when no tags are explicitly provided, then fall back to safe defaults.
- `generationPolicy: completion` supports one-at-a-time recurrence: materializer creates at most one open instance, and marking the current one done immediately spawns the next due occurrence.

## Recurrence Docs Drift Guard (Keep README Query/Flags Aligned With Real Endpoints)

- `recur-list` docs can drift if task list flags are copied over; keep README aligned to actual support (`--list-id`, `--json`) and avoid undocumented filter passthrough claims.
- Recurrence API docs should explicitly include `active=true|false|all` and `listId`/`list_id` compatibility to match server behavior and UI usage.

## Row-First UI Extraction Guardrail (Semantic Row Slots First, Containers Second, No Ad-Hoc Return)

- For this app's component-library direction, `Row` is the semantic unit (`lead | primary | meta | actions`), while `Container`/`Panel` are structural wrappers only.
- A refactor is incomplete if old ad-hoc layout classes remain as the primary authoring path; after introducing primitives, remove or migrate legacy section/header/grid markup so new work cannot bypass row semantics.
- Keep one intentional escape hatch for non-row visuals (for example chart bars), but represent surrounding labels, controls, and breakdown lists as rows so typography and interaction stay uniform.

## Row Coverage Audits Need Explicit Chunk Accounting (Percentage + Remaining Raw Nodes)

- For row-first migrations, always report a concrete percentage with a clear numerator/denominator (for example row-backed chunks vs non-row chunks), not a qualitative "mostly row-based" statement.
- Enumerate every remaining non-row chunk with exact file/line references so follow-up passes can be surgical and measurable.
- Treat visualization drawing nodes (chart grid/day/bar wrappers) as explicit approved exceptions; everything else should route through `Row`/derived row primitives or structural `Container` primitives.

## Typography and Row Density Constraints (Single Font Size, Weight/Color Variants Only, Button Height Lock)

- Use one global UI font size (root-only); remove all component-level font-size variations and communicate hierarchy with weight and color instead.
- Row density is a tokenized global constraint (`--grid-row-height` and related padding/control tokens), not per-component ad-hoc spacing.
- Buttons and form controls must be height-locked to row control tokens so they never expand row height; any expansion is treated as a UI violation.

## Heading Reset Requirement for Single-Size Typography (Avoid Browser Default H1/H2 Blowouts)

- Removing custom heading font-size rules is not enough for a single-size system; browser default `h1/h2` sizes must be explicitly reset to `font-size: inherit`.
- Tasks/Open/Closed headers can appear oversized and overflow row constraints if heading reset is missed, even when row tokens and shared base font size are correct.

## Row-Only Typography Semantics (No Heading Tags in Row Content)

- If UI is strictly row-based, semantic heading tags (`h1/h2`) inside row titles are a mismatch because they reintroduce non-row typography defaults and ad-hoc hierarchy behavior.
- Prefer row-native title text nodes (for example `<span className="title">`) plus weight/color tokens, and keep heading semantics out of row internals.

## Pure Row Markup Rule (No List Semantics in App Surfaces)

- For this app's row-first model, avoid list semantics (`ul`/`li`) in UI surfaces; represent lists as `RowStack` + `Row` only.
- Enforce this at the primitive level by removing `li`/`ul` from the `Container` `as` union so future code cannot reintroduce list tags accidentally.

## Flush Alignment Rule (Row Tokens Own Insets, Wrappers Stay Zero)

- If rows look "not flush," check for nested padding drift first: wrapper blocks (`tag-group`, breakdown containers) should not add extra horizontal insets on top of row padding tokens.
- Keep wrapper spacing at zero and apply horizontal/vertical rhythm at the row level (`Row`/`SectionHeader`/`GroupHeader`) to maintain a single alignment rail across sections.

## Responsive Row Slot API (Breakpoint Slot-Hiding Props Plus Default Collapse)

- `Row` now supports breakpoint slot-hiding props (`hideSlotsSm`, `hideSlotsMd`, `hideSlotsLg`) that accept arrays of slot keys (`lead`, `primary`, `meta`, `actions`).
- Row responsiveness has a sane default with `collapseAt="sm"` so multi-slot rows collapse to one column on small screens without per-component media query rules.
- Section-level row accoutrements (`SectionHeader`, `GroupHeader`) should forward the same responsive props so controls and metadata can be hidden consistently at breakpoints.
- If a responsive pass "looks unchanged," verify at the intended breakpoint widths; behavior scoped only to `sm` can appear like a no-op on desktop, so apply `md` hiding on dense rows when laptop-width impact is desired.

## Typed Row Contract (No Margin, Hard Height, Alert/Warning Inline, Secondary vs Actions XOR)

- Row contract should be encoded at the type level: rows allow either `secondaryText` or `actions[]`, never both, so right-side semantics stay deterministic.
- Row-level layout constraints are explicit: `margin: 0`, tokenized padding, and fixed/min/max height all set to the row height token with overflow clipped to protect layout integrity.
- Primary text supports inline `alertText` and `warningText` tokens directly to the right of main content; action affordances are represented as typed action objects (`icon`, optional callback/url) rendered through a shared `Button` primitive.

## Row Style Presets and Title Semantics (Style String + Header As Restriction)

- Row text styling is now preset-driven via `style` string values (`primary`, `secondary`, `muted`, `contrast`, `warning`, `alert`, `title`) that map to tokenized color/weight/italic rules.
- Semantic header tags are allowed only when `style="title"` (with `as: h1|h2|h3`), keeping heading semantics explicit while preventing ad-hoc element switching for non-title rows.
- Group/section header abstractions were removed from primitives; app surfaces now compose headers directly with `Row` so everything is row-first.

## Row Baseline Integrity Rules (Font Size Token, Border-Per-Row, and No Per-Class Padding Overrides)

- Enforce row text sizing at the row base class (`--row-font-size` + `--row-line-height`) instead of relying on inherited values from surrounding containers.
- Keep row borders on the row itself (`border-bottom` from row token) and avoid class-level border resets like `task-item { border: 0; }` that silently drop separators.
- Header rows and regular rows must share identical row padding tokens; avoid per-row-class `padding: 0` overrides (`status-row`, `metric-row`, etc.) unless the visual system explicitly changes row geometry.

## Row Text Alignment and Heading Inheritance Fix (Task Input Insets + H1/H2 UA Defaults)

- Task rows can look horizontally offset even with correct row padding if inner input/copy controls add extra inline padding; for flush alignment, remove extra left/right padding on task-row primary controls.
- Title rows using semantic `h1/h2/h3` still need explicit inheritance in row context (`font-size`, `line-height`, `font-weight`) to neutralize browser UA heading defaults while preserving semantic tags.

## V0 Hierarchy Refinement (Primary Content Gray, H2 Subtitle Treatment, and ClickableRow Nav)

- Pure white for general row content is visually confusing against title rows; keep standard content on brighter gray (`--text-gray-1`) and reserve pure white emphasis for title-style rows.
- Within title style, semantic level should drive visual role: `h1` stays bold white, while `h2` behaves like a subtitle (normal weight with underline) for clearer hierarchy without size changes.
- Left-nav actions should use a dedicated `ClickableRow` primitive (row-derived with limited style options, minimal hover, explicit active state) rather than ad-hoc nav button wrappers.

## Group Header Style for Project Rows (H3 White Italic Preset)

- Project/group label rows should use a dedicated `group-header` row style mapped to semantic `h3`, rendered as white italic text for clear hierarchy from title/subtitle rows.
- Keep this as an explicit style preset rather than overloading `title` `h3`, so group semantics remain readable in code and theme token docs.

## Subtitle Weight Regression Guard (Nested Title Class Can Override H2 Styling)

- Even when `style="title"` `h2` is configured as normal-weight subtitle, nested `.title` utility text can accidentally force bold if `.title` hardcodes strong weight.
- Keep `.title` inheriting weight/line-height so row-level semantic heading rules (`h1` strong, `h2` subtitle underline normal) remain the single source of truth.

## V0 Page Consistency Rules (Recurring Feature Gating, Analytics Overview, and Nav Hover Token)

- For unfinished surfaces, prefer explicit feature-gated rows over half-ready forms: recurring creation is hidden behind a row note (`not supported in web UI`) while active recurrence rows remain visible.
- Keep page structure consistent across views with the same heading rhythm (`h1` page title, `h2` subsection title rows) including analytics (`Overview`, `Daily throughput`, breakdown sections) and settings (`API access`).
- Nav hover can appear broken when panel and subtle panel colors match; use an explicit nav-hover token (`--nav-hover-bg`) instead of relying on shared surface colors.

## Mobile Navigation and Layout Stability (Hide Recurring Entry, Prevent Grid Stretch Gaps)

- Mobile-only hiding for unfinished pages can be done framework-consistently by applying a nav-row class and hiding that `ClickableRow` in the mobile media query, without adding state guards.
- "Random" vertical spacing on mobile can come from grid stretch behavior in high-level containers; setting `align-content: start` on base containers and using explicit mobile row templates (`grid-template-rows: auto 1fr`) prevents extra space distribution.

## SHIRO Package Extraction Pattern (Local Subpackage + Alias Wiring)

- A clean in-repo package extraction for UI primitives can ship quickly by moving components to `packages/shiro/src/`, adding `packages/shiro/package.json`, and aliasing `shiro` in both Vite and TypeScript paths.
- Keep app migration low-risk by switching imports to `from "shiro"` first, then deleting legacy local primitive files once typecheck/build pass.
- Add package source globs (`packages/shiro/**/*.ts(x)`) to root `tsconfig.json` include list so strict type checks continue covering extracted primitives.

## SHIRO Self-Contained Packaging (Exported Stylesheet + App-Only CSS Split)

- To make SHIRO truly self-contained, keep row tokens and primitive class styles in `packages/shiro/src/styles.css` and export it as `shiro/styles.css` from package exports.
- App entry should import SHIRO stylesheet explicitly (`import "shiro/styles.css"`) before app-specific styles so package defaults load first and app overrides remain intentional.
- Keep `ui/src/styles.css` app-specific only (layout/page/feature styles), and move token docs/README into `packages/shiro/` so package consumers have canonical references.

## Alert/Warning Emphasis Layer (Text + Row Background Tint)

- Rows with `alertText` or `warningText` should add subtle background tint in addition to colored inline text to improve scanability without breaking row geometry.
- Implement with explicit SHIRO tokens (`--row-alert-bg`, `--row-warning-bg`) and row state classes (`ui-row-has-alert`, `ui-row-has-warning`) so themes can tune emphasis centrally.
- App-level overrides can accidentally block tint behavior (for example `task-item { background: transparent; }`) while headers still tint; when this happens, remove competing background overrides and scope explicit no-tint rules to header rows only.

## Single-Knob Sizing Model (Derive Font/Spacing from Row Height)

- Keep Shiro scaling simple by using `--grid-row-height` as the primary sizing knob and deriving row font size, row gap, paddings, and control insets from it.
- This preserves strict geometry while avoiding multi-parameter drift; responsive tuning can override just row height and get proportional typography/spacing automatically.

## Row-Centering Integrity Requires Zero Local Alignment Exceptions

- Any local `align-items: baseline` or row-slot wrapping overrides can break vertical centering once row-height scaling is introduced.
- Keep centering in Shiro base row primitives and remove per-surface row alignment exceptions so all row variants inherit consistent centering behavior.
