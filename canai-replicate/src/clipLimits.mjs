// Clip-size safety limits.
//
// These outlive cdp.mjs, which defined them until 4.0.0. A single-wrapper
// layout (common in some React/Vue app shells) can get its entire page tagged
// as one giant "hero"; refusing an absurd clip up front is what turns that
// into a clear, recorded error instead of a hung capture run.
//
// Two consumers depend on them agreeing exactly: exceedsClipLimits() in
// capture.mjs, and the same check compiled into payloads/sections.js — where
// the numbers are baked in as literals rather than imported, because that file
// runs in the browser and cannot import anything from Node. If you change a
// limit here, re-bake sections.js or the two will silently disagree.
export const MAX_CLIP_WIDTH_PX = 4000;
export const MAX_CLIP_HEIGHT_PX = 6000;
export const MAX_CLIP_AREA_PX2 = 12_000_000;
