import { buildXRechnungCII, parseInvoice, validateInvoice, computeTotals, fmtMoney, ibanValid, escapeHtml as e } from './einvoice-core.mjs';
import { renderInvoice, renderFindings } from './render.mjs';
import { track } from './app.mjs';

const root = document.getElementById('generator');
const presets = JSON.parse(document.getElementById('presets')?.textContent || '{}');
const today = new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const STORE = 'rk_seller_v1';

const TAX_OPTS = [
  ['S|19', '19 % USt.'], ['S|7', '7 % USt.'], ['E|0', 'Kleinunternehmer (§ 19)'], ['AE|0', 'Reverse Charge (§ 13b)'], ['K|0', 'Innergem. Lieferung'], ['Z|0', '0 % (Nullsatz)'],
];
const UNITS = [['C62', 'Stück'], ['HUR', 'Stunde'], ['DAY', 'Tag'], ['MON', 'Monat'], ['LS', 'Pauschal'], ['MTK', 'm²'], ['MTR', 'm'], ['KGM', 'kg'], ['LTR', 'Liter'], ['KMT', 'km']];
const TYPES = [['380', 'Rechnung'], ['876', 'Abschlagsrechnung'], ['877', 'Schlussrechnung'], ['326', 'Teilrechnung'], ['384', 'Rechnungskorrektur'], ['381', 'Gutschrift']];

const f = (k, label, { type = 'text', req = false, ph = '', full = false, help = '' } = {}) =>
  `<label class="${full ? 'full' : ''}"><span>${label}${req ? ' *' : ''}</span><input type="${type}" data-k="${k}" ${req ? 'required' : ''} placeholder="${e(ph)}" autocomplete="off">${help ? `<small>${help}</small>` : ''}</label>`;
const sel = (k, label, opts) => `<label><span>${label}</span><select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;

root.innerHTML = `
<form id="gf" class="gen" novalidate>
  <fieldset><legend>1. Rechnung</legend><div class="row">
    ${f('number', 'Rechnungsnummer', { req: true, ph: 'RE-2026-001' })}${sel('typeCode', 'Rechnungsart', TYPES)}
    ${f('issueDate', 'Rechnungsdatum', { type: 'date', req: true })}${f('deliveryDate', 'Leistungsdatum', { type: 'date' })}
    ${f('dueDate', 'Fällig am', { type: 'date' })}${f('buyerReference', 'Käuferreferenz / Leitweg-ID', { req: true, ph: 'z. B. 991-12345-67', help: 'Bei Behörden die Leitweg-ID, bei Firmen die vom Kunden vorgegebene Referenz.' })}
    ${f('orderReference', 'Bestellnummer des Kunden')}
  </div></fieldset>

  <fieldset><legend>2. Ihre Firmendaten</legend><div class="row">
    ${f('seller.name', 'Firmenname', { req: true })}${f('seller.street', 'Straße & Hausnr.', { req: true })}
    ${f('seller.zip', 'PLZ', { req: true })}${f('seller.city', 'Ort', { req: true })}
    ${f('seller.vatId', 'USt-IdNr.', { ph: 'DE123456789' })}${f('seller.taxNumber', 'oder Steuernummer', { ph: '12/345/67890', help: 'Ohne USt-IdNr. wird die Steuernummer auch als Verkäuferkennung (BT-29) verwendet.' })}
    ${f('seller.legalId', 'Handelsregisternummer (optional)', { ph: 'HRB 12345' })}${f('seller.id', 'Ihre Lieferantennummer beim Kunden (optional)')}
    ${f('seller.contactName', 'Ansprechpartner', { req: true })}${f('seller.contactPhone', 'Telefon', { req: true })}
    ${f('seller.contactEmail', 'E-Mail', { type: 'email', req: true, help: 'Wird auch als elektronische Adresse (BT-34) verwendet.' })}
  </div>
  <label class="check"><input type="checkbox" id="remember"> Firmendaten auf diesem Gerät merken <button type="button" class="linkbtn" id="forget">Gespeicherte Daten löschen</button></label>
  </fieldset>

  <fieldset><legend>3. Kunde</legend><div class="row">
    ${f('buyer.name', 'Firmenname / Behörde', { req: true })}${f('buyer.street', 'Straße & Hausnr.', { req: true })}
    ${f('buyer.zip', 'PLZ', { req: true })}${f('buyer.city', 'Ort', { req: true })}
    ${f('buyer.electronicAddress', 'Rechnungs-E-Mail des Kunden', { type: 'email', req: true, help: 'Elektronische Adresse des Käufers (BT-49).' })}${f('buyer.vatId', 'USt-IdNr. des Kunden', { help: 'Pflicht bei Reverse Charge.' })}
  </div></fieldset>

  <fieldset><legend>4. Positionen</legend>
    <div class="preset">Vorlage: <select id="preset"><option value="">– Branche wählen –</option>${Object.entries(presets).map(([k, v]) => `<option value="${k}">${e(v.name)}</option>`).join('')}</select></div>
    <table class="tbl edit"><thead><tr><th>Bezeichnung</th><th>Menge</th><th>Einheit</th><th>Einzelpreis netto</th><th>Steuer</th><th class="r">Netto</th><th></th></tr></thead><tbody id="lines"></tbody></table>
    <button type="button" class="btn ghost" id="addLine">+ Position</button>
  </fieldset>

  <fieldset><legend>5. Zahlung</legend><div class="row">
    ${f('payment.iban', 'IBAN', { req: true, ph: 'DE..' })}${f('payment.bic', 'BIC (optional)')}
    ${f('payment.accountName', 'Kontoinhaber')}${f('prepaid', 'Bereits gezahlt (€)', { type: 'number', help: 'z. B. Abschläge in der Schlussrechnung' })}
    ${f('paymentTerms', 'Zahlungsbedingung', { full: true, ph: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.' })}
    ${f('note', 'Hinweis / Freitext', { full: true })}
  </div></fieldset>

  <div class="sum-bar"><div id="sums"></div><div class="btns"><button type="button" class="btn" id="download">⬇️ XRechnung herunterladen</button><button type="button" class="btn ghost" id="preview">Vorschau / PDF</button></div></div>
  <div id="check"></div>
</form>
<div id="previewOut"></div>`;

const form = document.getElementById('gf');
const linesEl = document.getElementById('lines');
const q = (k) => form.querySelector(`[data-k="${k}"]`);
const setVal = (k, v) => { const x = q(k); if (x && v != null) x.value = v; };

function lineRow(l = { name: '', quantity: 1, unit: 'C62', price: '', taxCategory: 'S', taxRate: 19 }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input data-l="name" value="${e(l.name)}" placeholder="Leistung / Artikel"></td><td><input data-l="quantity" type="number" step="any" value="${l.quantity}"></td>
  <td><select data-l="unit">${UNITS.map(([v, t]) => `<option value="${v}"${v === l.unit ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
  <td><input data-l="price" type="number" step="0.01" value="${l.price}"></td>
  <td><select data-l="tax">${TAX_OPTS.map(([v, t]) => `<option value="${v}"${v === `${l.taxCategory}|${l.taxRate}` ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
  <td class="r" data-l="net"></td><td><button type="button" class="linkbtn" aria-label="Position entfernen">✕</button></td>`;
  tr.querySelector('button').addEventListener('click', () => { tr.remove(); update(); });
  linesEl.appendChild(tr);
}

function collect() {
  const v = (k) => (q(k)?.value || '').trim();
  const lines = [...linesEl.querySelectorAll('tr')].map((tr) => {
    const g = (k) => tr.querySelector(`[data-l="${k}"]`).value;
    const [taxCategory, rate] = g('tax').split('|');
    return { name: g('name').trim(), quantity: parseFloat(g('quantity')) || 0, unit: g('unit'), price: parseFloat(g('price')) || 0, taxCategory, taxRate: Number(rate) };
  }).filter((l) => l.name || l.price);
  return {
    number: v('number'), typeCode: v('typeCode'), issueDate: v('issueDate'), deliveryDate: v('deliveryDate'), dueDate: v('dueDate'),
    buyerReference: v('buyerReference'), orderReference: v('orderReference'), paymentTerms: v('paymentTerms'), notes: [v('note')].filter(Boolean),
    prepaid: parseFloat(v('prepaid')) || 0, currency: 'EUR',
    seller: { name: v('seller.name'), street: v('seller.street'), zip: v('seller.zip'), city: v('seller.city'), country: 'DE', vatId: v('seller.vatId').replace(/\s/g, ''), taxNumber: v('seller.taxNumber'), legalId: v('seller.legalId'), id: v('seller.id'), contactName: v('seller.contactName'), contactPhone: v('seller.contactPhone'), contactEmail: v('seller.contactEmail'), electronicAddress: v('seller.contactEmail') },
    buyer: { name: v('buyer.name'), street: v('buyer.street'), zip: v('buyer.zip'), city: v('buyer.city'), country: 'DE', vatId: v('buyer.vatId').replace(/\s/g, ''), electronicAddress: v('buyer.electronicAddress') },
    payment: { code: '58', iban: v('payment.iban'), bic: v('payment.bic'), accountName: v('payment.accountName') || v('seller.name') },
    lines,
  };
}

function update() {
  const data = collect();
  const { lines, taxes, totals } = computeTotals(data);
  [...linesEl.querySelectorAll('tr')].forEach((tr, i) => { const n = tr.querySelector('[data-l="net"]'); const l = lines[i]; n.textContent = l ? fmtMoney(l.net) : ''; });
  document.getElementById('sums').innerHTML = `Netto <strong>${fmtMoney(totals.lineTotal)}</strong> · USt. <strong>${fmtMoney(totals.taxTotal)}</strong> · Brutto <strong>${fmtMoney(totals.grandTotal)}</strong>${totals.prepaid ? ` · Zahlbetrag <strong>${fmtMoney(totals.due)}</strong>` : ''}`;
  const iban = q('payment.iban');
  iban.classList.toggle('invalid', Boolean(iban.value) && !ibanValid(iban.value));
  if (document.getElementById('remember').checked) saveSeller();
  return { data, taxes };
}

function check() {
  const { data } = update();
  if (!data.paymentTerms && !data.dueDate) data.paymentTerms = 'Zahlbar sofort ohne Abzug.';
  const xml = buildXRechnungCII(data);
  const findings = validateInvoice(parseInvoice(xml));
  document.getElementById('check').innerHTML = renderFindings(findings);
  return { xml, findings, data };
}

// Speichern nur auf ausdrücklichen Wunsch (Checkbox)
const SELLER_KEYS = ['seller.name', 'seller.street', 'seller.zip', 'seller.city', 'seller.vatId', 'seller.taxNumber', 'seller.legalId', 'seller.contactName', 'seller.contactPhone', 'seller.contactEmail', 'payment.iban', 'payment.bic', 'payment.accountName', 'paymentTerms'];
function saveSeller() { try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(SELLER_KEYS.map((k) => [k, q(k).value])))); } catch {} }
function loadSeller() { try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s) { SELLER_KEYS.forEach((k) => setVal(k, s[k])); document.getElementById('remember').checked = true; return true; } } catch {} return false; }
document.getElementById('forget').addEventListener('click', () => { try { localStorage.removeItem(STORE); } catch {} document.getElementById('remember').checked = false; alert('Gespeicherte Firmendaten wurden gelöscht.'); });
document.getElementById('remember').addEventListener('change', (ev) => { if (ev.target.checked) saveSeller(); else try { localStorage.removeItem(STORE); } catch {} });

function applyPreset(slug) {
  const p = presets[slug];
  if (!p) return;
  linesEl.innerHTML = '';
  p.lines.forEach((l) => lineRow(l));
  update();
}

// Init
setVal('issueDate', today); setVal('deliveryDate', today); setVal('dueDate', plusDays(14));
setVal('number', `RE-${today.slice(0, 4)}-001`);
const returning = loadSeller();
const presetSlug = new URLSearchParams(location.search).get('preset');
if (presetSlug && presets[presetSlug]) { document.getElementById('preset').value = presetSlug; applyPreset(presetSlug); track(`preset-${presetSlug}`); } else lineRow();
if (returning) track('generator-returning');

form.addEventListener('input', update);
document.getElementById('addLine').addEventListener('click', () => { lineRow(); update(); });
document.getElementById('preset').addEventListener('change', (ev) => { applyPreset(ev.target.value); track(`preset-${ev.target.value}`); });
document.getElementById('download').addEventListener('click', () => {
  const { xml, findings, data } = check();
  const errs = findings.filter((x) => x.level === 'error');
  if (errs.length && !confirm(`Die Rechnung hat noch ${errs.length} Fehler und würde von Empfängern ggf. abgelehnt. Trotzdem herunterladen?`)) { track('download-blocked'); return; }
  const blob = new Blob([xml], { type: 'application/xml' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `XRechnung_${(data.number || 'rechnung').replace(/[^\w.-]+/g, '_')}.xml` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  track(errs.length ? 'download-with-errors' : 'download-ok');
});
document.getElementById('preview').addEventListener('click', () => {
  const { xml } = check();
  const out = document.getElementById('previewOut');
  out.innerHTML = `<div class="actions noprint"><button class="btn" id="doPrint">🖨️ Drucken / als PDF speichern</button></div>${renderInvoice(parseInvoice(xml))}`;
  document.getElementById('doPrint').addEventListener('click', () => { track('generator-print'); window.print(); });
  out.scrollIntoView({ behavior: 'smooth' });
  track('generator-preview');
});
update();
