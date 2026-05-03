---
description: Pull tasks from a Todoist project section, update TODO.md and SPEC.md, commit, push, and mark the source tasks complete. Usage: /todoist-triage <project-name>/<section-name>  (e.g. "huset, hytta o.l./layered-light")
---

Triage Todoist tasks into the project's TODO.md and SPEC.md.

The argument is a Todoist path in the form `<project-name>/<section-name>`, e.g. `huset, hytta o.l./layered-light`. Both parts are matched case-insensitively by substring.

---

## Step 1 — Locate the section

1. Call `mcp__todoist__get_projects` to list all projects.
2. Find the project whose name contains the project-name part of `$ARGUMENTS`.
3. Call `mcp__todoist__get_sections` with that project ID.
4. Find the section whose name contains the section-name part of `$ARGUMENTS`.
5. If no match is found at any step, stop and report what was found.

## Step 2 — Fetch tasks and descriptions

1. Call `mcp__todoist__get_tasks` with the section ID to list all open tasks.
2. For each task, call `mcp__todoist__get_task` (for the description) and `mcp__todoist__get_comments` in parallel.
3. Collect: task ID, title, description, comments.

If there are no open tasks, report that and stop.

## Step 3 — Read current project docs

Read `TODO.md` and `SPEC.md` from the current working directory (or the repo root if not found here). If either file does not exist, note that — you may need to create it.

## Step 4 — Propose updates

For each task, decide:

- **TODO.md entry**: a concise implementation note — what to change, which files/functions are affected, any constraints. Skip if the task is already covered.
- **SPEC.md entry**: a behavioural specification section — inputs, outputs, edge cases, UI/UX decisions. Add this for any task that introduces new user-visible behaviour or a new API surface. Skip for pure refactors or small config changes.

Present your proposed changes to the user before writing anything. Wait for approval or revision instructions.

## Step 5 — Apply, commit, push

Once the user approves:

1. Write the agreed changes to `TODO.md` and `SPEC.md`.
2. Stage only those two files (plus any new files created).
3. Commit with a short message describing what was triaged.
4. Push.

## Step 6 — Mark tasks complete

Call `mcp__todoist__complete_task` for each task ID collected in Step 2.

Report the final count: N tasks triaged, committed, pushed, marked done.
