// The `structure` objective's deliverable: a faithful, mechanical content
// inventory rendered straight from content.json — no prompt, no LLM pass, so
// it cannot drift from the capture. extractStructureFromDoc is its inverse
// for verify-structure (same shape as verifyStructure.extractStructure).

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function renderBlock(section, { sliceFile = null } = {}) {
  const lines = [];
  if (sliceFile) lines.push(`- slice: ${sliceFile}`);
  for (const h of section.headings ?? []) lines.push(`- h${h.level}: ${norm(h.text)}`);
  for (const p of section.paragraphs ?? []) lines.push(`- p: ${norm(p)}`);
  for (const l of section.lists ?? []) lines.push(`- list${l.ordered ? " (ordered)" : ""}: ${l.items.map(norm).join("; ")}`);
  for (const a of section.links ?? []) lines.push(`- link: [${norm(a.text)}](${a.href})`);
  for (const b of section.buttons ?? []) lines.push(`- button: ${norm(b)}`);
  for (const i of section.images ?? []) lines.push(`- image: ${i.src} — ${norm(i.alt) || "(no alt)"}`);
  for (const v of section.videos ?? []) lines.push(`- video: ${v.kind} ${v.src}${v.title ? ` (${norm(v.title)})` : ""}${v.poster ? ` poster ${v.poster}` : ""}`);
  for (const f of section.forms ?? []) {
    const labels = (f.fields ?? []).map((x) => x.label || x.placeholder || x.name || x.type).filter(Boolean).join(", ");
    lines.push(`- form: ${f.method || "get"} ${f.action || "(no action)"} — ${labels || "(no fields)"}`);
  }
  for (const t of section.tables ?? []) {
    const head = (t.headers ?? []).length ? t.headers.join(" | ") : (t.pairs ? "label | value" : "(no header row)");
    lines.push(`- table: ${t.caption || "(no caption)"} — ${head} (${(t.rows ?? []).length} rows)`);
  }
  for (const d of section.definitionLists ?? []) lines.push(`- dl: ${d.pairs.map((p) => `${p.label}: ${p.value}`).join("; ")}`);
  for (const p of section.labelValuePairs ?? []) lines.push(`- fact: ${p.label}: ${p.value}`);
  return lines.length ? lines : ["- (empty)"];
}

export function renderStructureMarkdown({ slug, url, content, sectionFiles = {} }) {
  const main = Array.isArray(content?.main) ? content.main : [];
  const out = [
    `# ${norm(content?.title) || slug}`,
    "",
    `- url: ${url}`,
    `- slug: ${slug}`,
    `- description: ${norm(content?.description) || "(none)"}`,
    `- lang: ${content?.lang || "(unknown)"}`,
    "",
  ];
  if (content?.header) out.push("## Header", "", ...renderBlock(content.header, { sliceFile: sectionFiles.header ?? null }), "");
  main.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.id} (${s.role || "section"}, ${s.tag || "section"})`, "", ...renderBlock(s, { sliceFile: sectionFiles[s.id] ?? null }), "");
  });
  if (content?.footer) out.push("## Footer", "", ...renderBlock(content.footer, { sliceFile: sectionFiles.footer ?? null }), "");
  return out.join("\n");
}

export function extractStructureFromDoc(markdown) {
  const md = String(markdown ?? "");
  const lines = md.split("\n");
  const grab = (re) => lines.map((l) => l.match(re)).filter(Boolean).map((m) => m[1]);
  return {
    sections: lines.filter((l) => /^## \d+\. /.test(l)).length,
    headings: grab(/^- h[1-6]: (.+)$/).map((text) => ({ text: norm(text), twig: false })),
    imageSrcs: grab(/^- image: (\S+)/),
    twigImages: 0,
    videoSrcs: grab(/^- video: \S+ (\S+)/),
    forms: grab(/^- form: (.+)$/).length,
    tables: grab(/^- table: (.+)$/).length,
    header: /^## Header$/m.test(md),
    footer: /^## Footer$/m.test(md),
  };
}
