import { parseInvoice, validateInvoice, buildXRechnungCII, escapeHtml as e } from './einvoice-core.mjs';
import { renderInvoice, renderFindings } from './render.mjs';
import { track } from './app.mjs';

const drop = document.getElementById('drop');
const input = document.getElementById('file');
const out = document.getElementById('result');
const mode = out.dataset.mode;
const BASE = (window.RK || {}).base || '';

drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } });
drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); if (ev.dataTransfer.files[0]) handle(ev.dataTransfer.files[0]); });
input.addEventListener('change', () => input.files[0] && handle(input.files[0]));
document.getElementById('demo')?.addEventListener('click', () => { track(`demo-${mode}`); show(demoXml(), 'Beispielrechnung.xml'); });

async function handle(file) {
  out.innerHTML = '<p class="small">Wird gelesen…</p>';
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const isPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
    let xml;
    if (isPdf) { xml = await extractFromPdf(buf); track(`open-pdf-${mode}`); }
    else { xml = new TextDecoder('utf-8').decode(buf); track(`open-xml-${mode}`); }
    show(xml, file.name);
  } catch (err) {
    track(`error-${mode}`);
    out.innerHTML = `<div class="findings"><p class="status bad">❌ Datei konnte nicht gelesen werden</p><p>${e(err.message)}</p><p class="small">Tipp: Eine normale PDF-Rechnung ohne eingebettete XML ist keine E-Rechnung. <a href="${BASE}/ratgeber/pdf-ist-keine-e-rechnung/">Warum?</a></p></div>`;
  }
}

async function extractFromPdf(bytes) {
  const pdfjs = await import(`${BASE}/vendor/pdfjs/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}/vendor/pdfjs/pdf.worker.min.mjs`;
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const att = (await pdf.getAttachments()) || {};
  const files = Object.values(att);
  const pick = files.find((f) => /^(factur-x|zugferd-invoice|xrechnung)\.xml$/i.test(f.filename)) || files.find((f) => /\.xml$/i.test(f.filename));
  if (!pick) throw new Error('Diese PDF enthält keine eingebettete E-Rechnung (keine ZUGFeRD/Factur-X-XML gefunden).');
  return new TextDecoder('utf-8').decode(pick.content);
}

function show(xml, name) {
  const inv = parseInvoice(xml);
  const findings = validateInvoice(inv);
  const report = renderFindings(findings);
  const actions = `<div class="actions noprint"><button class="btn" id="print">🖨️ Drucken / als PDF speichern</button><a class="btn ghost" href="${BASE}/xrechnung-erstellen/">Eigene XRechnung erstellen</a></div>`;
  out.innerHTML = `<p class="small noprint">Datei: ${e(name)}</p>${mode === 'check' ? report + actions + renderInvoice(inv) : actions + renderInvoice(inv) + `<details class="noprint" ${findings.some((f) => f.level === 'error') ? 'open' : ''}><summary>Prüfergebnis</summary>${report}</details>`}`;
  document.getElementById('print').addEventListener('click', () => { track(`print-${mode}`); window.print(); });
  track(findings.some((f) => f.level === 'error') ? `result-errors-${mode}` : `result-ok-${mode}`);
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function demoXml() {
  return buildXRechnungCII({
    number: 'RE-2026-1001', typeCode: '380', issueDate: new Date().toISOString().slice(0, 10), deliveryDate: new Date().toISOString().slice(0, 10), dueDate: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
    buyerReference: '991-01234-56', paymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    seller: { name: 'Beispiel Malerbetrieb GmbH', street: 'Farbweg 3', zip: '50667', city: 'Köln', country: 'DE', vatId: 'DE123456789', contactName: 'Anna Beispiel', contactPhone: '+49 221 000000', contactEmail: 'rechnung@maler-beispiel.de', electronicAddress: 'rechnung@maler-beispiel.de' },
    buyer: { name: 'Stadt Musterstadt – Hochbauamt', street: 'Rathausplatz 1', zip: '12345', city: 'Musterstadt', country: 'DE', electronicAddress: 'e-rechnung@musterstadt.de' },
    payment: { code: '58', iban: 'DE89370400440532013000', accountName: 'Beispiel Malerbetrieb GmbH' },
    lines: [{ name: 'Wandflächen streichen, 2-fach', quantity: 120, unit: 'MTK', price: 9.8, taxCategory: 'S', taxRate: 19 }, { name: 'Abdeckarbeiten', quantity: 1, unit: 'LS', price: 180, taxCategory: 'S', taxRate: 19 }],
  });
}
