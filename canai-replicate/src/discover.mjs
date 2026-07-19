// Discover all pages of a site.
// Strategy: try /sitemap.xml, /sitemap_index.xml, robots.txt Sitemap directive.
// Fallback: BFS crawl from homepage, same-origin only, depth-capped.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { siteFromUrl } from "./slug.mjs";

const UA = "replica/0.1";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseSitemapXml(xml) {
  // Extract <loc>...</loc> entries. Works for urlset and sitemapindex.
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  return { locs, isIndex };
}

async function tryRobotsSitemap(origin) {
  try {
    const txt = await fetchText(`${origin}/robots.txt`);
    return [...txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  } catch {
    return [];
  }
}

async function fetchAllSitemapUrls(sitemapUrl, seen = new Set()) {
  if (seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);
  let xml;
  try {
    xml = await fetchText(sitemapUrl);
  } catch {
    return [];
  }
  const { locs, isIndex } = parseSitemapXml(xml);
  if (!isIndex) return locs;
  const all = [];
  for (const child of locs) {
    all.push(...(await fetchAllSitemapUrls(child, seen)));
  }
  return all;
}

async function discoverViaSitemap(origin) {
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    ...(await tryRobotsSitemap(origin)),
  ];
  for (const url of candidates) {
    const urls = await fetchAllSitemapUrls(url);
    if (urls.length > 0) return { source: "sitemap", sitemap: url, urls };
  }
  return null;
}

function extractLinks(html, baseUrl) {
  // Cheap link extractor — string-match <a href="...">. Good enough for crawl scope.
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      out.add(new URL(m[1], baseUrl).toString());
    } catch {}
  }
  return [...out];
}

async function discoverViaCrawl(origin, depthCap = 3, max = 200) {
  const queue = [{ url: `${origin}/`, depth: 0 }];
  const seen = new Set([`${origin}/`]);
  const out = [];
  while (queue.length && out.length < max) {
    const { url, depth } = queue.shift();
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }
    out.push({ url, depth });
    if (depth >= depthCap) continue;
    for (const link of extractLinks(html, url)) {
      try {
        const u = new URL(link);
        if (u.origin !== origin) continue;
        u.hash = "";
        const norm = u.toString();
        if (seen.has(norm)) continue;
        seen.add(norm);
        queue.push({ url: norm, depth: depth + 1 });
      } catch {}
    }
  }
  return { source: "crawl", urls: out.map((p) => p.url) };
}

export async function discover(siteUrl, runsDir = "runs") {
  const origin = new URL(siteUrl).origin;
  const site = siteFromUrl(siteUrl);

  let result = await discoverViaSitemap(origin);
  if (!result) result = await discoverViaCrawl(origin);

  const pages = result.urls
    .filter((u) => {
      try {
        const x = new URL(u);
        return x.origin === origin;
      } catch {
        return false;
      }
    })
    .map((u) => ({ url: u, source: result.source }));

  const outDir = path.join(runsDir, site);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "pages.json");
  await writeFile(
    outPath,
    JSON.stringify({ site, source: result.source, sitemap: result.sitemap || null, pages }, null, 2),
  );

  return { site, count: pages.length, source: result.source, outPath };
}
