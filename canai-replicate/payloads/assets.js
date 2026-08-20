
(() => {
  const imgs = Array.from(document.images).map(i => i.currentSrc || i.src).filter(Boolean);
  const stylesheets = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l => l.href);
  const scripts = Array.from(document.scripts).map(s => s.src).filter(Boolean);
  let fonts = [];
  try {
    fonts = Array.from(document.fonts).map(f => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
  } catch {}
  return {
    images: Array.from(new Set(imgs)),
    stylesheets,
    scripts,
    fonts,
  };
})();
