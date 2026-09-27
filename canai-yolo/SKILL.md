---
name: canai-yolo
description: >
  Opt-in CanAI MCP power tool that can publish site PHP: FluentSnippets
  (create/update/publish PHP/CSS/JS snippets). Where CanAI sends custom functionality
  it does not do itself: custom post types, taxonomies, custom fields, hooks, shortcodes
  with logic, redirects, REST routes. Not for routine template/page/content work — use
  canai-mcp for that.
  Triggers on: "/canai-yolo", "canai-yolo", "fluentsnippets", "fluent snippets",
  "easy-code-manager", "code snippet", "php snippet", "publish snippet",
  "create snippet", "custom post type", "cpt", "register post type", "taxonomy",
  "custom field", "meta box", "functions.php", "mu-plugin", "custom code", "hook",
  "shortcode".
metadata:
  author: canai
  version: "2.4.0"
  declaration_key: "2278f2bf"
allowed-tools: "Read Grep Glob"
---

# CanAI YOLO — FluentSnippets MCP tools

**High risk. Opt-in.** This skill documents MCP tools that can **permanently publish PHP** on the WordPress site. Install and invoke it when the user explicitly wants snippet work, or when `canai-mcp` routes custom functionality here (see **When to use**).

For templates, pages, i18n, media, settings, and Tailwind — use **`canai-mcp`** instead. Do not blend YOLO workflows into a normal `/canai-mcp` content session unless the user asked for this skill.

Transport is the same CanAI MCP server (`{site}/wp-json/mcp/wpcanai`) and API key as `canai-mcp`. Ability IDs use slashes; MCP tool names use **hyphens**.

## Start of session — declare this skill (plugin v1.84.0)

When this skill is attached, add yourself to `canai-mcp`'s **Start of session** call:

```json
wpcanai-hello { "skills": { "canai-mcp": "<its metadata.version>+k<its declaration_key>", "canai-yolo": "2.4.0+k2278f2bf" } }
```

**Copy both entries exactly** — `canai-mcp`'s from its own Start of session line, this one as written. The part after `+` is the skill's declaration key; without it the declaration opens nothing. Never invent or reuse a key.

If the session already started, call `wpcanai-hello` again with both — it adds, never replaces. The site gates every snippet tool behind this skill (see **Skill gate** in `canai-mcp`): the server side of this skill's opt-in promise. A `skill_required` error naming `canai-yolo` means that call was missing: make it, then retry. If `hello` lists `canai-yolo` under `outdated` or `keyless`, stop and give the user the `update` command. A snippet tool the owner switched off still answers `tool_disabled`; declaring the skill does not turn it on.

---

## CRITICAL — when to use this skill

Use **`canai-yolo`** only for:

1. **FluentSnippets** (`easy-code-manager`) — list/read/create/update/publish site PHP, CSS, or JS snippets via dedicated MCP tools.
2. **Custom functionality `canai-mcp` routes here** — anything that needs PHP running on the site: registering custom post types and taxonomies, custom fields / meta boxes, shortcodes with logic, hooks and filters, redirects, cron, REST routes, form handling, integrations. CanAI itself stays design and content (templates, pages, entries, styling); see **Scope** in `canai-mcp`.

**It publishes live PHP, so the user decides.** Create every snippet as a **draft** first, show the user the code and what it does, and publish (`wpcanai-set-snippet-status`, or `status: "published"` on a later update) only after they agree. Never tell the user to put the code in `functions.php`, a theme or plugin file, `wp-config.php`, or a file under `wp-content/` (`mu-plugins`, `plugins`) — FluentSnippets is where it lives.

**Group:** write to **`CanAI custom`**. If that group is not allowlisted, use another allowlisted group from `wpcanai-list-snippets` (`writable: true`), or ask the owner to add `CanAI custom` under **AI Client → Guardrails → FluentSnippets group allowlist** — you cannot set the allowlist yourself.

> **There is no eval escape hatch.** The `wpcanai/eval` ability was **removed in plugin v1.59.0** — WP.org bans `eval()` outright — and `WPCANAI_ENABLE_EVAL` is no longer read. Every capability is a real ability; there is nothing to fall back on. If a workflow seems to need eval, the fix is to request the missing ability, not to improvise. An opt-in add-on plugin is planned (`specs/2026-08-20-canai-eval-addon-design.md`).

---

## FluentSnippets (PHP/CSS/JS snippets)

Site-specific PHP, CSS and JS often lives in **FluentSnippets** rather than plugin code. Tools: `wpcanai-list-snippets`, `wpcanai-get-snippet`, `wpcanai-create-snippet`, `wpcanai-update-snippet`, `wpcanai-replace-in-snippet`, `wpcanai-set-snippet-status`. Their descriptions start with `[fluent-snippets]` / `[fluent-snippets, filesystem]` (plus `cache` when the site purges its page cache after writes) — see **Tool labels** in `canai-mcp`.

Key rules the schemas alone don't make obvious:

1. **Tools only appear when FluentSnippets is active.** If `easy-code-manager` is inactive the six snippet tools are not registered at all — you won't see them in the tool list.
2. **Canonical form (plugin v1.80.0).** Send PHP as the body **without `<?php`** — a leading `<?php` and blank lines are **stripped** on write (no longer rejected) and on read. Trailing newlines are kept; a trailing `?>` is removed. `sha256` / `bytes` / `lines` are computed over the code **exactly as `get-snippet` returns it**, so hash that string, not your local file, when comparing. css/js must not be wrapped in their own `<style>` / `<script>` tag. PHP is syntax-checked and test-run once before it is saved: it must not redeclare a function or class that already exists (guard with `function_exists` / `class_exists`), print output, `return` at the top level, or call something that only loads later (use a hook).
3. **Create defaults to a draft.** `wpcanai-create-snippet` writes a draft unless you pass **`status: "published"`** (v1.80.0), which syntax-checks PHP first and writes nothing on a syntax error. The response `status` is read back — Fluent Snippets' own `auto_publish` can still promote a draft.
4. **Writes only succeed for allowlisted groups.** An administrator lists agent-writable snippet groups at **CanAI → AI Agent → Guardrails → FluentSnippets group allowlist**. An empty allowlist (the default) means **all** snippet writes are refused (`snippet_writes_disabled`). A write to a non-allowlisted group returns `snippet_group_not_allowed`. Write to the group `CanAI custom` (see **Group** below) unless the user specifies otherwise. Reads (`list`/`get`) are always allowed regardless of the allowlist.
5. **Updates are sparse.** Send only the fields you want to change to `wpcanai-update-snippet`; the server reads the current snippet, merges your changes over its full metadata, and writes it back. Omitting a field keeps its current value — you cannot wipe `group`/`priority`/`run_at`/`created_at` by sending only `code`.
6. **`run_at` is type-specific.** PHP → `all`|`backend`|`frontend`; `php_content` → `shortcode`|`wp_head`|`wp_body_open`|`wp_footer`|`before_content`|`after_content`; css → `wp_head`|`admin_head`|`everywhere`; js → `wp_head`|`wp_footer`|`admin_head`|`admin_footer`. An invalid pairing is rejected before FluentSnippets is called (`invalid_snippet_type` / `invalid_run_at`).
7. **Upstream quirks (not fixed here).** CSS `everywhere` does not actually load in admin (a plugin typo, `everywehere`), and PHP `frontend` is not enforced (it runs everywhere) — both values are still accepted because they are what the FluentSnippets UI offers. Prefer `all` / `backend` / `wp_head` when unsure.
8. **Reactivation.** If a snippet fatally errored, FluentSnippets auto-disables it and `has_error` is true. An update to it is refused (`snippet_has_error`) unless you pass `"reactivate": true`, which clears the error and applies the update — so a routine edit can't silently re-arm known-broken code.

9. **Errors explain themselves (v1.80.0).** A save Fluent Snippets refuses comes back as `"{title} on line {line}: {reason} Fix: {fix}"` in the error message — read the reason and the fix before retrying; don't resend the same code.

Moving a snippet to a different group (via `wpcanai-update-snippet`'s `group`) requires **both** the current group and the destination group to be allowlisted.

### Deploy loop (plugin v1.80.0)

Edit a live snippet without resending it and confirm it without a browser:

1. **Replace** — `wpcanai-replace-in-snippet { "file_name", "replacements": [...], "require_all": true, "expected_sha256"?: "<sha256 from your last read>" }`. `require_all` makes a miss write nothing and name the nearest match; `expected_sha256` refuses the write with `hash_mismatch` (409) if someone changed the snippet since you read it. Use `dry_run: true` first when unsure of the anchors. Whole-body rewrites still go through `wpcanai-update-snippet` (same `expected_sha256`).
2. **Check** — the response carries `sha256`, `bytes` and `lines` of the code **as stored**, read back after the write. Compare `sha256` with the hash of the code you expect (over the canonical form above). Later, or from another session, `wpcanai-get-snippet { "file_name", "fields": ["hash"] }` returns the same fields without the code.
3. **Cache** — the response's `purged` says whether a page-cache purge is pending: `{ "scope": "all", "plugin": "…" }` means the whole site is purged at the end of the request (a snippet runs on every page); `null` means nothing was queued. Call `wpcanai-purge-cache` (in `canai-mcp`) **only** when `purged` is `null` while a cache plugin is active (purge after writes is off), or for a URL outside the write.

### Writing custom REST routes in a snippet

Agents often implement browser → WordPress relays as a FluentSnippets PHP route plus `_canai_js` `fetch`. Two rules the schemas alone don't make obvious:

1. **Never send a custom nonce under `X-WP-Nonce` (or request param `_wpnonce`).** WordPress core's `rest_cookie_check_errors()` intercepts that exact header/param on **every** REST request site-wide and validates it against the built-in `'wp_rest'` action — **before** your route's `permission_callback` runs. A custom-action nonce under that name is always rejected with `rest_cookie_invalid_nonce`, masking your own permission logic. Use any other header name for a custom nonce action (e.g. `X-<Your-App>-Nonce`).

2. **Surface HTTP status / error code to the client** (console log or distinct on-page states) even when user-facing copy stays generic. A rate-limit `429`, a nonce `403`, and a real `500` are different failures; collapsing them into one message makes production incidents impossible to triage.

### Recipe — custom post type or taxonomy

One PHP snippet per post type, its taxonomies included. Name it `CPT: <Label>`, group `CanAI custom`, `run_at: "all"`, created as a draft.

1. **Check first.** `wpcanai-list-snippets` — if a `CPT: <Label>` snippet already exists, update it instead of adding a second one. Do not re-register a type a preset already ships (e.g. `service` from `cpt-corporate`).
2. **Register on `init`, never at file load.** Send the body without `<?php`:

   ```php
   add_action( 'init', function () {
       register_post_type( 'doctor', array(
           'label'        => 'Doctors',
           'labels'       => array( 'name' => 'Doctors', 'singular_name' => 'Doctor' ),
           'public'       => true,
           'has_archive'  => true,
           'rewrite'      => array( 'slug' => 'doctors' ),
           'supports'     => array( 'title', 'editor', 'thumbnail', 'excerpt' ),
           'show_in_rest' => true, // needed for block-editor entries via wpcanai-write-post
       ) );
       register_taxonomy( 'specialty', 'doctor', array(
           'label'        => 'Specialties',
           'public'       => true,
           'hierarchical' => true,
           'show_in_rest' => true,
       ) );
   } );
   ```

   Keep `show_in_rest: true` and `editor` in `supports` whenever the user wants block-editor entries — `wpcanai-write-post` refuses a type without them. Add no rewrite-flush code.
3. **Draft → show → publish.** Show the user the code, publish only after they agree.
4. **Permalinks.** After publishing, tell the user to open **Settings → Permalinks** and click **Save Changes** once (no change needed), so the type's archive and entry URLs resolve instead of returning 404.
5. **Hand back to `canai-mcp`** for the design — `single-<type>` / `archive-<type>` templates — and the entries (`wpcanai-write-post` or `wpcanai-create-page` with `post_type`; see **Entries of a custom post type** in `canai-mcp`).

### Other common recipes (one line each)

- **Custom field / meta box** — one PHP snippet: `add_action( 'add_meta_boxes', … )` to add the box, `add_action( 'save_post_<type>', … )` to save with a nonce check and `current_user_can`, `register_post_meta( '<type>', '<key>', array( 'show_in_rest' => true, 'single' => true, 'type' => 'string' ) )` so Twig and the REST API can read it.
- **Shortcode with logic** — one PHP snippet with `add_shortcode( '<tag>', function ( $atts ) { … return $html; } )`; return, never echo. Pure display (no logic) belongs in the CanAI page instead.
- **Redirect** — one PHP snippet on `template_redirect`: match the path, `wp_safe_redirect( $target, 301 ); exit;`.
- **REST route** — see **Writing custom REST routes in a snippet** above.

### `wpcanai-list-snippets`

- **Args:** `{ "status"?: string, "type"?: string, "group"?: string, "include_hash"?: bool }` — all optional filters (`status`: `published`|`draft`; `type`: `PHP`|`php_content`|`css`|`js`; `group`: group name). **(v1.80.0)** `include_hash: true` adds `sha256`, `bytes`, `lines` per snippet (reads every file, so opt-in). Only appears when FluentSnippets is active.
- **Returns:** `{ "snippets": [{ "file_name", "name", "type", "status", "run_at", "priority", "group", "tags", "description", "created_at", "updated_at", "has_error", "error_message", "writable" }], "groups": string[], "writable_groups": string[] }` — `writable` is per-snippet (its group is on the allowlist); `writable_groups` is the current allowlist so you know what you may touch before attempting a write. Reads are unrestricted.

### `wpcanai-get-snippet`

- **Args:** `{ "file_name": string, "fields"?: ["meta"|"code"|"hash"] }` — the snippet's file name (its identifier, e.g. `3-my-snippet.php`); `fields` defaults to all three.
- **Returns:** full metadata + the `code` body + error state + `writable` (same fields as a `list-snippets` row plus `code` and `condition`) + **(v1.80.0)** `sha256`, `bytes`, `lines`. `fields: ["hash"]` returns only `file_name`, `status`, `group`, `updated_at`, `sha256`, `bytes`, `lines` — use it to confirm a write without pulling the code. Error `snippet_not_found` for an unknown file.

### `wpcanai-create-snippet`

- **Args:** `{ "name": string, "type": string, "run_at": string, "group": string, "code": string, "description"?: string, "tags"?: string, "priority"?: int, "status"?: "draft"|"published" }` — all of `name`/`type`/`run_at`/`group`/`code` required. PHP `code` goes without `<?php` (a leading one is stripped). `type`/`run_at` are validated against the type table. `group` must be on the writable allowlist. `status` defaults to `draft`; `published` lints PHP first.
- **Returns:** `{ "success": true, "file_name": string, "status": string, "group": string, "note": string, "sha256", "bytes", "lines", "purged" }` — the file name is auto-generated (you can't choose it) and is what every later call keys on. `status` is read back; a draft goes live later with `wpcanai-set-snippet-status`.

### `wpcanai-update-snippet`

- **Args:** `{ "file_name": string, "code"?: string, "name"?: string, "description"?: string, "tags"?: string, "group"?: string, "run_at"?: string, "priority"?: int, "reactivate"?: bool, "expected_sha256"?: string }` — `file_name` required; send only fields to change (**sparse** — the server merges over current metadata). The current group (and destination `group`, if moving) must be allowlisted. An errored snippet needs `reactivate: true`. **(v1.80.0)** `expected_sha256` refuses a stale write with `hash_mismatch` (409, both hashes in the message, nothing written).
- **Returns:** `{ "success": true, "file_name": string, "changed_fields": string[], "sha256", "bytes", "lines", "purged" }` — hash fields read back after the write.
- **Published PHP code updates:** Updating `code` on a **published** PHP snippet used to fatal with `Cannot redeclare function` (FluentSnippets validates in the same request where the live snippet is already loaded). CanAI handles this transparently. If an older plugin build still returns that error, unpublish → update → republish via `wpcanai-set-snippet-status`.

### `wpcanai-replace-in-snippet` (plugin v1.80.0)

- **Args:** `{ "file_name": string, "replacements": [{ "from": string, "to": string }], "require_all"?: bool, "ignore_whitespace"?: bool, "regex"?: bool, "scope"?: { "text": string, "occurrence"?: int }, "dry_run"?: bool, "expected_sha256"?: string }` — the `wpcanai-replace-in-meta` contract (see `canai-mcp`) applied to a snippet's code: same `require_all` miss diagnostics in the `replace_no_match` message, same `ignore_whitespace` / `regex` / `scope` / `dry_run`. The write goes through `update-snippet` (published PHP is linted first) and the same group allowlist.
- **Returns:** `{ "success", "file_name", "total", "dry_run", "replacements": [{ "from", "to", "count", "suggestion"? }], "sha256", "bytes", "lines", "purged"? }` — on `dry_run` the hash is of the current code and there is no `purged`.

### `wpcanai-set-snippet-status`

- **Args:** `{ "file_name": string, "status": "published"|"draft" }` — the snippet's group must be allowlisted.
- **Returns:** `{ "success": true, "file_name": string, "status": string, "sha256", "bytes", "lines", "purged" }`. Fires both FluentSnippets lifecycle actions so the index cache rebuilds and a published snippet actually runs.

---

## Action router (quick)

| Goal | Tools |
|---|---|
| List / read FluentSnippets snippets | `wpcanai-list-snippets` / `wpcanai-get-snippet` |
| Create / update a snippet | `wpcanai-create-snippet` (`status` optional) / `wpcanai-update-snippet` |
| Edit part of a snippet (deploy loop) | `wpcanai-replace-in-snippet` → check `sha256` → `purged` |
| Confirm what is stored, no code | `wpcanai-get-snippet` `{ "fields": ["hash"] }` / `wpcanai-list-snippets` `{ "include_hash": true }` |
| Publish / unpublish a snippet | `wpcanai-set-snippet-status` |
| Register a custom post type / taxonomy | **Recipe — custom post type or taxonomy** (draft → show → publish → permalinks → hand back to `canai-mcp`) |

---

## Install

```bash
npx skills add usewp/canai --skill canai-yolo
```

Or, without a terminal, send this line as a message in your AI chat: `npx -y skills add usewp/canai --skill canai-yolo -p -y`.

Pair with `canai-mcp` for content work on the same MCP endpoint.
