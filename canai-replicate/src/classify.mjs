// Classify discovered URLs into page types. Mechanical clustering (URL prefix
// + DOM fingerprint), then a .classify/PROMPT.md bundle for the agent to
// review: rename types, correct `kind`, prune junk URLs. The reviewed
// pagetypes.json drives capture (samples only) and transform (per type).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  groupByUrlPattern,
  pickSamples,
  nameFromPattern,
  guessKind,
  fingerprintHtml,
} from "./cluster.mjs";

const UA = "replica/0.1";
// Hard cap per fetch so one dead/slow host can't wedge the whole run; a
// timed-out fetch resolves to null exactly like any other failed fetch.
const FETCH_TIMEOUT_MS = 10_000;
// Cap on simultaneous in-flight fetches while fingerprinting one-off URLs
// (stage 2 below). A several-hundred-page site must not open
// several-hundred sockets at once.
const FINGERPRINT_CONCURRENCY = 6;

// Fetch `url`, following redirects, and report where it actually landed
// (`finalUrl`). Returns null — "unfetchable", handled identically everywhere
// a page can't be classified — on network error, timeout, a non-2xx status,
// or (when `origin` is given) a final URL that lands off-origin: a login
// wall / interstitial / unrelated site is not real content for this page.
async function fetchHtml(url, { origin } = {}) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    if (origin && new URL(res.url).origin !== origin) return null;
    return { html: await res.text(), finalUrl: res.url };
  } catch {
    return null;
  }
}

// Run `fn` over `items` with at most `limit` in flight at once. Settles into
// `results` in input order regardless of completion order, so callers that
// group items by index/order get the same result every run no matter how
// the network races.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Fetch up to `pickSamples` members and fingerprint them.
async function fingerprintSamples(members, origin) {
  const prints = [];
  for (const url of pickSamples(members, 3)) {
    const fetched = await fetchHtml(url, { origin });
    if (fetched) prints.push({ url, print: fingerprintHtml(fetched.html) });
  }
  return prints;
}

function buildPrompt({ site, outPath }) {
  return `# Task: review page-type classification for ${site}

The replica pipeline mechanically clustered the discovered URLs into page
types. Your job is to review and correct \`pagetypes.json\` before capture.

## Input (edit this file IN PLACE)

\`${outPath}\`

## What to check, per entry in \`types\`

1. **name** — rename to a meaningful content-type name (\`blog\` → \`post\`,
   \`team\` → \`team-member\`). Lowercase, kebab-case.
2. **kind** — must be one of:
   - \`page\` — a one-off page (move its members to the top-level \`pages\` list)
   - \`single:<cpt>\` — detail pages of a custom post type
   - \`archive:<cpt>\` — listing pages of a custom post type
   - \`woo:<template_type>\` — WooCommerce page; \`<template_type>\` is one of
     shop, product, product-category, product-loop, cart, checkout,
     my-account, order-received

   **Before keeping ANY \`woo:*\` kind, confirm WooCommerce is actually
   installed/active on the SOURCE site** — don't trust the mechanical guess.
   The clustering step names a type from a URL/DOM pattern alone (e.g. any
   type whose name contains "product", "shop", or "store" is pre-labeled
   \`woo:product\`), which is frequently wrong: a plain custom catalog CPT
   literally named \`product\` on a non-WooCommerce site (a Shopify/
   Squarespace export, a hand-rolled catalog, ...) is \`single:product\`, NOT
   \`woo:product\`. Check for real signals — a \`/cart/\`, \`/checkout/\`, or
   \`/my-account/\` page/type elsewhere in this same file; \`wc-\` / \`woocommerce\`
   asset URLs in the page's assets.json once captured; WooCommerce-specific
   markup (\`.woocommerce\`, \`add-to-cart\`, \`.price\` with a currency amount in
   the expected WC shape) in the page itself — not just a name that happens
   to contain a shopping-related word. This matters beyond a cosmetic
   mislabel: WPCanAI's TemplateResolver gates its entire WooCommerce branch
   on WooCommerce actually being active, so a wrong \`woo:*\` kind on a non-Woo
   site means the \`product\` (or \`shop\`/\`cart\`/...) term is never emitted at
   all — the page/type silently falls through to the theme with NO template
   binding, not merely a wrong one.
3. **members** — prune junk (login/cart/checkout routes that aren't real
   content, paginated archive URLs like \`?page=2\` or \`/page/2\`, tag noise,
   tracking-parameter duplicates). Move mis-grouped URLs to \`pages\` or the
   right type.
4. **samples** — keep 2–3 members that best represent the type (fix if the
   mechanical picks are unrepresentative, e.g. an outlier landing page).
5. **archiveUrl** — the listing page for the type, or null.

## The \`pages\` list

Every remaining one-off page URL. Remove obvious junk here too
(wp-login, feed URLs, search results, utility pages).

## When mechanical clustering fails (0 types, or an obvious type is missing)

**Zero \`types\` on a site that plainly HAS a repeating content type** (a
blog with dozens of posts, a store full of products, a directory of team
members, ...) **is a classify failure, not a fact about the site** — the
URL-shape and DOM-fingerprint heuristics can both miss at once (proven live
on a WordPress blog whose per-page comment threads defeated fingerprinting
before comment-stripping existed). Repair it right here by hand-authoring
the missing type entry — that is fully supported, and every downstream
stage treats a hand-written entry exactly like a mechanical one. The
minimal shape:

\`\`\`json
{
  "name": "post",
  "kind": "single:post",
  "pattern": null,
  "confidence": "manual",
  "members": ["https://example.com/2025/05/first-post/", "...every URL of this type..."],
  "samples": ["...2-3 of the members, spread out (oldest/middle/newest)..."],
  "archiveUrl": "https://example.com/blog/"
}
\`\`\`

Move the member URLs OUT of the top-level \`pages\` list when you do this —
a URL must never appear in both places. Set \`archiveUrl\` to the type's
real listing page if the site has one (it need not share a URL prefix with
the members), or null. \`"confidence": "manual"\` marks the entry as
hand-authored.

## Confidence notes

- \`fingerprint\` — members share DOM structure; trust the grouping.
- \`url-only\` — grouped by URL shape alone; too few samples could be fetched
  to confirm either way. Double-check the members.
- \`fingerprint-conflict\` — grouped by URL shape, but the samples that *did*
  fetch disagree on DOM structure — positive evidence the grouping is wrong,
  not just unconfirmed. Split the type, or move the outlier member(s) to the
  right type / \`pages\`.
- \`fingerprint-cluster\` — same DOM structure, unrelated URLs; name it by
  looking at 1–2 member URLs.

Save the corrected \`pagetypes.json\` in place. Do not write anything else.
`;
}

export async function classify({ site, runsDir = "runs", minMembers = 4 }) {
  const runDir = path.join(runsDir, site);
  const pagesJson = JSON.parse(await readFile(path.join(runDir, "pages.json"), "utf8"));
  const urls = pagesJson.pages.map((p) => p.url);
  const siteOrigin = urls.length ? new URL(urls[0]).origin : null;

  const { types: urlTypes, oneOffs } = groupByUrlPattern(urls, minMembers);
  const urlSet = new Set(urls.map((u) => u.replace(/\/+$/, "")));

  const types = [];

  // 1. Confirm URL-pattern groups by DOM fingerprint.
  for (const t of urlTypes) {
    const prints = await fingerprintSamples(t.members, siteOrigin);
    const agree = prints.length >= 2 && prints.every((p) => p.print === prints[0].print);
    const name = nameFromPattern(t.pattern);
    const parent = t.pattern.replace(/\/\*$/, "");
    const origin = new URL(t.members[0]).origin;
    const archiveCandidate = (origin + parent).replace(/\/+$/, "");
    types.push({
      name,
      kind: guessKind(name),
      pattern: t.pattern,
      // Couldn't fetch enough samples to have an opinion vs. fetched enough
      // and they disagree: the latter is positive evidence the URL-pattern
      // grouping itself is wrong, so it gets its own confidence value.
      confidence: prints.length < 2 ? "url-only" : agree ? "fingerprint" : "fingerprint-conflict",
      members: t.members,
      samples: pickSamples(t.members, 3),
      archiveUrl: urlSet.has(archiveCandidate) ? archiveCandidate : null,
    });
  }

  // 2. Fingerprint-cluster the remaining one-offs: identical skeletons with
  // >= minMembers members become an extra type even when URLs don't reveal
  // it. Fetches are bounded to FINGERPRINT_CONCURRENCY in flight so a
  // several-hundred-page site doesn't open several-hundred sockets at once;
  // results are collected back into input order before any grouping
  // happens, so which fingerprint group a URL lands in never depends on
  // fetch completion order.
  let fetchedCount = 0;
  const fetched = await mapPool(oneOffs, FINGERPRINT_CONCURRENCY, async (url) => {
    const result = await fetchHtml(url, { origin: siteOrigin });
    fetchedCount += 1;
    process.stderr.write(`[${fetchedCount}/${oneOffs.length}] ${url}\n`);
    return result;
  });

  const pages = [];
  const byPrint = new Map();
  const seenFinalUrls = new Set();
  for (let i = 0; i < oneOffs.length; i++) {
    const url = oneOffs[i];
    const result = fetched[i];
    if (!result) {
      pages.push(url); // unfetchable: error, timeout, non-2xx, or off-origin redirect
      continue;
    }
    // Same-origin URLs that redirect to one identical final URL are, in
    // truth, one page reached two ways — don't let the duplicates inflate a
    // cluster past minMembers when there's really only one distinct page.
    const finalKey = result.finalUrl.replace(/\/+$/, "");
    if (seenFinalUrls.has(finalKey)) {
      pages.push(url);
      continue;
    }
    seenFinalUrls.add(finalKey);
    const print = fingerprintHtml(result.html);
    if (!byPrint.has(print)) byPrint.set(print, []);
    byPrint.get(print).push(url);
  }
  let clusterIdx = 0;
  for (const members of byPrint.values()) {
    if (members.length >= minMembers) {
      clusterIdx += 1;
      const name = `cluster-${clusterIdx}`;
      types.push({
        name,
        kind: guessKind(name),
        pattern: null,
        confidence: "fingerprint-cluster",
        members,
        samples: pickSamples(members, 3),
        archiveUrl: null,
      });
    } else {
      pages.push(...members);
    }
  }

  const outPath = path.resolve(runDir, "pagetypes.json");
  await writeFile(
    outPath,
    JSON.stringify({ site, types, pages: pages.map((url) => ({ url })) }, null, 2),
  );

  const bundleDir = path.resolve(runDir, ".classify");
  await mkdir(bundleDir, { recursive: true });
  const promptPath = path.join(bundleDir, "PROMPT.md");
  await writeFile(promptPath, buildPrompt({ site, outPath }));

  return { site, typeCount: types.length, pageCount: pages.length, outPath, promptPath };
}

// Exported purely for direct testing (Fix 3) — production code only ever
// calls `classify()` itself. mapPool/fetchHtml are the two pieces classify()
// leans on most heavily for correctness (order-preservation under
// concurrency; the off-origin/non-2xx unfetchable contract) and had zero
// coverage before; buildPrompt's WooCommerce-confirmation guidance (Fix 5b)
// is easiest to pin by reading the literal prompt text it produces.
export { mapPool, fetchHtml, buildPrompt };
