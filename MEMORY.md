# Session Learnings

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
