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
