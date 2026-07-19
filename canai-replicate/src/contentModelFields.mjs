// Mechanically extracts field/taxonomy NAMES and TYPES for one page type out
// of a real CONTENT-MODEL.md — enough to render that type's Twig template
// with real, sample-derived data (see sampleHarvest.mjs) for verify's
// Twig-render-and-score harness (twigRender.mjs).
//
// Deliberately does NOT try to parse the "Source" column (e.g. "main[1]
// heading level 2, text with the leading \"About \" stripped") — that
// describes extraction the way a human reads a page, not a syntax a script
// can execute generically across arbitrary sites. What IS mechanical,
// because prompts/contentmodel.md's own "Deliverable structure" dictates a
// fixed table shape for it, is: the post-type slug ("### 1. Post type"'s
// `| slug | \`x\` |` row), and every "Field name | Type | Required? |
// Source" row (item 2's Custom fields table, and — same 4-column shape —
// a woo:product type's "Product meta (leftovers)" table). Real CONTENT-MODEL.md
// files disagree on heading STYLE (humanmade.com: `## \`case-study\``;
// barefootbuttons.com: `### product (\`woo:product\`)`) but not on that
// table shape, which is why this parses tables, not headings, for the
// field data itself — the heading search below only has to locate the
// right SECTION, not classify its data.
//
// --- Tolerance + loudness (smittenkitchen.com dogfood, defect #2) ---------
//
// The first version of this parser was silently regex-strict: the
// "Required?" cell had to be EXACTLY `yes`/`no` (nothing else in the cell)
// and the type cell a bare keyword. A real authoring agent, unprompted,
// wrote the natural "Yes (present, non-empty, in both samples)" — and every
// single custom field was silently dropped from harvesting: no warning at
// any stage, templates just rendered with no fields. Two changes close that
// class of failure:
//
//  1. TOLERANT CELLS — the Type cell only needs to START with one of the
//     eight keywords, and the Required?/Hierarchical? cells only need to
//     START with yes/no (any casing, markdown decoration like **bold** /
//     `code` stripped); a trailing annotation no longer kills the row.
//     Extra columns after Source are ignored, and a taxonomy table written
//     3-column (| Taxonomy | Hierarchical? | Source | — the shape the
//     dogfood agent actually produced) still parses, with required=false.
//  2. LOUD FAILURE — the parse result now carries a `warnings` array (this
//     module stays pure — callers like twigRender.mjs print them). A row
//     that sits under a RECOGNIZED field/taxonomy table header (see
//     headerKind) and still can't be parsed is reported row-by-row, and a
//     recognized table that yields ZERO rows gets its own warning (that is
//     always wrong — why else would the table exist?). Rows in
//     unrecognized tables (post-type attributes, field-mapping rows) are
//     ignored silently, exactly as before — they belong to other tables
//     and warning about them would be noise.

// Field-type keywords from contentmodel.md's own item 2 ("one of
// text/textarea/url/image/number/date/boolean/repeater"). A taxonomy row has
// the same shape but its 2nd column is yes/no (hierarchical?), which never
// collides with this list — that disjointness is what lets
// parseFieldsAndTaxonomies tell the two kinds of row apart even for rows
// that don't sit under a recognized table header.
const FIELD_TYPE_KEYWORDS = new Set([
  "text",
  "textarea",
  "url",
  "image",
  "number",
  "date",
  "boolean",
  "repeater",
]);

const SLUG_ROW_RE = /^\|\s*slug\s*\|\s*`([a-z][a-z0-9_]*)`\s*\|/im;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- markdown-table plumbing -------------------------------------------------

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// The |---|:---:|---| row between a table's header and its data rows.
function isSeparatorRow(line) {
  if (!/^\s*\|/.test(line)) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

// Classify a table by its HEADER cells: a custom-fields table (item 2 /
// "Product meta (leftovers)") always names a "Field"/"Field name" column
// and a "Type" column; a taxonomies table always names "Taxonomy" and
// "Hierarchical?". Checked against every real table shape in this repo's
// runs: the Post type table (| Field | Value | / | Attribute | Value |),
// the field-mapping table (| Source slot | Maps to |), and woo's native
// property mapping (| Source slot | Native WooCommerce property |
// Verified? |) all correctly classify as null.
function headerKind(cells) {
  const lc = cells.map((c) => c.toLowerCase());
  const has = (re) => lc.some((c) => re.test(c));
  if (has(/taxonom/) && has(/hierarch/)) return "taxonomy";
  if (has(/field/) && has(/type/)) return "field";
  return null;
}

// --- tolerant cell parsers ----------------------------------------------------

// Strip markdown decoration (bold/italic/code/quote markers) off a cell's
// leading edge so "**Yes**" / "`no`" / "_yes_" all expose their keyword.
function stripLeadingDecoration(s) {
  return String(s ?? "").replace(/^[\s*_~`"']+/, "");
}

// A cell "counts" as yes/no when it STARTS with the word (any casing,
// decorations stripped): "Yes (present, non-empty, in both samples)" → true,
// "no — optional" → false, "not required" → null ("not" is not "no\b": the
// boundary check keeps prefix words out). Returns true/false/null.
function parseYesNo(cell) {
  const m = stripLeadingDecoration(cell).match(/^(yes|no)\b/i);
  return m ? m[1].toLowerCase() === "yes" : null;
}

// A cell "counts" as a field type when its first word is one of the eight
// keywords: "textarea (one ingredient per line)" → "textarea",
// "Plain Text" → null (first word "plain" is not a keyword). Returns the
// lowercase keyword or null.
function parseFieldType(cell) {
  const m = stripLeadingDecoration(cell).match(/^([a-z]+)\b/i);
  if (!m) return null;
  const kw = m[1].toLowerCase();
  return FIELD_TYPE_KEYWORDS.has(kw) ? kw : null;
}

// The name cell must be JUST the identifier — that whole-cell requirement is
// what keeps prose cells (the field-mapping table's "`main[0]` heading
// level 2") from ever parsing as a name. Backticks required by default;
// under a RECOGNIZED field/taxonomy table (allowBare) a bare identifier is
// accepted too, since every data row there is by definition a field/
// taxonomy row.
function parseNameCell(cell, { allowBare = false } = {}) {
  const c = String(cell ?? "");
  const backticked = c.match(/^[\s*_~]*`([a-z][a-z0-9_]*)`[\s*_~]*$/);
  if (backticked) return backticked[1];
  if (allowBare) {
    const bare = c.match(/^([a-z][a-z0-9_]*)$/);
    if (bare) return bare[1];
  }
  return null;
}

// Locate the "## `type-name`" / "### type-name (`woo:kind`)" (or any other
// heading style a real run has used) section for `typeName` inside a full
// CONTENT-MODEL.md, and return just that section's text (from its heading
// line up to, but not including, the next heading of the SAME OR SHALLOWER
// level — so a `#### Product meta (leftovers)` sub-table stays inside its
// own `### product` section, but the next `### cart` section correctly ends
// it). Only considers heading levels 2–3 as candidate TYPE headings (a
// `####` line is always a sub-heading of whichever type section contains
// it, per contentmodel.md's own item numbering, never a type heading
// itself). Returns null when no heading contains `typeName` as a
// standalone token.
export function findTypeSection(markdown, typeName) {
  const lines = String(markdown ?? "").split("\n");
  const headingRe = /^(#{1,4})\s+(.*)$/;
  const tokenRe = new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(typeName.toLowerCase())}($|[^a-z0-9_-])`);

  let startIdx = -1;
  let level = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    const hLevel = m[1].length;
    if (hLevel > 3) continue;
    if (tokenRe.test(m[2].toLowerCase())) {
      startIdx = i;
      level = hLevel;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && m[1].length <= level) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

// Pull every field/taxonomy data row out of a section's text. Order
// preserved (harvesting walks fields/taxonomies in the order
// CONTENT-MODEL.md lists them, for no reason other than determinism).
// Returns { fields, taxonomies, warnings } — warnings are human-readable
// strings the CALLER must surface (this module does no I/O); see the
// module-level "Tolerance + loudness" note for which failures warn and
// which stay silent.
export function parseFieldsAndTaxonomies(sectionText) {
  const lines = String(sectionText ?? "").split("\n");
  const fields = [];
  const taxonomies = [];
  const warnings = [];
  const seenFields = new Set();
  const seenTaxonomies = new Set();

  let sawFieldTable = false;
  let sawTaxonomyTable = false;
  // Which recognized table (if any) the current data rows belong to:
  // "field" | "taxonomy" | "other" (a table we don't parse) | null (not in
  // a table at all). Reset by any non-table line.
  let currentTable = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) {
      currentTable = null;
      continue;
    }
    if (isSeparatorRow(line)) continue;
    if (isSeparatorRow(lines[i + 1] ?? "")) {
      // A table line directly followed by the |---|---| separator is a
      // header row — classify the table it opens.
      const kind = headerKind(splitCells(line));
      currentTable = kind ?? "other";
      if (kind === "field") sawFieldTable = true;
      if (kind === "taxonomy") sawTaxonomyTable = true;
      continue;
    }

    // A data row.
    const cells = splitCells(line);
    const underRecognized = currentTable === "field" || currentTable === "taxonomy";
    const name = parseNameCell(cells[0], { allowBare: underRecognized });
    if (!name) {
      if (underRecognized) {
        warnings.push(
          `skipped unparseable ${currentTable}-table row (first cell must be the ` +
            `backticked snake_case name and nothing else): ${line.trim()}`,
        );
      }
      continue;
    }

    const fieldType = parseFieldType(cells[1]);
    const cell1YesNo = parseYesNo(cells[1]);
    const cell2YesNo = parseYesNo(cells[2]);

    if (fieldType !== null && (cell2YesNo !== null || underRecognized)) {
      // Field row. Outside a recognized table the Required? cell must parse
      // as yes/no — that third-cell check is what keeps a coincidental
      // `| \`name\` | text ... |` row of some OTHER table from registering
      // as a field. Under a recognized field table every row IS a field
      // row, so an unreadable Required? cell degrades to optional + warning
      // instead of killing the row.
      if (seenFields.has(name)) continue; // e.g. a field re-cited in a later table
      seenFields.add(name);
      let required = cell2YesNo;
      if (required === null) {
        warnings.push(
          `field \`${name}\`: could not read the Required? cell ` +
            `${JSON.stringify(cells[2] ?? "")} (must START with yes or no) — assuming optional`,
        );
        required = false;
      }
      fields.push({ name, type: fieldType, required });
    } else if (
      cell1YesNo !== null &&
      (cell2YesNo !== null || (currentTable === "taxonomy" && cells.length >= 3))
    ) {
      // Taxonomy row. The 4-column contract shape has Required? in cell 3;
      // the 3-column shape a real run produced (| Taxonomy | Hierarchical? |
      // Source |) is accepted UNDER A RECOGNIZED TAXONOMY TABLE ONLY, with
      // required defaulting to false — outside one, requiring the yes/no
      // third cell (as the strict parser always did) keeps a stray
      // `| \`hierarchical\` | yes | <prose> |` attribute row of some other
      // table from fabricating a taxonomy.
      if (seenTaxonomies.has(name)) continue;
      seenTaxonomies.add(name);
      taxonomies.push({ name, required: cell2YesNo === true });
    } else if (underRecognized) {
      const why =
        currentTable === "field"
          ? `the Type cell must START with one of ${[...FIELD_TYPE_KEYWORDS].join("/")}`
          : "the Hierarchical? cell must START with yes or no";
      warnings.push(`skipped unparseable ${currentTable}-table row (${why}): ${line.trim()}`);
    }
  }

  if (sawFieldTable && fields.length === 0) {
    warnings.push(
      "a custom-fields table is present but yielded ZERO parseable field rows — " +
        "the type will render with no custom fields during verify; fix the table " +
        "to match the format documented in prompts/contentmodel.md",
    );
  }
  if (sawTaxonomyTable && taxonomies.length === 0) {
    warnings.push(
      "a taxonomies table is present but yielded ZERO parseable taxonomy rows — " +
        "fix the table to match the format documented in prompts/contentmodel.md",
    );
  }

  return { fields, taxonomies, warnings };
}

// The "### 1. Post type" table's `| slug | \`case_study\` |` row. Only
// meaningful for CPT kinds (single:<cpt>/archive:<cpt>) — a woo:* section
// replaces items 1–4 with item 5 and never has this row; returns null
// there, which is correct (a woo:product single template never
// self-enriches by post_type the way a CPT does — see
// transform-template.md's "opposite of the CPT case" note).
export function parsePostTypeSlug(sectionText) {
  const m = String(sectionText ?? "").match(SLUG_ROW_RE);
  return m ? m[1] : null;
}

// Convenience: find the section AND parse it in one call. Returns null when
// the type has no section at all (CONTENT-MODEL.md missing this type, or
// using a heading style this parser's tokenRe genuinely can't locate —
// twigRender.mjs's caller treats that as "not scored: no CONTENT-MODEL.md
// section for this type", never a crash).
export function parseContentModelForType(markdown, typeName) {
  const section = findTypeSection(markdown, typeName);
  if (section === null) return null;
  const { fields, taxonomies, warnings } = parseFieldsAndTaxonomies(section);
  return { postTypeSlug: parsePostTypeSlug(section), fields, taxonomies, warnings };
}
