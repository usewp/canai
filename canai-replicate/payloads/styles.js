
(() => {
  const maps = {
    fonts: new Map(), textColors: new Map(), bgColors: new Map(),
    borderColors: new Map(), fontSizes: new Map(), radii: new Map(),
    shadows: new Map(), spacing: new Map(),
  };
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  let count = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (count > 4000) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    count++;
    bump(maps.fonts, cs.fontFamily);
    bump(maps.textColors, cs.color);
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") bump(maps.bgColors, cs.backgroundColor);
    if (cs.borderTopWidth !== "0px") bump(maps.borderColors, cs.borderTopColor);
    bump(maps.fontSizes, cs.fontSize + "/" + cs.fontWeight);
    if (cs.borderRadius !== "0px") bump(maps.radii, cs.borderRadius);
    if (cs.boxShadow !== "none") bump(maps.shadows, cs.boxShadow);
    for (const k of ["marginTop", "marginBottom", "paddingTop", "paddingBottom"]) {
      if (cs[k] !== "0px") bump(maps.spacing, cs[k]);
    }
  }
  const top = (map, n) => [...map.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([value, uses]) => ({ value, uses }));

  // --- Role-based tokens (Fix 4) -----------------------------------------
  const roleStyle = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    return {
      tag: el.tagName.toLowerCase(),
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      letterSpacing: cs.letterSpacing,
      textDecorationLine: cs.textDecorationLine,
    };
  };

  // Distinct style combos observed among `els` (capped so a pathological
  // page can't blow up runtime), sorted most-used first. A role with
  // essentially one real element (h1, body) naturally comes back as a
  // single-entry list; a role with many (a, button) surfaces every distinct
  // look those elements take instead of just whichever one is first in the
  // DOM.
  const distinctByStyle = (els, limit) => {
    const seen = new Map();
    let n = 0;
    for (const el of els) {
      if (n++ > 3000) break;
      const s = roleStyle(el);
      if (!s) continue;
      const key = JSON.stringify(s);
      const existing = seen.get(key);
      if (existing) existing.uses++;
      else seen.set(key, { ...s, uses: 1 });
    }
    return [...seen.values()].sort((a, b) => b.uses - a.uses).slice(0, limit);
  };

  const headings = {};
  for (const lvl of [1, 2, 3, 4, 5, 6]) {
    headings["h" + lvl] = distinctByStyle(document.querySelectorAll("h" + lvl), 4);
  }

  const links = distinctByStyle(document.querySelectorAll("a"), 8);

  const buttonSelector =
    "button, [role=button], input[type=submit], input[type=button], " +
    "a.button, a.btn, [class*='btn'], [class*='button']";
  const buttons = distinctByStyle(document.querySelectorAll(buttonSelector), 10);

  // Normalize ANY valid CSS color string to sRGB 0-255 bytes via a 1x1
  // canvas — Canvas2D's fillStyle accepts everything getComputedStyle can
  // return (rgb(), hsl(), named colors, hex, and modern wide-gamut
  // lab()/oklab()/oklch()/color() notations), so this works regardless of
  // which one the page (and this Chrome version) happens to serialize in.
  // Needed live: on tailwindcss.com getComputedStyle returns colors as
  // "lab(...)"/"oklab(...)", not "rgb(...)" — a regex expecting "rgb(...)"
  // found zero matches among its buttons, silently returning no accent-guess
  // candidate at all on exactly the kind of modern site this block exists
  // for. Returns null for fully-transparent OR unparseable input — see the
  // sentinel check below for how "unparseable" is actually detected (Task
  // 4d, Finding 3): Canvas2D SILENTLY IGNORES an unparseable fillStyle
  // assignment (the property just keeps its previous value rather than
  // throwing, per spec), and this context is reused across calls, so
  // without that check an invalid colorStr would make this function return
  // the PREVIOUS call's color instead of null, contradicting this comment.
  let __satCanvas = null;
  const toRgbBytes = (colorStr) => {
    if (!colorStr) return null;
    try {
      if (!__satCanvas) {
        __satCanvas = document.createElement("canvas");
        __satCanvas.width = 1;
        __satCanvas.height = 1;
      }
      const ctx = __satCanvas.getContext("2d");
      // Force a known sentinel immediately before the real assignment, then
      // read fillStyle back after attempting it: if the getter still echoes
      // the sentinel, colorStr was rejected outright (a no-op assignment),
      // not merely resolved to some color that happens to look like the
      // sentinel. Parity copy of the Node-side `fillStyleWasAccepted`
      // (capture.mjs) — kept in sync by hand, same "can't import across the
      // eval boundary" constraint as accentScore/accentScoreOf below.
      const SENTINEL = "rgb(1, 2, 3)";
      ctx.fillStyle = SENTINEL;
      const sentinelEcho = ctx.fillStyle;
      ctx.fillStyle = colorStr;
      if (ctx.fillStyle === sentinelEcho) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? null : { r, g, b, a };
    } catch {
      return null;
    }
  };

  // "Accent score" (0..1) of an sRGB+alpha pixel — a pure parity copy of
  // capture.mjs's exported `accentScore` (kept in sync by hand; this string
  // runs inside the captured page via eval with zero dependencies, so it
  // can't literally import that). Used only to guess which button is the
  // brand-accent CTA when no class name gives it away: a colorful, opaque
  // fill among mostly neutral (gray/white/black) buttons is a good proxy for
  // "the primary action". Deliberately raw channel spread (chroma) scaled by
  // opacity, NOT full HSL saturation — verified live on tailwindcss.com: a
  // near-black button background with only a sub-pixel-scale color tint
  // (oklab lightness 0.13, canvas-normalizes to rgb(0,0,20)) scores HSL
  // saturation a full 1.0 (HSL saturation is numerically unstable at extreme
  // lightness), indistinguishable by that formula from the page's actual
  // vivid, fully-opaque CTA — and would have won the accent guess by
  // accident. Weighting by alpha additionally keeps a barely-visible
  // 5%-opacity tinted hover overlay from outranking a fully opaque,
  // moderately colorful real button background.
  const accentScoreOf = (rgb) => {
    if (!rgb) return 0;
    const chroma = (Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b)) / 255;
    return chroma * (rgb.a / 255);
  };
  // Below this, treat it as "no real accent found" rather than confidently
  // reporting a barely-tinted near-neutral button as the primary CTA.
  const MIN_ACCENT_SCORE = 0.15;

  const primarySelector =
    ".btn-primary, .button-primary, button.primary, .primary-button, .btn--primary, " +
    "[class*='btnPrimary'], [class*='ButtonPrimary'], [class*='cta-primary'], [class*='CtaPrimary'], .cta";
  const primaryClassStyle = roleStyle(document.querySelector(primarySelector));
  let primaryButton = primaryClassStyle ? { ...primaryClassStyle, source: "class-match" } : null;
  if (!primaryButton) {
    let best = null, bestScore = 0;
    for (const b of buttons) {
      const score = accentScoreOf(toRgbBytes(b.backgroundColor));
      if (score > bestScore) { bestScore = score; best = b; }
    }
    primaryButton = best && bestScore >= MIN_ACCENT_SCORE ? { ...best, source: "accent-guess" } : null;
  }

  const body = roleStyle(document.querySelector("body"));

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    fonts: top(maps.fonts, 6),
    textColors: top(maps.textColors, 12),
    bgColors: top(maps.bgColors, 12),
    borderColors: top(maps.borderColors, 8),
    fontSizes: top(maps.fontSizes, 16),
    radii: top(maps.radii, 8),
    shadows: top(maps.shadows, 6),
    spacing: top(maps.spacing, 16),
    roles: { headings, links, buttons, primaryButton, body },
  };
})();
