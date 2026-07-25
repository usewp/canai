---
name: canai-yolo
description: >
  Opt-in WPCanAI MCP power tools that can run or publish site PHP: FluentSnippets
  (create/update/publish PHP/CSS/JS snippets) and wpcanai-eval (sandboxed PHP with
  DB rollback). Not for routine template/page/content work — use canai-mcp for that.
  Triggers on: "/canai-yolo", "canai-yolo", "fluentsnippets", "fluent snippets",
  "easy-code-manager", "code snippet", "php snippet", "wpcanai-eval", "wpcanai eval",
  "eval php", "publish snippet", "create snippet".
metadata:
  author: canai
  version: "1.0.0"
allowed-tools: "Read Grep Glob"
---

# CanAI YOLO — code / eval MCP tools

**High risk. Opt-in.** This skill documents MCP tools that can **execute or permanently publish PHP** on the WordPress site. Install and invoke it only when the user explicitly wants snippet or eval work.

For templates, pages, i18n, media, settings, and Tailwind — use **`canai-mcp`** instead. Do not blend YOLO workflows into a normal `/canai-mcp` content session unless the user asked for this skill.

Transport is the same WPCanAI MCP server (`{site}/wp-json/mcp/wpcanai`) and API key as `canai-mcp`. Ability IDs use slashes; MCP tool names use **hyphens**.

---

## CRITICAL — when to use this skill

Use **`canai-yolo`** only for:

1. **FluentSnippets** (`easy-code-manager`) — list/read/create/update/publish site PHP, CSS, or JS snippets via dedicated MCP tools.
2. **`wpcanai-eval`** — temporary PHP inspection in a DB-rolled-back sandbox (filesystem/network side effects still persist).

Do **not** use eval to create FluentSnippets (eval rolls back DB writes but not filesystem writes — you would leave a `.php` file with no index entry). Use the snippet tools below.

---

## FluentSnippets (PHP/CSS/JS snippets)

Site-specific PHP, CSS and JS often lives in **FluentSnippets** rather than plugin code. Tools: `wpcanai-list-snippets`, `wpcanai-get-snippet`, `wpcanai-create-snippet`, `wpcanai-update-snippet`, `wpcanai-set-snippet-status`.

Key rules the schemas alone don't make obvious:

1. **Tools only appear when FluentSnippets is active.** If `easy-code-manager` is inactive the five snippet tools are not registered at all — you won't see them in the tool list.
2. **No leading `<?php` in PHP `code`.** FluentSnippets rejects a PHP snippet whose body starts with `<?php` (`invalid_code`, "Please remove <?php from the beginning of the code"). Write the function/hook body directly, no opening tag. This is passed through, not auto-corrected.
3. **Create always yields a draft.** `wpcanai-create-snippet` never publishes (unless the site's own FluentSnippets `auto_publish` is on). Publish as a **separate** step: `wpcanai-set-snippet-status { "file_name": "…", "status": "published" }`.
4. **Writes only succeed for allowlisted groups.** An administrator lists agent-writable snippet groups at **WPCanAI → AI Agent → Guardrails → FluentSnippets group allowlist**. An empty allowlist (the default) means **all** snippet writes are refused (`snippet_writes_disabled`). A write to a non-allowlisted group returns `snippet_group_not_allowed`. Prefer the group `AI` unless the user specifies otherwise. Reads (`list`/`get`) are always allowed regardless of the allowlist.
5. **Updates are sparse.** Send only the fields you want to change to `wpcanai-update-snippet`; the server reads the current snippet, merges your changes over its full metadata, and writes it back. Omitting a field keeps its current value — you cannot wipe `group`/`priority`/`run_at`/`created_at` by sending only `code`.
6. **`run_at` is type-specific.** PHP → `all`|`backend`|`frontend`; `php_content` → `shortcode`|`wp_head`|`wp_body_open`|`wp_footer`|`before_content`|`after_content`; css → `wp_head`|`admin_head`|`everywhere`; js → `wp_head`|`wp_footer`|`admin_head`|`admin_footer`. An invalid pairing is rejected before FluentSnippets is called (`invalid_snippet_type` / `invalid_run_at`).
7. **Upstream quirks (not fixed here).** CSS `everywhere` does not actually load in admin (a plugin typo, `everywehere`), and PHP `frontend` is not enforced (it runs everywhere) — both values are still accepted because they are what the FluentSnippets UI offers. Prefer `all` / `backend` / `wp_head` when unsure.
8. **Reactivation.** If a snippet fatally errored, FluentSnippets auto-disables it and `has_error` is true. An update to it is refused (`snippet_has_error`) unless you pass `"reactivate": true`, which clears the error and applies the update — so a routine edit can't silently re-arm known-broken code.

Moving a snippet to a different group (via `wpcanai-update-snippet`'s `group`) requires **both** the current group and the destination group to be allowlisted.

### `wpcanai-list-snippets`

- **Args:** `{ "status"?: string, "type"?: string, "group"?: string }` — all optional filters (`status`: `published`|`draft`; `type`: `PHP`|`php_content`|`css`|`js`; `group`: group name). Only appears when FluentSnippets is active.
- **Returns:** `{ "snippets": [{ "file_name", "name", "type", "status", "run_at", "priority", "group", "tags", "description", "created_at", "updated_at", "has_error", "error_message", "writable" }], "groups": string[], "writable_groups": string[] }` — `writable` is per-snippet (its group is on the allowlist); `writable_groups` is the current allowlist so you know what you may touch before attempting a write. Reads are unrestricted.

### `wpcanai-get-snippet`

- **Args:** `{ "file_name": string }` — the snippet's file name (its identifier, e.g. `3-my-snippet.php`).
- **Returns:** full metadata + the `code` body + error state + `writable` (same fields as a `list-snippets` row plus `code` and `condition`). Error `snippet_not_found` for an unknown file.

### `wpcanai-create-snippet`

- **Args:** `{ "name": string, "type": string, "run_at": string, "group": string, "code": string, "description"?: string, "tags"?: string, "priority"?: int }` — all of `name`/`type`/`run_at`/`group`/`code` required. **PHP `code` must NOT start with `<?php`.** `type`/`run_at` are validated against the type table. `group` must be on the writable allowlist.
- **Returns:** `{ "success": true, "file_name": string, "status": "draft", "group": string, "note": string }` — the file name is auto-generated (you can't choose it) and is what every later call keys on. **Always a draft** — publish with `wpcanai-set-snippet-status`.

### `wpcanai-update-snippet`

- **Args:** `{ "file_name": string, "code"?: string, "name"?: string, "description"?: string, "tags"?: string, "group"?: string, "run_at"?: string, "priority"?: int, "reactivate"?: bool }` — `file_name` required; send only fields to change (**sparse** — the server merges over current metadata). The current group (and destination `group`, if moving) must be allowlisted. An errored snippet needs `reactivate: true`.
- **Returns:** `{ "success": true, "file_name": string, "changed_fields": string[] }`.

### `wpcanai-set-snippet-status`

- **Args:** `{ "file_name": string, "status": "published"|"draft" }` — the snippet's group must be allowlisted.
- **Returns:** `{ "success": true, "file_name": string, "status": string }`. Fires both FluentSnippets lifecycle actions so the index cache rebuilds and a published snippet actually runs.

---

## `wpcanai-eval` (sandboxed PHP)

- **Args:** `{ "code": string }` — PHP to evaluate (no `<?php` tag). Full WordPress environment is available.
- **Returns:** `{ "output": string, "return": mixed, "error": string|null }` — `output` is captured `echo`/`print`; `return` is the eval return value (objects are summarized for JSON); `error` is an exception message or `null`.
- **Note:** A DB transaction wraps execution and is **always rolled back**, so SQL writes do not persist. This is for inspection and experiments only — use dedicated abilities (`wpcanai-write-meta`, `wpcanai-update-settings`, `wpcanai-update-options`, snippet tools, etc.) for real changes.
- **Disabled by default.** `wpcanai-eval` returns a generic "access denied" unless `define('WPCANAI_ENABLE_EVAL', true)` is set in `wp-config.php`. It is an escape hatch, not a routine tool — every user-facing capability has a dedicated ability (e.g. read source content with `wpcanai-i18n-get-content`, not eval).
- **Side effects that are NOT rolled back:** filesystem writes, network, `exec`, mail. Never use eval to create FluentSnippets files.

---

## Action router (quick)

| Goal | Tools |
|---|---|
| List / read FluentSnippets snippets | `wpcanai-list-snippets` / `wpcanai-get-snippet` |
| Create / update a snippet (draft) | `wpcanai-create-snippet` / `wpcanai-update-snippet` |
| Publish / unpublish a snippet | `wpcanai-set-snippet-status` |
| Evaluate PHP (DB rolled back; FS side effects persist) | `wpcanai-eval` |

---

## Install

```bash
npx skills add usewp/canai --skill canai-yolo
```

Pair with `canai-mcp` for content work on the same MCP endpoint.
