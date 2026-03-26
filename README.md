# Tiny Cloudflare Todo Platform (v0)

Small REST-first todo platform on Cloudflare Workers + D1 with Drizzle ORM and a lightweight TypeScript CLI.

## What is included

- Worker API with per-token auth backed by D1 (`users` + `api_tokens`).
- Drizzle schema and D1 migration SQL for auth, lists/memberships RBAC, tasks, and recurrence rules.
- Task endpoints: create, list, update, complete.
- List endpoints: create/list lists and owner-managed memberships.
- Recurrence endpoints: create/list/update rules and materialization job endpoint.
- Idempotent POST support for task creation and recurrence materialization retries.
- Phase 2 baseline observability: request IDs, structured JSON logs, and mutation audit events.
- Daily cron trigger (`0 0 * * *`) that materializes recurring tasks.
- CLI: `add`, `list`, `done`, `recur`, `sync-agent`, `token-hash`.
- Deterministic local markdown snapshot for agent prompt ingestion.

## Quick start (local)

1. Install deps.

   ```bash
   npm install
   ```

2. Apply D1 migrations to local DB.

   ```bash
   npm run db:migrate:local
   ```

3. Start worker locally.

   ```bash
   npm run dev
   ```

4. Bootstrap a user + API token in local D1.

   ```bash
   TOKEN="change-me-for-local-dev"
   TOKEN_HASH=$(npm run -s cli -- token-hash "$TOKEN")

   npx wrangler d1 execute todos --local --command "
     INSERT OR IGNORE INTO users (id, email, display_name, active, created_at, updated_at)
     VALUES ('local-dev-user', 'local@example.test', 'Local Dev', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

     INSERT OR REPLACE INTO api_tokens (id, user_id, name, token_hash, last_used_at, revoked_at, created_at)
     VALUES ('local-dev-token', 'local-dev-user', 'local-dev', '$TOKEN_HASH', NULL, NULL, CURRENT_TIMESTAMP);
   "
   ```

5. In another shell, set API token and run CLI.

   ```bash
   export TODO_API_URL="http://127.0.0.1:8787"
   export TODO_API_TOKEN="change-me-for-local-dev"

   npm run cli -- add "Write docs" --due 2026-03-26
   npm run cli -- list --status open
   npm run cli -- recur "Daily standup note" --cadence daily --interval 1 --timezone America/New_York --skip 2026-03-27,2026-03-31
   npm run cli -- done <task-id>
   npm run cli -- sync-agent --out agent/snapshot.md
   ```

## Testing baseline

Run this local baseline before opening a PR:

```bash
npm run typecheck
npm run db:migrate:sanity
npm test
```

### Test coverage scope

- Bearer auth behavior for protected worker endpoints.
- Task CRUD lifecycle (`create`, `list`, `update`, `complete`) through worker + Drizzle + D1.
- Recurrence materialization backlog path and `nextRunDate` advancement.
- CLI `sync-agent` deterministic snapshot output shape and ordering.
- Request ID propagation and audit-event insertions for key mutation flows.

Tests use Vitest with a small local D1 harness built from Miniflare D1 bindings.

## CI expectations

GitHub Actions runs the same baseline for every push and pull request:

1. `npm run typecheck`
2. `npm run db:migrate:sanity`
3. `npm test`

`db:migrate:sanity` applies local migrations into `.wrangler/state/ci` to validate migration SQL in a clean CI context.

## API endpoints

All endpoints (except `GET /health`) require `Authorization: Bearer <token>`. The bearer token is
SHA-256 hashed and looked up in `api_tokens.token_hash`; requests run with that token's `user_id` context.

- `GET /health`
- `POST /tasks`
- `GET /tasks?status=open|done|all&limit=100&offset=0&listId=<optional-list-id>`
- `GET /tasks?status=open|done|all&limit=100&offset=0&listId=<optional-list-id>&search=&due-before=&due-after=&sort=`
- `PATCH /tasks/:taskId`
- `POST /tasks/:taskId/complete`
- `POST /lists`
- `GET /lists`
- `GET /lists/:listId/memberships`
- `PUT /lists/:listId/memberships/:userId`
- `DELETE /lists/:listId/memberships/:userId`
- `POST /recurrence-rules`
- `GET /recurrence-rules?listId=<optional-list-id>`
- `PATCH /recurrence-rules/:ruleId`
- `POST /jobs/materialize-recurrence`

### List RBAC (Phase 2)

- `list_memberships.role` controls access: `owner`, `editor`, `viewer`.
- **Owner** can add/update/delete list memberships.
- **Editor** can create/update/complete tasks and create/update recurrence rules in the list.
- **Viewer** can only read list data.
- Existing single-tenant rows are backfilled into per-user default lists (`default:<user_id>`) in
  `0004_lists_and_memberships.sql`.

### `GET /tasks` query options (Phase 2)

- `status` (optional): `open` (default), `done`, or `all`.
- `limit` (optional): defaults to `100`, clamped to `1..500`.
- `offset` (optional): defaults to `0`, clamped to `>= 0`.
- `search` (optional): case-insensitive contains match across `title` and `note`.
- `due-before` / `due-after` (optional): ISO date (`YYYY-MM-DD`) bounds against `dueDate`.
- `listId` / `list_id` (optional): exact match by task `listId`.
- `sort` (optional): `default`, `due_date_asc`, `due_date_desc`, `created_at_asc`, `created_at_desc`.

`default` sort preserves the original ordering semantics:

- `status=all`: `status ASC, dueDate ASC, createdAt ASC, id ASC`
- `status=open|done`: `dueDate ASC, createdAt ASC, id ASC`

### `GET /tasks` examples

```bash
# Search in title/note
curl -sS "$TODO_API_URL/tasks?status=all&search=rent" \
  -H "Authorization: Bearer $TODO_API_TOKEN"

# Filter by date window + list + explicit sort
curl -sS "$TODO_API_URL/tasks?status=open&due-after=2026-03-01&due-before=2026-03-31&listId=<list-id>&sort=due_date_desc&limit=50&offset=0" \
  -H "Authorization: Bearer $TODO_API_TOKEN"
```

## Idempotency keys (Phase 1)

- `POST /tasks` and `POST /jobs/materialize-recurrence` support `Idempotency-Key`.
- Key scope is `(user_id, method, path, idempotency_key)`.
- Replays with the same key and request body return the original status/body with
  `idempotency-replayed: true`.
- Reusing a key with a different request body returns `409`.
- Stored idempotency records currently use a 24-hour TTL (`expires_at`). This is safe for short retry
  windows; add cleanup (scheduled delete) if table growth becomes a concern.

### Idempotency examples

```bash
# First create call
curl -sS -X POST "$TODO_API_URL/tasks" \
  -H "Authorization: Bearer $TODO_API_TOKEN" \
  -H "Idempotency-Key: task-create-20260325-001" \
  -H "Content-Type: application/json" \
  -d '{"title":"Pay rent","dueDate":"2026-03-31"}'

# Safe retry with same key + same body -> same response, header idempotency-replayed: true
curl -i -X POST "$TODO_API_URL/tasks" \
  -H "Authorization: Bearer $TODO_API_TOKEN" \
  -H "Idempotency-Key: task-create-20260325-001" \
  -H "Content-Type: application/json" \
  -d '{"title":"Pay rent","dueDate":"2026-03-31"}'

# Materializer retries are also replay-safe
curl -sS -X POST "$TODO_API_URL/jobs/materialize-recurrence" \
  -H "Authorization: Bearer $TODO_API_TOKEN" \
  -H "Idempotency-Key: materialize-20260325" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-03-25"}'
```

## Observability and audit baseline (Phase 2)

- Every worker response includes `x-request-id`.
- If a client sends `x-request-id`, the worker propagates it; otherwise it generates a UUID.
- Structured logs are emitted as JSON with a consistent shape:
  - `ts`, `level`, `event`, `requestId`, `method`, `path`, optional `userId`, `resourceType`, `resourceId`, `status`, and `details`/`error`.
- Baseline log events cover:
  - auth failures (`auth.failure`),
  - task mutations (`task.mutated`),
  - recurrence materialization runs (`recurrence.materialization.run`),
  - unhandled worker errors (`request.error`).

### `audit_events` table

- Migration `0004_audit_events.sql` adds `audit_events`.
- Core mutation audit events are recorded with user and resource identity:
  - `task.created`, `task.updated`, `task.completed`
  - `recurrence_rule.created`, `recurrence_rule.updated`
- Audit rows include:
  - `event_type`, `actor_user_id`, `resource_type`, `resource_id`, `request_id`, optional `metadata`, `created_at`.

## Recurrence behavior

- Rules are timezone-aware (`timezone`, IANA string like `America/New_York`).
- `daily`: advances by calendar days in the configured timezone.
- `weekly`: advances by interval weeks; optional `weekdays` (0=Sun...6=Sat) constrain generation days.
- `exceptionDates` skips specific due dates (`YYYY-MM-DD`) while still advancing schedule cursor.
- Materializer catches up missed runs deterministically, bounded to 366 schedule steps per rule per run.
- Duplicate recurrence tasks are prevented by DB uniqueness on
  `(list_id, recurrence_rule_id, due_date)` when recurrence keys are present.

### Recurrence payload fields

- `timezone` (optional): IANA timezone string, defaults to `UTC`.
- `exceptionDates` (optional): array of `YYYY-MM-DD` dates to skip.
- `anchorDate` defaults to "today" in the configured timezone.

### CLI recurrence options

- `--timezone Area/City` sets recurrence timezone.
- `--skip YYYY-MM-DD[,YYYY-MM-DD...]` sets exception dates.

## Notes for deploy

- Set a real `database_id` in `wrangler.toml` for remote D1.
- Apply all checked-in migrations before deploy (`0000_initial.sql` through latest).
- Create at least one user and API token row in remote D1 before calling protected endpoints.
- For existing single-tenant DBs, migration `0001_auth_ownership.sql` backfills current rows to
  user `legacy-single-tenant`; create a token for that user to preserve access.
- Migration `0004_lists_and_memberships.sql` creates per-user default lists and membership rows,
  then backfills `tasks.list_id` and `recurrence_rules.list_id` for legacy data.
