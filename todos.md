# Tiny Cloudflare Todo Platform Roadmap

## Phase 1 - v0 Safety and Correctness

- [ ] Auth v1: replace single shared token with per-user API tokens + token table
- [ ] Ownership: add `user_id` to tasks and recurrence rules; scope all queries by authenticated user
- [ ] Idempotency: support `Idempotency-Key` on task create and materialization endpoint
- [ ] Recurrence correctness: timezone-aware scheduling with DST-safe next-run calculation
- [ ] Duplicate prevention: enforce unique generation key such as `(recurrence_rule_id, due_date)`
- [ ] Input hardening: request body size limits, stricter validation, standardized error schema

## Phase 2 - Daily Usefulness

- [ ] Task model upgrades: priority, tags, archived flag, soft delete (`deleted_at`)
- [ ] List model: add `lists` table and task-to-list relationship
- [ ] Query UX: search, filter, sort, pagination in API and CLI
- [ ] CLI polish: stable table output plus `--json`, `--limit`, `--list`, and `--tag`
- [ ] Recurrence exceptions: skip dates and override dates
- [ ] Agent snapshot v2: schema version header, deterministic sections, stable ordering

## Phase 3 - Team Readiness

- [ ] RBAC: list membership roles (`owner`, `editor`, `viewer`)
- [ ] Sharing: invite flow and scoped list access
- [ ] Audit log: mutation events (for example `task.created`, `task.completed`)
- [ ] Concurrency control: row `version` and optimistic update checks
- [ ] Rate limiting: per-token throttling and abuse guardrails
- [ ] Token lifecycle: rotation, expiry, and revocation

## Phase 4 - Reliability and Operations

- [ ] Observability baseline: structured logs, request IDs, cron run summaries
- [ ] Metrics: created/completed/materialized counters and error rates
- [ ] Alerting: cron failures, materialization anomalies, auth spikes
- [ ] Backups: scheduled D1 exports and restore runbook
- [ ] Migration safety: forward-only migrations with preflight checks
- [ ] Disaster notes: concise recovery doc

## Phase 5 - Quality Gates

- [ ] Integration tests: auth, CRUD, recurrence materialization, cron path
- [ ] Contract tests: API response shape stability
- [ ] CLI tests: deterministic snapshot output tests
- [ ] CI pipeline: typecheck, tests, migration validation on PRs
- [ ] Smoke script: one-command local Worker + CLI verification
- [ ] Release checklist: env vars, migrations, rollback steps

## Suggested execution order

1. Phase 1
2. Integration tests and CI basics
3. Phase 2
4. Phase 4
5. Phase 3
