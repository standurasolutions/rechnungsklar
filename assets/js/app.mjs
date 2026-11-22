// Gemeinsames Skript: CTA-Experimente (A/B) + cookieloses Event-Tracking (GoatCounter, falls aktiv)
const RK = window.RK || { variants: [] };

export function track(name) {
  try {
    if (window.goatcounter?.count) window.goatcounter.count({ path: name, title: name, event: true });
    else (window.__rkq ||= []).push(name); // nachholen, wenn Skript später lädt
  } catch { /* Tracking darf nie die Seite brechen */ }
}
window.addEventListener('load', () => setTimeout(() => (window.__rkq || []).splice(0).forEach(track), 1500));

// Variante pro Besucher stabil wählen (localStorage ist technisch notwendig für konsistente Darstellung, keine Personenbeziehung)
function pickVariant() {
  const vs = RK.variants || [];
  if (!vs.length) return null;
  let id = null;
  try { id = localStorage.getItem('rk_variant'); } catch {}
  let v = vs.find((x) => x.id === id);
  if (!v) { v = vs[Math.floor(Math.random() * vs.length)]; try { localStorage.setItem('rk_variant', v.id); } catch {} }
  return v;
}

const variant = pickVariant();
document.querySelectorAll('.cta').forEach((box) => {
  const ctx = box.dataset.cta || 'default';
  const textEl = box.querySelector('[data-variant-text]');
  if (variant && textEl) {
    textEl.textContent = variant.text;
    box.dataset.variant = variant.id;
    // Impression erst zählen, wenn die Box wirklich sichtbar war
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { track(`cta-view-${variant.id}`); track(`cta-view-${variant.id}-${ctx}`); io.disconnect(); }
    }, { threshold: 0.5 });
    io.observe(box);
  }
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-track]');
  if (!a) return;
  const box = a.closest('.cta');
  track(`click-${a.dataset.track}`);
  if (box?.dataset.variant) track(`cta-click-${box.dataset.variant}`);
});

export const $ = (sel, root = document) => root.querySelector(sel);
