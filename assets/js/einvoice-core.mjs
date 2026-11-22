// Rechnungsklar – E-Rechnung Kernbibliothek (läuft im Browser UND in Node, keine Abhängigkeiten)
// - parseXml: kleiner, robuster XML-Parser (namespace-agnostisch über lokale Namen)
// - parseInvoice: liest XRechnung/EN16931 in UBL (Invoice/CreditNote) und CII (ZUGFeRD/Factur-X/XRechnung)
// - buildXRechnungCII: erzeugt XRechnung 3.0 (CII-Syntax)
// - validateInvoice: Plausibilitäts- und Pflichtfeldprüfung (Teilmenge der EN16931/XRechnung-Regeln)

// ---------------------------------------------------------------- XML-Parser
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(xml) {
  if (typeof xml !== 'string') throw new Error('XML muss ein String sein');
  xml = xml.replace(/^﻿/, '');
  const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) { stack.at(-1).text += decodeEntities(xml.slice(i)); break; }
    if (lt > i) stack.at(-1).text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); if (e < 0) throw new Error('Unbeendeter Kommentar'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt); if (e < 0) throw new Error('Unbeendeter CDATA-Block'); stack.at(-1).text += xml.slice(lt + 9, e); i = e + 3; continue; }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt); if (e < 0) throw new Error('Unbeendete Processing-Instruction'); i = e + 2; continue; }
    if (xml.startsWith('<!', lt)) { // DOCTYPE o.ä. (ohne interne Subsets mit '>')
      let depth = 0, j = lt;
      for (; j < n; j++) { if (xml[j] === '[') depth++; else if (xml[j] === ']') depth--; else if (xml[j] === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (xml[lt + 1] === '/') {
      const e = xml.indexOf('>', lt);
      if (e < 0) throw new Error('Unbeendetes End-Tag');
      const name = xml.slice(lt + 2, e).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`Ungültiges XML: </${name}> passt nicht zu <${top?.name}>`);
      i = e + 1; continue;
    }
    // Start-Tag: Attributwerte dürfen '>' enthalten
    let j = lt + 1, quote = null;
    for (; j < n; j++) {
      const c = xml[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) throw new Error('Unbeendetes Start-Tag');
    let inner = xml.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const m = inner.match(/^([^\s/>]+)/);
    if (!m) throw new Error('Ungültiges Tag');
    const name = m[1];
    const attrs = {};
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    const rest = inner.slice(name.length);
    while ((a = re.exec(rest))) attrs[localName(a[1])] = decodeEntities(a[3] ?? a[4] ?? '');
    const node = { name, local: localName(name), attrs, children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
    i = j + 1;
  }
  if (stack.length !== 1) throw new Error(`Ungültiges XML: <${stack.at(-1).name}> wurde nicht geschlossen`);
  const docEl = root.children[0];
  if (!docEl) throw new Error('Leeres XML-Dokument');
  return docEl;
}
function localName(n) { const k = n.indexOf(':'); return k === -1 ? n : n.slice(k + 1); }

// Pfad-Helfer über lokale Namen: 'A/B/C'
export function q(node, path) {
  if (!node) return null;
  let cur = [node];
  for (const part of path.split('/')) {
    const next = [];
    for (const c of cur) for (const ch of c.children) if (ch.local === part) next.push(ch);
    if (!next.length) return null;
    cur = next;
  }
  return cur[0];
}
export function qa(node, path) {
  if (!node) return [];
  let cur = [node];
  for (const part of path.split('/')) {
    const next = [];
    for (const c of cur) for (const ch of c.children) if (ch.local === part) next.push(ch);
    cur = next;
  }
  return cur;
}
const t = (node, path) => { const x = path ? q(node, path) : node; return x ? x.text.trim() : ''; };
const num = (s) => { if (s === '' || s == null) return null; const v = Number(String(s).trim()); return Number.isFinite(v) ? v : null; };

// ---------------------------------------------------------------- Lesen
export function detectSyntax(doc) {
  if (doc.local === 'CrossIndustryInvoice') return 'CII';
  if (doc.local === 'Invoice') return 'UBL';
  if (doc.local === 'CreditNote') return 'UBL-CreditNote';
  if (doc.local === 'SCRDMCCBDACIOMessageStructure' || doc.local === 'CrossIndustryDocument') return 'ZUGFeRD1';
  return 'unbekannt';
}

function ciiDate(node) {
  const s = t(node, 'DateTimeString');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function ciiParty(p) {
  if (!p) return null;
  const addr = q(p, 'PostalTradeAddress');
  const taxRegs = qa(p, 'SpecifiedTaxRegistration').map((r) => ({ scheme: q(r, 'ID')?.attrs.schemeID || '', id: t(r, 'ID') }));
  const contact = q(p, 'DefinedTradeContact');
  return {
    name: t(p, 'Name'),
    id: t(p, 'ID'),
    legalId: t(p, 'SpecifiedLegalOrganization/ID'),
    tradingName: t(p, 'SpecifiedLegalOrganization/TradingBusinessName'),
    street: [t(addr, 'LineOne'), t(addr, 'LineTwo'), t(addr, 'LineThree')].filter(Boolean).join(', '),
    zip: t(addr, 'PostcodeCode'),
    city: t(addr, 'CityName'),
    country: t(addr, 'CountryID'),
    vatId: taxRegs.find((r) => r.scheme === 'VA')?.id || '',
    taxNumber: taxRegs.find((r) => r.scheme === 'FC')?.id || '',
    electronicAddress: t(p, 'URIUniversalCommunication/URIID'),
    contactName: t(contact, 'PersonName'),
    contactPhone: t(contact, 'TelephoneUniversalCommunication/CompleteNumber'),
    contactEmail: t(contact, 'EmailURIUniversalCommunication/URIID'),
  };
}

function parseCII(doc) {
  const ed = q(doc, 'ExchangedDocument');
  const tx = q(doc, 'SupplyChainTradeTransaction');
  const agr = q(tx, 'ApplicableHeaderTradeAgreement');
  const del = q(tx, 'ApplicableHeaderTradeDelivery');
  const set = q(tx, 'ApplicableHeaderTradeSettlement');
  const sum = q(set, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const currency = t(set, 'InvoiceCurrencyCode') || 'EUR';
  const taxTotals = qa(sum, 'TaxTotalAmount');
  const taxTotal = taxTotals.find((x) => !x.attrs.currencyID || x.attrs.currencyID === currency) || taxTotals[0];
  const pm = qa(set, 'SpecifiedTradeSettlementPaymentMeans');
  const terms = q(set, 'SpecifiedTradePaymentTerms');
  return {
    syntax: 'CII',
    profile: t(doc, 'ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID'),
    number: t(ed, 'ID'),
    typeCode: t(ed, 'TypeCode'),
    issueDate: ciiDate(q(ed, 'IssueDateTime')),
    notes: qa(ed, 'IncludedNote').map((nn) => t(nn, 'Content')).filter(Boolean),
    currency,
    buyerReference: t(agr, 'BuyerReference'),
    orderReference: t(agr, 'BuyerOrderReferencedDocument/IssuerAssignedID'),
    contractReference: t(agr, 'ContractReferencedDocument/IssuerAssignedID'),
    seller: ciiParty(q(agr, 'SellerTradeParty')),
    buyer: ciiParty(q(agr, 'BuyerTradeParty')),
    deliveryDate: ciiDate(q(del, 'ActualDeliverySupplyChainEvent/OccurrenceDateTime')),
    periodStart: ciiDate(q(set, 'BillingSpecifiedPeriod/StartDateTime')),
    periodEnd: ciiDate(q(set, 'BillingSpecifiedPeriod/EndDateTime')),
    paymentReference: t(set, 'PaymentReference'),
    payment: pm.map((p) => ({
      code: t(p, 'TypeCode'),
      info: t(p, 'Information'),
      iban: t(p, 'PayeePartyCreditorFinancialAccount/IBANID'),
      accountName: t(p, 'PayeePartyCreditorFinancialAccount/AccountName'),
      bic: t(p, 'PayeeSpecifiedCreditorFinancialInstitution/BICID'),
    })),
    paymentTerms: t(terms, 'Description'),
    dueDate: ciiDate(q(terms, 'DueDateDateTime')),
    lines: qa(tx, 'IncludedSupplyChainTradeLineItem').map((li) => {
      const qty = q(li, 'SpecifiedLineTradeDelivery/BilledQuantity');
      const lt = q(li, 'SpecifiedLineTradeSettlement/ApplicableTradeTax');
      return {
        id: t(li, 'AssociatedDocumentLineDocument/LineID'),
        name: t(li, 'SpecifiedTradeProduct/Name'),
        description: t(li, 'SpecifiedTradeProduct/Description'),
        quantity: num(t(qty)),
        unit: qty?.attrs.unitCode || '',
        price: num(t(li, 'SpecifiedLineTradeAgreement/NetPriceProductTradePrice/ChargeAmount')),
        priceBaseQty: num(t(li, 'SpecifiedLineTradeAgreement/NetPriceProductTradePrice/BasisQuantity')),
        taxCategory: t(lt, 'CategoryCode'),
        taxRate: num(t(lt, 'RateApplicablePercent')),
        net: num(t(li, 'SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount')),
      };
    }),
    taxes: qa(set, 'ApplicableTradeTax').map((x) => ({
      category: t(x, 'CategoryCode'),
      rate: num(t(x, 'RateApplicablePercent')),
      basis: num(t(x, 'BasisAmount')),
      amount: num(t(x, 'CalculatedAmount')),
      exemptionReason: t(x, 'ExemptionReason'),
    })),
    allowanceCharges: qa(set, 'SpecifiedTradeAllowanceCharge').map((x) => ({
      isCharge: t(x, 'ChargeIndicator/Indicator') === 'true',
      amount: num(t(x, 'ActualAmount')),
      reason: t(x, 'Reason'),
    })),
    totals: {
      lineTotal: num(t(sum, 'LineTotalAmount')),
      chargeTotal: num(t(sum, 'ChargeTotalAmount')),
      allowanceTotal: num(t(sum, 'AllowanceTotalAmount')),
      taxBasis: num(t(sum, 'TaxBasisTotalAmount')),
      taxTotal: num(t(taxTotal)),
      grandTotal: num(t(sum, 'GrandTotalAmount')),
      prepaid: num(t(sum, 'TotalPrepaidAmount')),
      rounding: num(t(sum, 'RoundingAmount')),
      due: num(t(sum, 'DuePayableAmount')),
    },
  };
}

function ublParty(p) {
  if (!p) return null;
  const party = q(p, 'Party');
  const addr = q(party, 'PostalAddress');
  const schemes = qa(party, 'PartyTaxScheme').map((s) => ({ id: t(s, 'CompanyID'), scheme: t(s, 'TaxScheme/ID') }));
  const contact = q(party, 'Contact');
  return {
    name: t(party, 'PartyLegalEntity/RegistrationName') || t(party, 'PartyName/Name'),
    tradingName: t(party, 'PartyName/Name'),
    id: t(party, 'PartyIdentification/ID'),
    legalId: t(party, 'PartyLegalEntity/CompanyID'),
    street: [t(addr, 'StreetName'), t(addr, 'AdditionalStreetName'), t(addr, 'AddressLine/Line')].filter(Boolean).join(', '),
    zip: t(addr, 'PostalZone'),
    city: t(addr, 'CityName'),
    country: t(addr, 'Country/IdentificationCode'),
    vatId: schemes.find((s) => s.scheme === 'VAT')?.id || '',
    taxNumber: schemes.find((s) => s.scheme && s.scheme !== 'VAT')?.id || '',
    electronicAddress: t(party, 'EndpointID'),
    contactName: t(contact, 'Name'),
    contactPhone: t(contact, 'Telephone'),
    contactEmail: t(contact, 'ElectronicMail'),
  };
}

function parseUBL(doc) {
  const credit = doc.local === 'CreditNote';
  const lm = q(doc, 'LegalMonetaryTotal');
  const currency = t(doc, 'DocumentCurrencyCode') || 'EUR';
  const taxTotals = qa(doc, 'TaxTotal');
  const mainTax = taxTotals.find((x) => q(x, 'TaxAmount')?.attrs.currencyID === currency) || taxTotals[0];
  return {
    syntax: credit ? 'UBL-CreditNote' : 'UBL',
    profile: t(doc, 'CustomizationID'),
    number: t(doc, 'ID'),
    typeCode: t(doc, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'),
    issueDate: t(doc, 'IssueDate'),
    notes: qa(doc, 'Note').map((x) => t(x)).filter(Boolean),
    currency,
    buyerReference: t(doc, 'BuyerReference'),
    orderReference: t(doc, 'OrderReference/ID'),
    contractReference: t(doc, 'ContractDocumentReference/ID'),
    seller: ublParty(q(doc, 'AccountingSupplierParty')),
    buyer: ublParty(q(doc, 'AccountingCustomerParty')),
    deliveryDate: t(doc, 'Delivery/ActualDeliveryDate'),
    periodStart: t(doc, 'InvoicePeriod/StartDate'),
    periodEnd: t(doc, 'InvoicePeriod/EndDate'),
    paymentReference: t(doc, 'PaymentMeans/PaymentID'),
    payment: qa(doc, 'PaymentMeans').map((p) => ({
      code: t(p, 'PaymentMeansCode'),
      info: '',
      iban: t(p, 'PayeeFinancialAccount/ID'),
      accountName: t(p, 'PayeeFinancialAccount/Name'),
      bic: t(p, 'PayeeFinancialAccount/FinancialInstitutionBranch/ID'),
    })),
    paymentTerms: t(doc, 'PaymentTerms/Note'),
    dueDate: t(doc, 'DueDate') || t(doc, 'PaymentMeans/PaymentDueDate'),
    lines: qa(doc, credit ? 'CreditNoteLine' : 'InvoiceLine').map((li) => {
      const qty = q(li, credit ? 'CreditedQuantity' : 'InvoicedQuantity');
      return {
        id: t(li, 'ID'),
        name: t(li, 'Item/Name'),
        description: t(li, 'Item/Description'),
        quantity: num(t(qty)),
        unit: qty?.attrs.unitCode || '',
        price: num(t(li, 'Price/PriceAmount')),
        priceBaseQty: num(t(li, 'Price/BaseQuantity')),
        taxCategory: t(li, 'Item/ClassifiedTaxCategory/ID'),
        taxRate: num(t(li, 'Item/ClassifiedTaxCategory/Percent')),
        net: num(t(li, 'LineExtensionAmount')),
      };
    }),
    taxes: qa(mainTax, 'TaxSubtotal').map((x) => ({
      category: t(x, 'TaxCategory/ID'),
      rate: num(t(x, 'TaxCategory/Percent')),
      basis: num(t(x, 'TaxableAmount')),
      amount: num(t(x, 'TaxAmount')),
      exemptionReason: t(x, 'TaxCategory/TaxExemptionReason'),
    })),
    allowanceCharges: qa(doc, 'AllowanceCharge').map((x) => ({
      isCharge: t(x, 'ChargeIndicator') === 'true',
      amount: num(t(x, 'Amount')),
      reason: t(x, 'AllowanceChargeReason'),
    })),
    totals: {
      lineTotal: num(t(lm, 'LineExtensionAmount')),
      chargeTotal: num(t(lm, 'ChargeTotalAmount')),
      allowanceTotal: num(t(lm, 'AllowanceTotalAmount')),
      taxBasis: num(t(lm, 'TaxExclusiveAmount')),
      taxTotal: num(t(mainTax, 'TaxAmount')),
      grandTotal: num(t(lm, 'TaxInclusiveAmount')),
      prepaid: num(t(lm, 'PrepaidAmount')),
      rounding: num(t(lm, 'PayableRoundingAmount')),
      due: num(t(lm, 'PayableAmount')),
    },
  };
}

export function parseInvoice(xmlString) {
  const doc = parseXml(xmlString);
  const syntax = detectSyntax(doc);
  if (syntax === 'CII') return parseCII(doc);
  if (syntax === 'UBL' || syntax === 'UBL-CreditNote') return parseUBL(doc);
  if (syntax === 'ZUGFeRD1') throw new Error('ZUGFeRD 1.0 wird nicht unterstützt (veraltet, gilt nicht als E-Rechnung nach §14 UStG).');
  throw new Error(`Unbekanntes Format: Wurzelelement <${doc.name}>. Erwartet: XRechnung/ZUGFeRD (CrossIndustryInvoice) oder UBL (Invoice/CreditNote).`);
}

export function describeProfile(profile) {
  const p = (profile || '').toLowerCase();
  if (p.includes('xrechnung')) { const v = p.match(/xrechnung_(\d+\.\d+)/); return `XRechnung${v ? ' ' + v[1] : ''}`; }
  if (p.includes('extended')) return 'ZUGFeRD/Factur-X EXTENDED';
  if (p.includes('basicwl') || p.includes('basic-wl')) return 'ZUGFeRD/Factur-X BASIC WL (keine vollwertige E-Rechnung)';
  if (p.includes('minimum')) return 'ZUGFeRD/Factur-X MINIMUM (keine vollwertige E-Rechnung)';
  if (p.includes('basic')) return 'ZUGFeRD/Factur-X BASIC';
  if (p.includes('peppol')) return 'Peppol BIS Billing 3.0';
  if (p.includes('en16931')) return 'EN 16931 (COMFORT)';
  return profile || 'unbekannt';
}

export const TYPE_CODES = { '380': 'Rechnung', '381': 'Gutschrift', '384': 'Rechnungskorrektur', '389': 'Selbst ausgestellte Rechnung (Gutschriftverfahren)', '326': 'Teilrechnung', '875': 'Teilschlussrechnung', '876': 'Abschlagsrechnung', '877': 'Schlussrechnung', '751': 'Rechnungsinformation' };
export const TAX_CATEGORIES = { S: 'Regelsteuersatz', Z: 'Nullsatz', E: 'Steuerbefreit', AE: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)', K: 'Innergemeinschaftliche Lieferung', G: 'Ausfuhr (Drittland)', O: 'Nicht steuerbar', L: 'Kanarische Inseln', M: 'Ceuta/Melilla' };
export const PAYMENT_CODES = { '10': 'Bar', '30': 'Überweisung', '31': 'Überweisung', '42': 'Zahlung auf Bankkonto', '48': 'Kartenzahlung', '49': 'Lastschrift', '57': 'Dauerauftrag', '58': 'SEPA-Überweisung', '59': 'SEPA-Lastschrift', '97': 'Verrechnung', '1': 'Nicht definiert', ZZZ: 'Sonstiges' };
export const UNIT_CODES = { C62: 'Stück', H87: 'Stück', HUR: 'Std.', DAY: 'Tag', MON: 'Monat', ANN: 'Jahr', MIN: 'Min.', KGM: 'kg', MTR: 'm', MTK: 'm²', MTQ: 'm³', LTR: 'l', KMT: 'km', LS: 'pauschal', XPP: 'Stück', TNE: 't', WEE: 'Woche', P1: '%' };

// ---------------------------------------------------------------- Rechnen
export const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

export function computeTotals(inv) {
  const lines = inv.lines.map((l) => ({ ...l, net: round2((Number(l.quantity) || 0) * (Number(l.price) || 0)) }));
  const groups = new Map();
  for (const l of lines) {
    const key = `${l.taxCategory}|${Number(l.taxRate) || 0}`;
    const g = groups.get(key) || { category: l.taxCategory, rate: Number(l.taxRate) || 0, basis: 0, amount: 0, exemptionReason: '' };
    g.basis = round2(g.basis + l.net);
    groups.set(key, g);
  }
  const taxes = [...groups.values()].map((g) => ({ ...g, amount: round2((g.basis * g.rate) / 100), exemptionReason: exemptionReasonFor(g.category, inv) }));
  const lineTotal = round2(lines.reduce((s, l) => s + l.net, 0));
  const taxTotal = round2(taxes.reduce((s, x) => s + x.amount, 0));
  const grandTotal = round2(lineTotal + taxTotal);
  const prepaid = round2(Number(inv.prepaid) || 0);
  return { lines, taxes, totals: { lineTotal, taxBasis: lineTotal, taxTotal, grandTotal, prepaid, due: round2(grandTotal - prepaid) } };
}

function exemptionReasonFor(cat, inv) {
  if (inv.exemptionReason) return inv.exemptionReason;
  return { E: 'Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG', AE: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)', K: 'Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1b UStG)', G: 'Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1a UStG)', O: 'Nicht im Inland steuerbare Leistung' }[cat] || '';
}

// ---------------------------------------------------------------- Schreiben (XRechnung 3.0, CII)
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (v) => round2(Number(v) || 0).toFixed(2);
const d102 = (iso) => String(iso || '').replace(/-/g, '');
const el = (tag, val, attrs = '') => (val === '' || val == null ? '' : `<${tag}${attrs}>${esc(val)}</${tag}>`);

export const XRECHNUNG_GUIDELINE = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

function partyXml(p, role) {
  const taxRegs = [p.vatId && `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(p.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`, p.taxNumber && `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(p.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`].filter(Boolean).join('');
  const contact = role === 'seller' ? `<ram:DefinedTradeContact>${el('ram:PersonName', p.contactName)}${p.contactPhone ? `<ram:TelephoneUniversalCommunication>${el('ram:CompleteNumber', p.contactPhone)}</ram:TelephoneUniversalCommunication>` : ''}${p.contactEmail ? `<ram:EmailURIUniversalCommunication>${el('ram:URIID', p.contactEmail)}</ram:EmailURIUniversalCommunication>` : ''}</ram:DefinedTradeContact>` : '';
  // BR-CO-26: Ohne USt-IdNr. muss eine Verkäuferkennung (BT-29) oder Registernummer (BT-30) vorhanden sein.
  // Fallback für Kleinunternehmer: Steuernummer zusätzlich als Verkäuferkennung (BT-29).
  const sellerId = role === 'seller' ? (p.id || (!p.vatId && !p.legalId ? p.taxNumber : '')) : p.id;
  return `${el('ram:ID', sellerId)}${el('ram:Name', p.name)}${p.legalId ? `<ram:SpecifiedLegalOrganization>${el('ram:ID', p.legalId)}</ram:SpecifiedLegalOrganization>` : ''}${contact}<ram:PostalTradeAddress>${el('ram:PostcodeCode', p.zip)}${el('ram:LineOne', p.street)}${el('ram:CityName', p.city)}${el('ram:CountryID', p.country || 'DE')}</ram:PostalTradeAddress>${p.electronicAddress ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(p.electronicAddress)}</ram:URIID></ram:URIUniversalCommunication>` : ''}${taxRegs}`;
}

export function buildXRechnungCII(input) {
  const { lines, taxes, totals } = computeTotals(input);
  const cur = input.currency || 'EUR';
  const lineXml = lines.map((l, idx) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${idx + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>${el('ram:Name', l.name)}${el('ram:Description', l.description)}</ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${amt(l.price)}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${esc(l.unit || 'C62')}">${Number(l.quantity) || 0}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${esc(l.taxCategory)}</ram:CategoryCode><ram:RateApplicablePercent>${Number(l.taxRate) || 0}</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amt(l.net)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('');
  const taxXml = taxes.map((x) => `
      <ram:ApplicableTradeTax><ram:CalculatedAmount>${amt(x.amount)}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>${el('ram:ExemptionReason', x.category === 'S' || x.category === 'Z' ? '' : x.exemptionReason)}<ram:BasisAmount>${amt(x.basis)}</ram:BasisAmount><ram:CategoryCode>${esc(x.category)}</ram:CategoryCode><ram:RateApplicablePercent>${x.rate}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`).join('');
  const pay = input.payment || {};
  const delivery = input.deliveryDate ? `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${d102(input.deliveryDate)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>` : '';
  const period = input.periodStart && input.periodEnd ? `<ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">${d102(input.periodStart)}</udt:DateTimeString></ram:StartDateTime><ram:EndDateTime><udt:DateTimeString format="102">${d102(input.periodEnd)}</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>` : '';
  const notes = (input.notes || []).filter(Boolean).map((nn) => `<ram:IncludedNote>${el('ram:Content', nn)}</ram:IncludedNote>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${XRECHNUNG_GUIDELINE}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(input.number)}</ram:ID>
    <ram:TypeCode>${esc(input.typeCode || '380')}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${d102(input.issueDate)}</udt:DateTimeString></ram:IssueDateTime>${notes}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lineXml}
    <ram:ApplicableHeaderTradeAgreement>
      ${el('ram:BuyerReference', input.buyerReference)}
      <ram:SellerTradeParty>${partyXml(input.seller, 'seller')}</ram:SellerTradeParty>
      <ram:BuyerTradeParty>${partyXml(input.buyer, 'buyer')}</ram:BuyerTradeParty>
      ${input.orderReference ? `<ram:BuyerOrderReferencedDocument>${el('ram:IssuerAssignedID', input.orderReference)}</ram:BuyerOrderReferencedDocument>` : ''}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>${delivery}</ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      ${el('ram:PaymentReference', input.paymentReference || input.number)}
      <ram:InvoiceCurrencyCode>${esc(cur)}</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>${esc(pay.code || '58')}</ram:TypeCode>${pay.iban ? `<ram:PayeePartyCreditorFinancialAccount>${el('ram:IBANID', pay.iban.replace(/\s+/g, ''))}${el('ram:AccountName', pay.accountName)}</ram:PayeePartyCreditorFinancialAccount>` : ''}${pay.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution>${el('ram:BICID', pay.bic)}</ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}</ram:SpecifiedTradeSettlementPaymentMeans>${taxXml}
      ${period}
      <ram:SpecifiedTradePaymentTerms>${el('ram:Description', input.paymentTerms)}${input.dueDate ? `<ram:DueDateDateTime><udt:DateTimeString format="102">${d102(input.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>` : ''}</ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amt(totals.lineTotal)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amt(totals.taxBasis)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${esc(cur)}">${amt(totals.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amt(totals.grandTotal)}</ram:GrandTotalAmount>
        ${totals.prepaid ? `<ram:TotalPrepaidAmount>${amt(totals.prepaid)}</ram:TotalPrepaidAmount>` : ''}
        <ram:DuePayableAmount>${amt(totals.due)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`.replace(/\n\s*\n/g, '\n');
}

// ---------------------------------------------------------------- Prüfen
export function ibanValid(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const near = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.011;

// Ergebnis: [{level:'error'|'warning'|'info', rule, message}]
export function validateInvoice(inv) {
  const out = [];
  const err = (rule, message) => out.push({ level: 'error', rule, message });
  const warn = (rule, message) => out.push({ level: 'warning', rule, message });
  const isX = /xrechnung/i.test(inv.profile || '');
  const p = (inv.profile || '').toLowerCase();
  if (p.includes('minimum') || p.includes('basicwl') || p.includes('basic-wl')) err('Profil', 'Die Profile MINIMUM und BASIC WL erfüllen nicht die Anforderungen an eine E-Rechnung nach § 14 UStG.');
  if (!inv.number) err('BR-02', 'Rechnungsnummer fehlt.');
  if (!inv.issueDate) err('BR-03', 'Rechnungsdatum fehlt.');
  if (!inv.typeCode) err('BR-04', 'Rechnungsart (TypeCode) fehlt.');
  if (!inv.currency) err('BR-05', 'Währung fehlt.');
  if (!inv.seller?.name) err('BR-06', 'Name des Verkäufers fehlt.');
  if (!inv.buyer?.name) err('BR-07', 'Name des Käufers fehlt.');
  if (!inv.seller?.country) err('BR-09', 'Land des Verkäufers fehlt.');
  if (!inv.buyer?.country) err('BR-11', 'Land des Käufers fehlt.');
  if (!inv.lines?.length) err('BR-16', 'Die Rechnung enthält keine Positionen.');
  inv.lines?.forEach((l, i) => {
    if (!l.name) err('BR-25', `Position ${i + 1}: Artikelbezeichnung fehlt.`);
    if (l.quantity == null) err('BR-22', `Position ${i + 1}: Menge fehlt.`);
    if (l.price == null) err('BR-26', `Position ${i + 1}: Nettopreis fehlt.`);
    if (!l.taxCategory) err('BR-CO-04', `Position ${i + 1}: Umsatzsteuerkategorie fehlt.`);
    if (l.quantity != null && l.price != null && l.net != null) {
      const base = l.priceBaseQty || 1;
      if (!near(round2((l.quantity * l.price) / base), l.net)) warn('Rechnung', `Position ${i + 1}: Menge × Preis (${round2((l.quantity * l.price) / base)}) ≠ Nettobetrag (${l.net}).`);
    }
  });
  const T = inv.totals || {};
  if (T.lineTotal == null) err('BR-12', 'Summe der Nettobeträge fehlt.');
  if (T.grandTotal == null) err('BR-14', 'Gesamtbetrag (brutto) fehlt.');
  if (T.due == null) err('BR-15', 'Zahlbetrag fehlt.');
  if (inv.lines?.length && T.lineTotal != null) {
    const s = round2(inv.lines.reduce((a, l) => a + (l.net || 0), 0));
    if (!near(s, T.lineTotal)) err('BR-CO-10', `Summe der Positionen (${s}) ≠ Nettosumme (${T.lineTotal}).`);
  }
  if (T.taxBasis != null && T.lineTotal != null) {
    const exp = round2(T.lineTotal - (T.allowanceTotal || 0) + (T.chargeTotal || 0));
    if (!near(exp, T.taxBasis)) err('BR-CO-13', `Steuerbemessungsgrundlage (${T.taxBasis}) ≠ Nettosumme − Nachlässe + Zuschläge (${exp}).`);
  }
  if (T.taxBasis != null && T.grandTotal != null) {
    const exp = round2(T.taxBasis + (T.taxTotal || 0));
    if (!near(exp, T.grandTotal)) err('BR-CO-15', `Bruttobetrag (${T.grandTotal}) ≠ Netto + Steuer (${exp}).`);
  }
  if (T.grandTotal != null && T.due != null) {
    const exp = round2(T.grandTotal - (T.prepaid || 0) + (T.rounding || 0));
    if (!near(exp, T.due)) err('BR-CO-16', `Zahlbetrag (${T.due}) ≠ Brutto − Vorauszahlung + Rundung (${exp}).`);
  }
  for (const x of inv.taxes || []) {
    if (x.category === 'S' && x.basis != null && x.amount != null && x.rate != null && !near(round2((x.basis * x.rate) / 100), x.amount)) err('BR-CO-17', `Steuerbetrag ${x.rate} %: ${x.amount} ≠ ${round2((x.basis * x.rate) / 100)}.`);
    if (['E', 'AE', 'K', 'G', 'O'].includes(x.category) && !x.exemptionReason) warn('BR-E-10', `Für Kategorie ${x.category} (${TAX_CATEGORIES[x.category]}) sollte ein Befreiungsgrund angegeben werden.`);
    if (!(inv.seller?.vatId || inv.seller?.id || inv.seller?.legalId)) { if (!out.some((o) => o.rule === 'BR-CO-26')) err('BR-CO-26', 'Es fehlt eine Verkäuferkennung: USt-IdNr. (BT-31), Kennung (BT-29) oder Registernummer (BT-30).'); }
    if (x.category === 'S' && !(inv.seller?.vatId || inv.seller?.taxNumber)) err('BR-S-02', 'Bei Regelbesteuerung muss die USt-IdNr. oder Steuernummer des Verkäufers angegeben sein (§ 14 Abs. 4 UStG).');
    if (x.category === 'AE' && !inv.buyer?.vatId && inv.buyer?.country !== 'DE') warn('BR-AE-02', 'Bei Reverse Charge sollte die USt-IdNr. des Käufers angegeben sein.');
  }
  if (T.taxTotal != null && inv.taxes?.length) {
    const s = round2(inv.taxes.reduce((a, x) => a + (x.amount || 0), 0));
    if (!near(s, T.taxTotal)) err('BR-CO-14', `Summe der Steuerbeträge (${s}) ≠ Steuergesamtbetrag (${T.taxTotal}).`);
  }
  for (const pm of inv.payment || []) {
    if (pm.iban && !ibanValid(pm.iban)) err('IBAN', `IBAN ${pm.iban} hat eine ungültige Prüfsumme.`);
    if (['58', '30', '31', '42'].includes(pm.code) && !pm.iban && isX) err('BR-DE-23', 'Bei Überweisung muss eine IBAN angegeben werden.');
  }
  if (T.due > 0 && !inv.dueDate && !inv.paymentTerms) err('BR-CO-25', 'Bei positivem Zahlbetrag ist ein Fälligkeitsdatum oder eine Zahlungsbedingung anzugeben.');
  if (isX) {
    if (!inv.buyerReference) err('BR-DE-15', 'Käuferreferenz (BT-10, z. B. Leitweg-ID) fehlt – in XRechnung Pflicht.');
    if (!inv.seller?.city) err('BR-DE-3', 'Ort des Verkäufers fehlt.');
    if (!inv.seller?.zip) err('BR-DE-4', 'PLZ des Verkäufers fehlt.');
    if (!inv.buyer?.city) err('BR-DE-8', 'Ort des Käufers fehlt.');
    if (!inv.buyer?.zip) err('BR-DE-9', 'PLZ des Käufers fehlt.');
    if (!inv.seller?.contactName) err('BR-DE-5', 'Ansprechpartner des Verkäufers fehlt.');
    if (!inv.seller?.contactPhone) err('BR-DE-6', 'Telefonnummer des Verkäufers fehlt.');
    if (!inv.seller?.contactEmail) err('BR-DE-7', 'E-Mail-Adresse des Verkäufers fehlt.');
    if (!inv.seller?.electronicAddress) err('BR-DE-16/BT-34', 'Elektronische Adresse des Verkäufers fehlt.');
    if (!inv.buyer?.electronicAddress) err('BR-DE-16/BT-49', 'Elektronische Adresse des Käufers fehlt.');
    if (!inv.payment?.length) err('BR-DE-1', 'Zahlungsanweisungen fehlen.');
  }
  if (inv.seller?.vatId && !/^[A-Z]{2}[0-9A-Z+*.]{2,13}$/.test(inv.seller.vatId.replace(/\s/g, ''))) warn('USt-IdNr.', `USt-IdNr. des Verkäufers (${inv.seller.vatId}) hat ein ungewöhnliches Format.`);
  if (!out.length) out.push({ level: 'info', rule: 'OK', message: 'Keine Fehler in den geprüften Regeln gefunden.' });
  return out;
}

// ---------------------------------------------------------------- Anzeige-Helfer
export function fmtMoney(v, cur = 'EUR') {
  if (v == null) return '–';
  try { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur || 'EUR' }).format(v); } catch { return `${Number(v).toFixed(2)} ${cur}`; }
}
export function fmtDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
export { esc as escapeHtml };
