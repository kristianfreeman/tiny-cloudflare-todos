# Tiny Todo Raycast Extension

Manage Tiny Todo tasks directly from Raycast.

## Setup

1. Open Raycast Preferences for this extension.
2. Set **API Base URL** (for example, `https://tiny-todo-api.signalnerve.workers.dev`).
3. Set **API Token** to your Tiny Todo bearer token.

The extension uses required preferences, so Raycast prompts for these values before running commands.

## Commands

- **Task Inbox**: Review open/done tasks with owner-scope and tag filters, search, and complete tasks.
- **Quick Add Task**: Create a task with optional note, due date, and tags.
- **Tasks by Tag**: Open a focused list for a specific tag like `owner:agent` or `project:docs`.

## CI Build + Publish

This repository includes a GitHub Actions workflow at `.github/workflows/raycast-extension.yml`.

- Pull requests and pushes run a Raycast distribution build (`npm run build`) for the extension.
- Every push uploads an installable GitHub artifact zip: `tiny-todo-raycast-extension-<sha>.zip`.
- Pushes to `main` also publish when `RAYCAST_ACCESS_TOKEN` is configured in repository secrets.

## Install from GitHub

1. Open the latest workflow run for `Raycast Extension` in GitHub Actions.
2. Download artifact `tiny-todo-raycast-extension-<sha>`.
3. Unzip it and use Raycast's **Import Extension** command to import the extracted `tiny-todo` folder.

The artifact contains prebuilt command JS files (`add-task.js` and `manage-tasks.js`) so you do not need a local rebuild before import.

### Required CI Secret

- `RAYCAST_ACCESS_TOKEN`: Token used by `npx @raycast/api@latest publish`.
