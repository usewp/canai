
(() => {
  // Make sure measurements are taken from the document origin, not whatever
  // scroll position the prior commands left us at.
  window.scrollTo(0, 0);

  const MIN_HEIGHT_HERO = 200;
  const MIN_HEIGHT_SECTION = 80;
  const tagged = [];
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;

  const tag = (el, id, role) => {
    if (!el) return false;
    if (el.getAttribute('data-capture-id')) return false; // don't double-tag
    el.setAttribute('data-capture-id', id);
    const rect = el.getBoundingClientRect();
    const cls = (typeof el.className === 'string' ? el.className : '').trim().slice(0, 120);
    tagged.push({
      id,
      role,
      tag: el.tagName.toLowerCase(),
      className: cls || null,
      elementId: el.id || null,
      top: Math.round(rect.top + scrollY),
      left: Math.round(rect.left + scrollX),
      width: Math.round(rect.width),
      height: Math.round(Math.max(rect.height, el.scrollHeight)),
    });
    return true;
  };

  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 100 && (r.height >= 40 || el.scrollHeight >= 40);
  };

  // Fix 4 (denylist): known third-party overlay/widget container patterns
  // that must never be tagged as a real page section — reproduced live on
  // humanmade.com's /work/ (HubSpot chat widget + cookie-consent banner
  // tagged as "sections" right alongside the real content, per
  // 2026-07-13-canai-replicate-transform-task8-followups.md). Checked
  // against BOTH id and each class token (these libraries are inconsistent
  // about which one they set), anchored PER TOKEN — never a raw substring-
  // anywhere search — so a real class that merely CONTAINS one of these
  // words (a recipe site's "chocolate-chip-cookies-section", a
  // "chat-with-us" contact block) is never excluded. Node-side pure parity
  // copy: isThirdPartyWidgetContainer (capture.mjs, exported) — same
  // "can't literally import into an eval'd string" constraint as
  // buildTableModel/etc. above; kept in sync by hand.
  const THIRD_PARTY_WIDGET_TOKEN_RES = [
    /^hs-web-interactives/i,
    /^hubspot-messages-iframe-container$/i,
    /-messages-iframe-container$/i,
    /^cookie-?consent-?banner$/i,
    /^cookie-?banner$/i,
    /^consent-?banner$/i,
    /^intercom-(lightweight-app|container)$/i,
    /^drift-frame-controller$/i,
    /^crisp-client$/i,
    /^tawk-min-container$/i,
    /^grecaptcha-badge$/i,
  ];
  const isThirdPartyWidget = (el) => {
    const tokens = [el.id, ...(typeof el.className === 'string' ? el.className.split(/\s+/) : [])].filter(Boolean);
    return tokens.some(t => THIRD_PARTY_WIDGET_TOKEN_RES.some(re => re.test(t)));
  };

  // --- header
  const headerEl =
    document.querySelector('body > header') ||
    document.querySelector('header[role=banner]') ||
    document.querySelector('[role=banner]') ||
    document.querySelector('header') ||
    (document.querySelector('nav') && document.querySelector('nav').closest('header, .header, #header, [class*="header"]')) ||
    document.querySelector('nav');
  tag(headerEl, 'header', 'header');

  // --- footer
  const footerEl =
    document.querySelector('body > footer') ||
    document.querySelector('footer[role=contentinfo]') ||
    document.querySelector('[role=contentinfo]') ||
    document.querySelector('footer');
  tag(footerEl, 'footer', 'footer');

  // --- main content children
  let main = document.querySelector('main') || document.querySelector('[role=main]');
  if (!main) {
    // No <main> — use body, but skip header/footer when iterating.
    main = document.body;
  }

  const collectChildren = (parent) => Array.from(parent.children).filter(el => {
    if (el === headerEl || el === footerEl) return false;
    if (headerEl && headerEl.contains(el)) return false;
    if (footerEl && footerEl.contains(el)) return false;
    const t = el.tagName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') return false;
    if (isThirdPartyWidget(el)) return false;
    return isVisible(el);
  });

  let kids = collectChildren(main);

  // If everything is wrapped in a single container (common in WP themes:
  // body > #wrapper > .content-wrap > .site-content > #primary > main…),
  // keep drilling through single-child chains until we find a level with
  // multiple visible siblings. Cap depth to avoid descending into a single
  // section's internal structure.
  let depth = 0;
  while (kids.length === 1 && depth < 8) {
    const child = kids[0];
    if (!child.children || child.children.length === 0) break;
    const drilled = collectChildren(child);
    if (drilled.length === 0) break;
    kids = drilled;
    depth += 1;
    if (drilled.length > 1) break;
  }

  // Fix 4 (drill into an oversized hero candidate): the FIRST sizeable kid
  // is about to become 'hero' below — if its own box is already too big to
  // ever actually be screenshotted (exceedsClipLimits — the SAME limits
  // captureNodeScreenshot itself enforces; MAX_CLIP_WIDTH_PX/
  // MAX_CLIP_HEIGHT_PX/MAX_CLIP_AREA_PX2 are interpolated from cdp.mjs at
  // build time below, so this can never drift out of sync with the real
  // guard), drilling into ITS children is more useful than tagging a region
  // we already know will be rejected wholesale — reproduced live on
  // humanmade.com's /work/, where the page's real content sat entirely
  // inside one oversized wrapper the old code tagged whole as 'hero'
  // (rejected wholesale by the clip guard later, instead of finding the
  // real sections inside it). Bounded to a handful of passes (unlike the
  // depth-8 single-child drill above, this only ever replaces the specific
  // oversized candidate with its own children — every OTHER kid in the
  // array is untouched) and re-checked each pass in case the drilled-into
  // children are STILL one oversized wrapper. Node-side pure parity copy:
  // exceedsClipLimits (capture.mjs, exported).
  const exceedsClipLimits = (w, h) =>
    w > 4000 || h > 6000 || (w * h) > 12000000;
  let heroDrillDepth = 0;
  while (kids.length > 0 && heroDrillDepth < 4) {
    const first = kids[0];
    const r = first.getBoundingClientRect();
    const h = Math.max(r.height, first.scrollHeight);
    if (!exceedsClipLimits(r.width, h)) break;
    if (!first.children || first.children.length === 0) break;
    const drilledChildren = collectChildren(first);
    if (drilledChildren.length === 0) break;
    kids = [...drilledChildren, ...kids.slice(1)];
    heroDrillDepth += 1;
  }

  // First sizeable kid → hero. Skip skinny breadcrumb/announcement bars.
  // Decision logic here is a hand-kept-in-sync copy of the exported pure
  // planSectionAssignment (capture.mjs) — see that function's doc comment
  // for the "can't import across the eval boundary" rationale shared by
  // every other _JS constant in this file.
  let heroAssigned = false;
  let sectionIdx = 0;
  for (const el of kids) {
    const r = el.getBoundingClientRect();
    const h = Math.max(r.height, el.scrollHeight);
    if (!heroAssigned && h >= MIN_HEIGHT_HERO) {
      tag(el, 'hero', 'hero');
      heroAssigned = true;
      continue;
    }
    if (h >= MIN_HEIGHT_SECTION) {
      sectionIdx += 1;
      tag(el, 'section-' + sectionIdx, 'section');
    }
  }

  // Fix 3 (last-resort fallback): a theme with no <header>/<footer>/<main>
  // landmarks at all — reproduced live on wpdev.xcloudzen.com's WooCommerce
  // /shop/ (hello-elementor theme; header/footer/main all resolve to null,
  // per 2026-07-13-canai-replicate-capture-followups.md) — can walk away
  // from the loop above having tagged NOTHING: kids came back empty (or
  // every candidate was too small to clear MIN_HEIGHT_HERO/
  // MIN_HEIGHT_SECTION), leaving content.json.main === [] with no signal
  // anywhere that anything went wrong. Tag document.body itself as a single
  // section-1 ONLY when heroAssigned is still false AND not one section got
  // tagged either, so this can never fire on (or duplicate tagging for) a
  // normal page that already found real sections — a true last resort, not
  // a second pass that could ever compete with real tagging.
  if (!heroAssigned && sectionIdx === 0) {
    tag(document.body, 'section-1', 'section');
  }

  return {
    viewport: {
      cssWidth: document.documentElement.clientWidth,
      cssHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      dpr: window.devicePixelRatio || 1,
    },
    sections: tagged,
  };
})();
