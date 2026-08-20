
(() => {
  const css = `
    *, *::before, *::after {
      transition: none !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-fill-mode: forwards !important;
    }
    [data-aos], .aos-init, .wow, .reveal, .revealed, .fade-in, .fade-up,
    .fade-down, .fade-left, .fade-right, .animate-on-scroll, .scroll-animate,
    .sr-only-reveal, [class*="fade-"], [class*="slide-"], [class*="zoom-"],
    [class*="reveal-"], [data-scroll], [data-animate] {
      opacity: 1 !important;
      transform: none !important;
      visibility: visible !important;
      filter: none !important;
    }
  `;
  const style = document.createElement('style');
  style.setAttribute('data-reveal-override', '1');
  style.textContent = css;
  document.head.appendChild(style);

  // Mark AOS / WOW elements as already-animated so their own classes apply
  // the "shown" state.
  document.querySelectorAll('[data-aos]').forEach(el => el.classList.add('aos-animate'));
  document.querySelectorAll('.wow').forEach(el => {
    el.classList.add('animated', 'visible');
    el.style.visibility = 'visible';
  });

  // Strip inline hidden styles that JS observers commonly set.
  document.querySelectorAll('[style]').forEach(el => {
    const s = el.style;
    if (s.opacity && parseFloat(s.opacity) < 1) s.opacity = '';
    if (s.transform && s.transform !== 'none') s.transform = '';
    if (s.visibility === 'hidden') s.visibility = '';
  });

  return true;
})();
