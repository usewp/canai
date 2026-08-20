
(() => {
  const found = [];
  const FORM_CONTROL_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
  const add = (pattern, recipe, els) => {
    if (!els || els.length === 0) return;
    // Never count a native form control as a UI pattern instance (e.g. an
    // <input type=range> whose class happens to contain "slider").
    const eligible = els.filter((el) => !FORM_CONTROL_TAGS.has(el.tagName));
    // Collapse to outermost matches only: a decorative descendant (an SVG
    // icon part inside a hamburger button, a single slide inside a
    // carousel) can independently satisfy the same OR'd selector as its own
    // already-matched ancestor — count the component once, not component +
    // every matching descendant.
    const outer = eligible.filter((el) => !eligible.some((other) => other !== el && other.contains(el)));
    if (outer.length === 0) return;
    const el = outer[0];
    found.push({
      pattern, recipe,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: (typeof el.className === "string" ? el.className : "").trim().slice(0, 120) || null,
      count: outer.length,
    });
  };
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  const header = document.querySelector("header, [role=banner]") || document.body;
  const CAROUSEL_SEL = ".slick-slider, .swiper, .splide, .owl-carousel, [class*=carousel], [data-flickity], [class*=slider]";
  // Regions another, more specific detector already owns — a bare
  // [aria-expanded] inside any of these is that detector's internal
  // bookkeeping, not a standalone accordion. Proven live on elementor.com:
  // Swiper marks its OWN current-slide state with aria-expanded
  // (class "swiper-slide step swiper-slide-active" inside a ".swiper"
  // carousel already caught by the carousel detector below) — without this
  // exclusion that reads as a second, false "accordion" match.
  const inChrome = (el) =>
    (header !== document.body && header.contains(el)) || !!el.closest("nav") || !!el.closest(CAROUSEL_SEL);

  // Rendered at THIS viewport right now: own computed display/visibility/
  // opacity, PLUS a bounding-rect check — a hidden ANCESTOR does not change
  // this element's own computed 'display' at all (per spec), so the rect
  // check (zero size whenever the element or an ancestor isn't laid out) is
  // load-bearing, not redundant. Threshold is near-zero (> 0) because this
  // classifies small buttons, not page sections.
  const isRenderedAtViewport = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // nav-toggle vs dropdown-menu: one candidate set, split by desktop
  // visibility (see the fix-list comment above this constant for the full
  // rationale and live proof).
  const headerDisclosureEls = $$(
    "button[aria-expanded], button[aria-controls], .hamburger, .menu-toggle, [class*=burger], [class*=menu-toggle]",
    header,
  );
  const hiddenAtDesktop = headerDisclosureEls.filter((el) => !isRenderedAtViewport(el));
  const visibleAtDesktop = headerDisclosureEls.filter((el) => isRenderedAtViewport(el));

  add("nav toggle (hamburger)", "nav-toggle", hiddenAtDesktop);

  const structuralDropdownEls = $$("nav li > ul, nav li > .sub-menu, nav [class*=dropdown]").map(
    (el) => el.parentElement || el,
  );
  add("dropdown menu", "dropdown-menu", [...visibleAtDesktop, ...structuralDropdownEls]);

  add("tabs", "tabs",
    $$("[role=tablist], .tabs, [class*=tab-list]"));

  add("accordion", "accordion",
    $$("details, [class*=accordion], [class*=collapsible], [aria-expanded]").filter(el => !inChrome(el)));

  add("carousel/slider", "carousel", $$(CAROUSEL_SEL));

  add("modal/dialog", "modal",
    $$("[role=dialog], dialog, .modal, [data-modal], [class*=lightbox]"));

  const hcs = header !== document.body ? getComputedStyle(header) : null;
  if (hcs && (hcs.position === "fixed" || hcs.position === "sticky")) {
    add("sticky header", "sticky-header", [header]);
  }

  return { patterns: found };
})();
