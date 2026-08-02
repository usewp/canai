// Advisory detection of third-party animation/slider libraries on a captured
// page. Output feeds libs.json — hints for Alpine recipe choice, NOT
// permission to CDN-include detected libraries.

export const KNOWN_LIBS = [
  "swiper",
  "slick",
  "splide",
  "owl",
  "flickity",
  "aos",
  "gsap",
  "anime",
  "lottie",
  "wow",
];

export const LIBS_ADVISORY =
  "Page mode must reproduce UX via Alpine recipes only; do not CDN-include detected third-party libraries.";

function containsLib(haystack, name) {
  return String(haystack ?? "").toLowerCase().includes(name.toLowerCase());
}

export function detectLibs({
  scriptUrls = [],
  stylesheetUrls = [],
  classNames = [],
  html = "",
} = {}) {
  const found = new Map();

  function note(name, evidence) {
    if (!found.has(name)) found.set(name, []);
    found.get(name).push(evidence);
  }

  for (const name of KNOWN_LIBS) {
    for (const url of scriptUrls) {
      if (containsLib(url, name)) note(name, `script: ${url}`);
    }
    for (const url of stylesheetUrls) {
      if (containsLib(url, name)) note(name, `stylesheet: ${url}`);
    }
    for (const cls of classNames) {
      if (containsLib(cls, name)) note(name, `class: ${cls}`);
    }
    if (html && containsLib(html, name)) note(name, "html");
  }

  const libraries = [...found.entries()]
    .map(([name, evidence]) => ({ name, evidence }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { libraries, advisory: LIBS_ADVISORY };
}
