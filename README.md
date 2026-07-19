# CanAI — Agent Skills for WPCanAI

Agent Skills for building and migrating WordPress sites with
[WPCanAI](https://wpcanai.web.app) — semantic HTML + Tailwind + Alpine + Lucide,
authored as Twig templates and pushed over MCP or WP-CLI.

Follows the [Agent Skills specification](https://agentskills.io/specification):
each skill is a folder with a `SKILL.md` at its root.

## Install

```bash
npx skills add usewp/canai
```

That lists the four skills and prompts you to pick which ones to install. To take
all four without the prompt:

```bash
npx skills add usewp/canai --skill '*'
```

To install just one:

```bash
npx skills add usewp/canai --skill canai-localwp
npx skills add usewp/canai --skill canai-mcp
npx skills add usewp/canai --skill canai-prepare
npx skills add usewp/canai --skill canai-replicate
```

Add `-g` to install globally instead of into the current project, and
`-a claude-code` (or another agent id) to target one agent. Works with Claude
Code, Cursor, Codex, Gemini CLI, GitHub Copilot, Windsurf, Antigravity and
others — see the [skills CLI](https://github.com/vercel-labs/skills).

To remove:

```bash
npx skills remove canai-localwp
```

## Skills

| Skill | Use case |
|---|---|
| `canai-localwp` | Drive a **local** WordPress over WP-CLI (`.env.wplocal`): create/edit templates and pages, apply WooCommerce templates, run diagnostics. |
| `canai-mcp` | Drive **any** WordPress site over the WPCanAI MCP server (API key + endpoint): templates, pages, settings, media sideload, translations, Tailwind builds. |
| `canai-prepare` | Produce **single self-contained HTML files** per page (semantic HTML5, Tailwind utilities, vanilla JS/Alpine, Lucide) for later WPCanAI import. Not tied to a WordPress install. |
| `canai-replicate` | **Replicate a whole live site** into `canai-prepare` format: discover → classify → capture → `DESIGN.md` → transform to Twig templates + pages → verify by visual diff. Hands off to `canai-mcp` / `canai-localwp` to push. |

## Companion skills

`canai-replicate` shells out to the
[`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI for page
capture and verification:

```bash
npx skills add vercel-labs/agent-browser --skill agent-browser
```

## After install

**Local site (WP-CLI):** run `/canai-localwp init wplocal` in your agent. You'll
be asked for your WP Local SSH entry script path (WP Local app → right-click the
site → "Open Site Shell").

**Remote site (MCP):** in WP Admin go to **WPCanAI → AI Agent → Connections**,
generate an API key, and copy the ready-made MCP client JSON shown there (the
key rides in the endpoint URL). Then ask your agent to list your WPCanAI templates (`wpcanai-list-templates`) to
confirm the connection works.

## License

GPL-2.0-or-later, matching the WPCanAI plugin.
