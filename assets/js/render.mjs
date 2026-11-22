// Rendert eine geparste Rechnung als lesbares, druckbares HTML
import { describeProfile, TYPE_CODES, TAX_CATEGORIES, PAYMENT_CODES, UNIT_CODES, fmtMoney, fmtDate, escapeHtml as e } from './einvoice-core.mjs';

const party = (p, label) => !p ? '' : `<div class="party"><p class="lbl">${label}</p><p><strong>${e(p.name)}</strong>${p.tradingName && p.tradingName !== p.name ? `<br>${e(p.tradingName)}` : ''}<br>${e(p.street)}<br>${e(p.zip)} ${e(p.city)} ${e(p.country)}</p>
<p class="small">${p.vatId ? `USt-IdNr.: ${e(p.vatId)}<br>` : ''}${p.taxNumber ? `Steuernummer: ${e(p.taxNumber)}<br>` : ''}${p.electronicAddress ? `E-Adresse: ${e(p.electronicAddress)}<br>` : ''}${p.contactName ? `Kontakt: ${e(p.contactName)}` : ''}${p.contactPhone ? `, ${e(p.contactPhone)}` : ''}${p.contactEmail ? `, ${e(p.contactEmail)}` : ''}</p></div>`;

export function renderInvoice(inv) {
  const cur = inv.currency;
  const m = (v) => fmtMoney(v, cur);
  const row = (k, v) => (v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');
  return `<div class="invoice" id="invoice">
<div class="inv-head"><div><p class="lbl">${e(TYPE_CODES[inv.typeCode] || 'Rechnung')} ${inv.typeCode ? `(${e(inv.typeCode)})` : ''}</p><h2>Nr. ${e(inv.number)}</h2></div>
<div class="badge">${e(describeProfile(inv.profile))} · ${e(inv.syntax)}</div></div>
<div class="parties">${party(inv.seller, 'Rechnungssteller')}${party(inv.buyer, 'Rechnungsempfänger')}</div>
<table class="meta">${row('Rechnungsdatum', fmtDate(inv.issueDate))}${row('Leistungsdatum', fmtDate(inv.deliveryDate))}${row('Leistungszeitraum', inv.periodStart ? `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` : '')}${row('Fällig am', fmtDate(inv.dueDate))}${row('Käuferreferenz / Leitweg-ID', e(inv.buyerReference))}${row('Bestellnummer', e(inv.orderReference))}${row('Vertrag', e(inv.contractReference))}</table>
<table class="tbl lines"><thead><tr><th>#</th><th>Bezeichnung</th><th class="r">Menge</th><th class="r">Einzelpreis</th><th class="r">USt.</th><th class="r">Netto</th></tr></thead><tbody>
${inv.lines.map((l) => `<tr><td>${e(l.id)}</td><td>${e(l.name)}${l.description ? `<br><span class="small">${e(l.description)}</span>` : ''}</td><td class="r">${l.quantity ?? ''} ${e(UNIT_CODES[l.unit] || l.unit)}</td><td class="r">${m(l.price)}</td><td class="r">${l.taxCategory === 'S' ? `${l.taxRate} %` : e(l.taxCategory)}</td><td class="r">${m(l.net)}</td></tr>`).join('')}
</tbody></table>
${inv.allowanceCharges.length ? `<p class="small">${inv.allowanceCharges.map((a) => `${a.isCharge ? 'Zuschlag' : 'Nachlass'}: ${e(a.reason)} ${m(a.amount)}`).join(' · ')}</p>` : ''}
<table class="totals">
<tr><th>Summe netto</th><td>${m(inv.totals.lineTotal)}</td></tr>
${inv.totals.allowanceTotal ? `<tr><th>Nachlässe</th><td>− ${m(inv.totals.allowanceTotal)}</td></tr>` : ''}${inv.totals.chargeTotal ? `<tr><th>Zuschläge</th><td>${m(inv.totals.chargeTotal)}</td></tr>` : ''}
${inv.taxes.map((x) => `<tr><th>${x.category === 'S' ? `USt. ${x.rate} % auf ${m(x.basis)}` : `${e(TAX_CATEGORIES[x.category] || x.category)}${x.exemptionReason ? ` – ${e(x.exemptionReason)}` : ''}`}</th><td>${m(x.amount)}</td></tr>`).join('')}
<tr class="grand"><th>Gesamtbetrag</th><td>${m(inv.totals.grandTotal)}</td></tr>
${inv.totals.prepaid ? `<tr><th>Bereits gezahlt</th><td>− ${m(inv.totals.prepaid)}</td></tr>` : ''}
<tr class="grand"><th>Zahlbetrag</th><td>${m(inv.totals.due)}</td></tr></table>
<div class="pay"><p class="lbl">Zahlung</p>${inv.payment.map((p) => `<p>${e(PAYMENT_CODES[p.code] || `Code ${p.code}`)}${p.iban ? ` · IBAN ${e(p.iban.replace(/(.{4})/g, '$1 ').trim())}` : ''}${p.bic ? ` · BIC ${e(p.bic)}` : ''}${p.accountName ? ` · ${e(p.accountName)}` : ''}</p>`).join('')}
${inv.paymentReference ? `<p>Verwendungszweck: ${e(inv.paymentReference)}</p>` : ''}${inv.paymentTerms ? `<p>${e(inv.paymentTerms)}</p>` : ''}</div>
${inv.notes.length ? `<div class="notes"><p class="lbl">Hinweise</p>${inv.notes.map((n) => `<p>${e(n)}</p>`).join('')}</div>` : ''}
</div>`;
}

export function renderFindings(findings) {
  const errs = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warning').length;
  const head = errs ? `<p class="status bad">❌ ${errs} Fehler${warns ? `, ${warns} Hinweis${warns > 1 ? 'e' : ''}` : ''} gefunden</p>` : warns ? `<p class="status warn">⚠️ Keine Fehler, ${warns} Hinweis${warns > 1 ? 'e' : ''}</p>` : '<p class="status ok">✅ Keine Fehler in den geprüften Regeln</p>';
  return `<div class="findings">${head}<ul>${findings.filter((f) => f.level !== 'info').map((f) => `<li class="${f.level}"><code>${e(f.rule)}</code> ${e(f.message)}</li>`).join('')}</ul><p class="small">Geprüft werden Pflichtfelder, Rechenregeln, Steuerangaben und IBAN (Teilmenge der EN 16931/XRechnung-Regeln). Verbindlich ist der offizielle KoSIT-Validator.</p></div>`;
}
