
(() => {
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const text = (el) => (el && (el.innerText || el.textContent) || "").trim().replace(/\s+/g, " ");

  const meta = (name) => {
    const el = document.querySelector('meta[name="' + name + '"]') ||
               document.querySelector('meta[property="' + name + '"]');
    return el ? el.getAttribute("content") : null;
  };

  const samp = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      margin: cs.margin,
      borderRadius: cs.borderRadius,
      letterSpacing: cs.letterSpacing,
    };
  };

  // --- Tables: structured rows with header vs data cells kept distinct,
  // plus a caption if present. buildTableModel (capture.mjs, exported) is a
  // pure parity copy of this row-classification/pairs logic — kept in sync
  // by hand (this string runs inside the captured page via eval, with zero
  // dependencies, so it can't literally import that; same constraint as
  // accentScore/isRenderedGivenComputedStyle elsewhere in this file) — see
  // its doc comment for the full rationale. In short: a row is only ever
  // excluded from `rows` into `headers` when EVERY cell in it is a <th>
  // (a true column-header row); a WooCommerce-style attributes row (one
  // <th> label + one <td> value, no dedicated header row at all) stays in
  // `rows`, which is what lets `pairs` fall out of a plain
  // 2-cells-per-row check afterward. Defensive per-table so one malformed
  // table can't throw and take the rest of content extraction down with it.
  const buildTableModel = (rowsCells) => {
    const rows = [];
    let headers = [];
    let headerTaken = false;
    for (const cells of rowsCells) {
      if (!cells.length) continue;
      const values = cells.map((c) => c.text);
      if (!headerTaken && cells.every((c) => c.tag === "TH")) {
        headers = values;
        headerTaken = true;
      } else {
        rows.push(values);
      }
    }
    const hasText = headers.some(Boolean) || rows.some((r) => r.some(Boolean));
    if (!hasText) return null;
    let pairs = null;
    if (rows.length && rows.every((r) => r.length === 2)) {
      pairs = rows.map(([label, value]) => ({ label, value }));
    }
    return { headers, rows, pairs };
  };
  const extractTable = (t) => {
    try {
      const rowsCells = $$("tr", t).map((tr) => $$("th,td", tr).map((c) => ({ tag: c.tagName, text: text(c) })));
      const model = buildTableModel(rowsCells);
      if (!model) return null;
      const captionEl = t.querySelector("caption");
      return { caption: captionEl ? text(captionEl) : null, ...model };
    } catch {
      return null;
    }
  };

  // --- Definition lists: <dt>/<dd> pairs. buildDefinitionListPairs
  // (capture.mjs, exported) is this function's pure parity copy — same
  // eval-boundary constraint as buildTableModel above. `$$("dt,dd", dl)`
  // walks through the HTML5 "<dl><div><dt>…<dd>…</div></dl>" wrapper
  // pattern (e.g. MDN-style markup) the same as the flat
  // <dl><dt>…<dd>…</dl> shape, since querySelectorAll matches descendants
  // regardless of an intervening <div>.
  const buildDefinitionListPairs = (items) => {
    const pairs = [];
    let label = null;
    let values = [];
    const flush = () => {
      if (label && values.length) pairs.push({ label, value: values.join(", ") });
      values = [];
    };
    for (const it of items) {
      if (it.tag === "DT") {
        flush();
        label = it.text;
      } else if (label && it.text) {
        values.push(it.text);
      }
    }
    flush();
    return pairs.length ? { pairs } : null;
  };
  const extractDl = (dl) => {
    try {
      return buildDefinitionListPairs($$("dt,dd", dl).map((el) => ({ tag: el.tagName, text: text(el) })));
    } catch {
      return null;
    }
  };

  // --- Narrow label/value pairs from plain <span>/<div> wrappers — the
  // WooCommerce SKU shape (`<span class="sku_wrapper">SKU: <span
  // class="sku">BB-123</span></span>`) and equivalents on other themes/
  // sites never go through <table> or <dl>, so without this they're
  // invisible to every extractor above (and always were — this is not a
  // regression; `paragraphs`/`lists` never scanned bare <span>/<div> text
  // either). Deliberately narrow: a bare "scan every span" heuristic would
  // hoover up nav/UI chrome text and flood content.json with noise, which
  // is worse than the gap it closes. matchLabelValuePair (capture.mjs,
  // exported) is this matcher's pure parity copy (same eval-boundary
  // constraint) and is where the actual shape rules are documented/tested:
  // a short "Label:" prefix as the element's OWN text, a distinct value
  // (inline after the colon, or in exactly one child element), and the
  // element's FULL text must be exactly "label: value" — nothing else
  // going on in that wrapper. Skips anything already inside a
  // <table>/<dl>/<form> (covered above/elsewhere; must not double-report).
  // A capped output size (MAX_LABEL_VALUE_PAIRS, per section) is a cheap
  // extra backstop against a pathological page, on top of those shape
  // constraints.
  const LABEL_VALUE_RE = /^([A-Za-z][A-Za-z0-9 &'/-]{1,29}):\s*(.*)$/;
  const matchLabelValuePair = (ownText, fullText, childCount, childText) => {
    const m = LABEL_VALUE_RE.exec(ownText || "");
    if (!m) return null;
    const label = m[1].trim();
    let value = m[2].trim();
    if (!value) {
      if (childCount !== 1) return null;
      value = (childText || "").trim();
    }
    if (!value || value.length > 200) return null;
    if (fullText !== (label + ": " + value) && fullText !== (label + ":" + value)) return null;
    return { label, value };
  };
  const MAX_LABEL_VALUE_PAIRS = 30;
  const extractLabelValuePairs = (root) => {
    const out = [];
    for (const el of $$("span,div", root)) {
      if (out.length >= MAX_LABEL_VALUE_PAIRS) break;
      try {
        if (el.closest("table,dl,form")) continue;
        let ownText = "";
        for (const n of el.childNodes) {
          if (n.nodeType === 3) ownText += n.textContent; // 3 === Text node
        }
        ownText = ownText.trim().replace(/\s+/g, " ");
        if (!ownText) continue;
        const kids = el.children;
        const childText = kids.length === 1 ? text(kids[0]) : "";
        const m = matchLabelValuePair(ownText, text(el), kids.length, childText);
        if (m) out.push(m);
      } catch {
        // One malformed element must not stop the scan of the rest.
      }
    }
    return out;
  };

  const extract = (root) => {
    if (!root) return null;
    const headings = $$("h1,h2,h3,h4,h5,h6", root).map(h => ({
      level: parseInt(h.tagName[1], 10),
      text: text(h),
    })).filter(h => h.text);

    const paragraphs = $$("p", root).map(text).filter(Boolean);

    const lists = $$("ul,ol", root).map(l => ({
      ordered: l.tagName === "OL",
      items: $$("li", l).map(text).filter(Boolean),
    })).filter(l => l.items.length);

    const links = $$("a[href]", root).map(a => ({
      text: text(a),
      href: a.href,
    })).filter(l => l.text || l.href);

    const images = $$("img", root).map(i => ({
      src: i.currentSrc || i.src,
      alt: i.alt || "",
      width: i.naturalWidth || null,
      height: i.naturalHeight || null,
    })).filter(i => i.src);

    // --- Videos / embeds. Parity copy of videoKindForSrc/buildVideoModel
    // (capture.mjs, exported + tested) — same eval-boundary constraint as
    // buildTableModel above. Hidden/zero-size players are dropped the same
    // way a display:none image would be; poster/title survive so a wireframe
    // or structure deliverable can label the box.
    const VIDEO_HOST_KINDS = [
      [/(^|\.)youtube(-nocookie)?\.com$/i, "youtube"],
      [/(^|\.)youtu\.be$/i, "youtube"],
      [/(^|\.)vimeo\.com$/i, "vimeo"],
      [/(^|\.)wistia\.(com|net)$/i, "wistia"],
      [/(^|\.)loom\.com$/i, "loom"],
    ];
    const videoKindForSrc = (tag, src) => {
      if (String(tag).toUpperCase() === "VIDEO") return "video";
      let host = "";
      try { host = new URL(src).hostname; } catch { return "iframe"; }
      for (const [re, kind] of VIDEO_HOST_KINDS) if (re.test(host)) return kind;
      return "iframe";
    };
    const isRenderedEl = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const buildVideoModel = ({
      tag, src, poster = null, title = null, autoplay = false, width = null, height = null, rendered = true,
    } = {}) => {
      if (!src || !rendered) return null;
      return {
        kind: videoKindForSrc(tag, src), src, poster: poster || null, title: title || null,
        width: width || null, height: height || null, autoplay: Boolean(autoplay),
      };
    };
    const videoEls = [
      ...$$("video", root).map((v) => {
        const source = v.querySelector("source[src]");
        const r = v.getBoundingClientRect();
        return buildVideoModel({
          tag: "VIDEO", src: v.currentSrc || v.src || (source ? source.src : ""),
          poster: v.poster || null, title: v.title || v.getAttribute("aria-label") || null,
          autoplay: v.autoplay, width: Math.round(r.width), height: Math.round(r.height), rendered: isRenderedEl(v),
        });
      }),
      ...$$("iframe[src]", root).map((f) => {
        const r = f.getBoundingClientRect();
        return buildVideoModel({
          tag: "IFRAME", src: f.src, poster: null, title: f.title || null, autoplay: false,
          width: Math.round(r.width), height: Math.round(r.height), rendered: isRenderedEl(f),
        });
      }),
    ];
    const videos = videoEls.filter(Boolean);

    const forms = $$("form", root).map(f => ({
      action: f.getAttribute("action") || null,
      method: (f.getAttribute("method") || "get").toLowerCase(),
      fields: $$("input,select,textarea,button", f).map(e => ({
        tag: e.tagName.toLowerCase(),
        type: e.type || null,
        name: e.name || null,
        placeholder: e.placeholder || null,
        label: ((e.labels && e.labels[0] && e.labels[0].innerText) || "").trim() || null,
        value: (e.tagName === "BUTTON" ? text(e) : null),
      })),
    }));

    const buttons = Array.from(new Set(
      $$("button,[role=button]", root).map(text).filter(Boolean)
    ));

    const tables = $$("table", root).map(extractTable).filter(Boolean);
    const definitionLists = $$("dl", root).map(extractDl).filter(Boolean);
    const labelValuePairs = extractLabelValuePairs(root);

    return {
      headings, paragraphs, lists, links, images, videos, forms, buttons,
      tables, definitionLists, labelValuePairs,
    };
  };

  const findById = (id) => document.querySelector('[data-capture-id="' + id + '"]');

  const headerEl = findById("header");
  const footerEl = findById("footer");

  // All other tagged elements are body sections, in document order.
  const sectionEls = $$("[data-capture-id]").filter(el => {
    const id = el.getAttribute("data-capture-id");
    return id !== "header" && id !== "footer";
  });

  const main = sectionEls.map(el => {
    const id = el.getAttribute("data-capture-id");
    const cls = (typeof el.className === "string" ? el.className : "").trim().slice(0, 120);
    return {
      id,
      role: id === "hero" ? "hero" : "section",
      tag: el.tagName.toLowerCase(),
      className: cls || null,
      elementId: el.id || null,
      ...extract(el),
    };
  });

  return {
    title: document.title,
    url: location.href,
    description: meta("description") || meta("og:description"),
    ogImage: meta("og:image"),
    lang: document.documentElement.lang || null,
    computedStyles: {
      html: samp("html"),
      body: samp("body"),
      h1: samp("h1"),
      h2: samp("h2"),
      h3: samp("h3"),
      a: samp("a"),
      button: samp("button, [type=submit], [role=button]"),
      primaryBtn: samp(".btn-primary, .button-primary, button.primary, .primary-button"),
    },
    header: extract(headerEl),
    main,
    footer: extract(footerEl),
  };
})();
