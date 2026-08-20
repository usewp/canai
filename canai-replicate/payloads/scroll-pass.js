
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const total = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  );
  const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
  for (let y = 0; y < total; y += step) {
    window.scrollTo(0, y);
    await sleep(120);
  }
  window.scrollTo(0, total);
  await sleep(200);
  // Force any native lazy <img> still pending into eager so the bytes arrive
  // before we screenshot per-section.
  document.querySelectorAll('img[loading="lazy"]').forEach(img => {
    img.loading = 'eager';
    if (img.dataset && img.dataset.src && !img.src) img.src = img.dataset.src;
    if (img.dataset && img.dataset.srcset && !img.srcset) img.srcset = img.dataset.srcset;
  });
  await sleep(300);
  window.scrollTo(0, 0);
  await sleep(200);
  return true;
})();
