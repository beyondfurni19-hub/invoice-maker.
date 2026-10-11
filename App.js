import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, FlatList,
  Alert, StyleSheet, BackHandler, Modal, Image, StatusBar,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SQLite from 'expo-sqlite';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

// ======================= HELPERS START =======================
const num = (v) => {
  const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (n) => r2(n).toFixed(2);
const fmtQ = (n) => (Number.isInteger(r2(n)) ? String(r2(n)) : r2(n).toFixed(2));
const pad = (n) => String(n).padStart(2, '0');
const todayDMY = () => {
  const d = new Date();
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
};
const parseDMY = (dmy) => {
  const p = String(dmy || '').split('/');
  const d = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  const y = parseInt(p[2], 10);
  if (!d || !m || !y) return null;
  return { d, m, y };
};
const dmyKey = (dmy) => {
  const p = parseDMY(dmy);
  return p ? p.y * 10000 + p.m * 100 + p.d : 0;
};
const fyOf = (dmy) => {
  const p = parseDMY(dmy);
  let m;
  let y;
  if (p) { m = p.m; y = p.y; } else {
    const d = new Date();
    m = d.getMonth() + 1;
    y = d.getFullYear();
  }
  const start = m >= 4 ? y : y - 1;
  return String(start).slice(2) + '-' + String(start + 1).slice(2);
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = (n) => {
  let s = '';
  if (n >= 100) {
    s += ONES[Math.floor(n / 100)] + ' Hundred';
    n %= 100;
    if (n) s += ' ';
  }
  if (n) s += two(n);
  return s;
};
const wordsInt = (n) => {
  if (n === 0) return 'Zero';
  const parts = [];
  const cr = Math.floor(n / 10000000); n %= 10000000;
  const lk = Math.floor(n / 100000); n %= 100000;
  const th = Math.floor(n / 1000); n %= 1000;
  if (cr) parts.push(wordsInt(cr) + ' Crore');
  if (lk) parts.push(two(lk) + ' Lakh');
  if (th) parts.push(two(th) + ' Thousand');
  if (n) parts.push(three(n));
  return parts.join(' ');
};
const amountInWords = (total) => {
  const t = r2(total);
  const rupees = Math.floor(t);
  const paise = Math.round((t - rupees) * 100);
  return 'INR Rs ' + wordsInt(rupees) + (paise ? ' and ' + two(paise) + ' Paise' : '') + ' Only';
};

const esc = (t) => String(t === undefined || t === null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const br = (t) => esc(t).replace(/\r?\n/g, '<br/>');

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const checkGstin = (g, ok) => {
  const v = String(g || '').trim().toUpperCase();
  if (!v || GSTIN_RE.test(v)) return ok();
  Alert.alert('GSTIN galat lag raha hai',
    'GSTIN 15 character ka hona chahiye (jaise 27ABCDE1234F1Z5). Phir bhi save karein?',
    [{ text: 'Theek karo' }, { text: 'Phir bhi save karo', onPress: ok }]);
};

const isInterstate = (cust, sellerGstin) => {
  const b = String((cust && cust.gstin) || '').trim();
  if (b.length < 2) return false;
  return b.slice(0, 2) !== String(sellerGstin || '27').trim().slice(0, 2);
};

// Invoice save karte waqt IGST/CGST ka faisla freeze hota hai (extra.inter),
// taaki baad mein seller GSTIN badalne par purane invoice ka total na badle.
const docInter = (doc, S) => {
  try {
    const x = JSON.parse(doc.extra || '{}');
    if (typeof x.inter === 'boolean') return x.inter;
  } catch (e) {}
  return isInterstate(JSON.parse(doc.customer || '{}'), S.gstin);
};

const calcInvoice = (items, interstate) => {
  let sub = 0;
  const byRate = {};
  items.forEach((it) => {
    const amt = r2(num(it.qty) * num(it.rate));
    sub += amt;
    const g = num(it.gst);
    byRate[g] = (byRate[g] || 0) + amt;
  });
  const lines = [];
  let tax = 0;
  Object.keys(byRate).map(Number).sort((a, b) => a - b).forEach((rate) => {
    if (!rate) return;
    const t = byRate[rate];
    if (interstate) {
      const v = r2((t * rate) / 100);
      lines.push({ label: 'Output IGST ' + rate + '%', amt: v });
      tax += v;
    } else {
      const v = r2((t * rate) / 200);
      lines.push({ label: 'Output CGST ' + rate / 2 + '%', amt: v });
      lines.push({ label: 'Output SGST ' + rate / 2 + '%', amt: v });
      tax += v * 2;
    }
  });
  sub = r2(sub);
  tax = r2(tax);
  return { sub, lines, tax, total: r2(sub + tax) };
};

// Rate-wise taxable value aur tax (GST summary report ke liye)
const gstByRate = (items, interstate) => {
  const out = {};
  items.forEach((it) => {
    const amt = r2(num(it.qty) * num(it.rate));
    const g = num(it.gst);
    const o = out[g] || (out[g] = { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    o.taxable += amt;
  });
  Object.keys(out).forEach((k) => {
    const rate = Number(k);
    const o = out[k];
    o.taxable = r2(o.taxable);
    if (!rate) return;
    if (interstate) o.igst = r2((o.taxable * rate) / 100);
    else {
      const v = r2((o.taxable * rate) / 200);
      o.cgst = v;
      o.sgst = v;
    }
  });
  return out;
};

const calcQuote = (rows) => r2(rows.reduce((a, r) => a + num(r.amount), 0));

const safePart = (s) => String(s || '')
  .replace(/[\/\\]+/g, '-')
  .replace(/[^A-Za-z0-9\-]+/g, '_')
  .replace(/^_+|_+$/g, '');
const pdfName = (doc) => {
  const c = JSON.parse(doc.customer || '{}');
  return safePart(c.name || doc.customer_name) + '_' + safePart(doc.number) + '.pdf';
};

const invoiceHtml = (doc, S) => {
  const c = JSON.parse(doc.customer || '{}');
  const items = JSON.parse(doc.items || '[]');
  const x = JSON.parse(doc.extra || '{}');
  const inter = docInter(doc, S);
  const t = calcInvoice(items, inter);
  const fill = Math.max(6, 55 - items.length * 8);
  const rows = items.map((it, i) => {
    const amt = r2(num(it.qty) * num(it.rate));
    return '<tr class="it"><td>' + (i + 1) + ') ' + br(it.desc) + '</td>' +
      '<td class="c">' + esc(it.hsn) + '</td>' +
      '<td class="c">' + (num(it.gst) ? esc(num(it.gst)) + '%' : '') + '</td>' +
      '<td class="c">' + esc(it.qty) + '</td>' +
      '<td class="c">' + fmt(num(it.rate)) + '</td>' +
      '<td class="c">' + esc(it.per) + '</td>' +
      '<td class="r">' + fmt(amt) + '</td></tr>';
  }).join('');
  const taxRows = t.lines.map((l) =>
    '<tr class="tt"><td></td><td colspan="5">' + esc(l.label) + '</td><td class="r">' + fmt(l.amt) + '</td></tr>').join('');
  const gstLine = c.gstin ? '<div class="b">GSTIN:' + esc(c.gstin) + '</div>' : '';
  return '<html><head><meta charset="utf-8"/><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000;margin:0;padding:8mm 10mm;}' +
    'table{border-collapse:collapse;width:100%;table-layout:fixed;}' +
    'td,th{border:1px solid #000;padding:3px 5px;vertical-align:top;word-wrap:break-word;}' +
    '.title{text-align:center;font-weight:bold;font-size:12px;border:none;padding:0 0 3px 0;}' +
    '.b{font-weight:bold;} .c{text-align:center;} .r{text-align:right;} .big{font-size:15px;font-weight:bold;}' +
    '.it td{border-top:none;border-bottom:none;} .sm{font-size:9.5px;} .hd th{font-weight:normal;text-align:center;}' +
    '.tt td{padding:1px 5px;} .tot td{font-weight:bold;}' +
    '</style></head><body>' +
    '<table><tr><td class="title" colspan="3">TAX INVOICE <i style="font-weight:normal">( ORIGINAL FOR RECIPIENT)</i></td></tr></table>' +
    '<table><colgroup><col style="width:45%"/><col style="width:35%"/><col style="width:20%"/></colgroup>' +
    '<tr><td rowspan="3"><div class="big">' + esc(S.name) + '</div><div class="sm">' + br(S.address) + '</div>' +
    '<div class="sm">Mobile: ' + esc(S.mobile) + '</div><div class="b sm">GSTIN/UIN:' + esc(S.gstin) + '</div></td>' +
    '<td>Invoice No.: ' + esc(doc.number) + '</td><td>Dated: &nbsp; ' + esc(doc.date) + '</td></tr>' +
    '<tr><td>Buyer\'s Order No.: ' + esc(x.orderNo) + '</td><td>Dated: &nbsp; ' + esc(x.orderDate) + '</td></tr>' +
    '<tr><td>Despatch Through ' + esc(x.despatch) + '</td><td>Destination ' + esc(x.destination) + '</td></tr>' +
    '<tr><td style="height:24mm"><div class="b">Buyer:</div><div style="font-size:12px">' + br(c.name) + '<br/>' + br(c.address) + '</div>' + gstLine + '</td>' +
    '<td colspan="2"></td></tr></table>' +
    '<table><colgroup><col style="width:40%"/><col style="width:10%"/><col style="width:9%"/><col style="width:8%"/><col style="width:12%"/><col style="width:7%"/><col style="width:14%"/></colgroup>' +
    '<tr class="hd"><th>Description of Goods</th><th>HSN/SAC</th><th>GST Rate</th><th>Qty</th><th>Rate</th><th>per</th><th>Amount</th></tr>' +
    rows +
    '<tr class="it"><td style="height:' + fill + 'mm"></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>' +
    '<tr class="tt"><td style="border-top:1px solid #000"></td><td colspan="5" style="border-top:1px solid #000">Amt Rs</td><td class="r" style="border-top:1px solid #000">' + fmt(t.sub) + '</td></tr>' +
    taxRows +
    '<tr class="tt tot"><td></td><td colspan="5">TOTAL (Rs.)</td><td class="r">' + fmt(t.total) + '</td></tr>' +
    '</table>' +
    '<table><tr><td style="height:16mm"><div class="sm">Amount Chargeable ( in words)</div><div style="font-size:12px;margin-top:2px">' + esc(amountInWords(t.total)) + '</div></td></tr></table>' +
    '<table><colgroup><col style="width:50%"/><col style="width:50%"/></colgroup><tr>' +
    '<td style="height:32mm"><div class="b" style="margin-top:5mm">Udyam Registration No: &nbsp;&nbsp;' + esc(S.udyam) + '</div>' +
    '<div class="sm" style="margin-top:6mm">Declaration:<br/>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct</div></td>' +
    '<td><div class="sm">Company\'s Bank Details :</div><div class="sm">Bank Name: &nbsp;' + esc(S.bankName) + '</div>' +
    '<div class="b" style="font-size:13px">A/C NO- ' + esc(S.accNo) + '</div><div class="b sm">IFSC Code : &nbsp;' + esc(S.ifsc) + '</div>' +
    '<div class="r" style="margin-top:4mm">For ' + esc(String(S.name).toUpperCase()) + '</div>' +
    '<div class="r" style="margin-top:9mm">Authorised Signatory</div></td></tr></table>' +
    '<div class="c sm" style="margin-top:3px">SUBJECT TO NASHIK JURISDICTION</div>' +
    '</body></html>';
};

const quotationHtml = (doc) => {
  const c = JSON.parse(doc.customer || '{}');
  const rowsData = JSON.parse(doc.items || '[]');
  const total = calcQuote(rowsData);
  const rows = rowsData.map((r, i) =>
    '<tr><td class="c">' + (i + 1) + '</td><td class="c">' + esc(r.date) + '</td>' +
    '<td class="c" style="font-size:13px">' + br(String(r.desc || '').toUpperCase()) + '</td>' +
    '<td class="c" style="font-size:14px">' + fmtQ(num(r.amount)) + '</td><td></td></tr>').join('');
  return '<html><head><meta charset="utf-8"/><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000;margin:0;padding:10mm;}' +
    'table{border-collapse:collapse;width:100%;table-layout:fixed;}' +
    'td,th{border:1px solid #000;padding:6px 6px;vertical-align:middle;word-wrap:break-word;}' +
    '.c{text-align:center;} th{font-weight:normal;font-size:11px;padding:2px 4px;}' +
    '</style></head><body><table>' +
    '<colgroup><col style="width:7%"/><col style="width:15%"/><col style="width:48%"/><col style="width:16%"/><col style="width:14%"/></colgroup>' +
    '<tr><td colspan="5" class="c" style="font-size:34px;padding:14px 6px">' + esc(String(c.name || '').toUpperCase()) + '</td></tr>' +
    '<tr><th>Sr no</th><th style="text-align:left">Date</th><th>Description</th><th>Amount</th><th style="text-align:left">Sign</th></tr>' +
    rows +
    '<tr><td></td><td></td><td class="c" style="font-size:24px;font-weight:bold">Total</td>' +
    '<td class="c" style="font-size:20px;font-weight:bold">' + fmtQ(total) + '</td><td></td></tr>' +
    '</table></body></html>';
};
// ======================= HELPERS END =======================

// ----------------------- Database -----------------------
const db = SQLite.openDatabaseSync('durgesh.db');
db.execSync(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, address TEXT, gstin TEXT, phone TEXT
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, number TEXT, date TEXT,
    customer_id INTEGER, customer_name TEXT, customer TEXT,
    items TEXT, extra TEXT, total REAL
  );
`);
// Purane database mein naye columns (paid status) jodna. Dobara chalane par error aayega, wo ignore hota hai.
try { db.execSync('ALTER TABLE documents ADD COLUMN paid INTEGER DEFAULT 0'); } catch (e) {}
try { db.execSync('ALTER TABLE documents ADD COLUMN paid_date TEXT'); } catch (e) {}
// Saved items (baar-baar use hone wale items). Note: "desc" SQL ka reserved word hai, isliye column ka naam descr.
db.execSync(`
  CREATE TABLE IF NOT EXISTS saved_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, descr TEXT, hsn TEXT, gst TEXT, per TEXT, rate TEXT
  );
`);

const DEFAULTS = {
  name: 'DURGESH TOOLS',
  address: 'PLOT NO D-40,\nMIDC SATPUR NASHIK 422007\nMAHARASHTRA- 27',
  mobile: '7620756679',
  gstin: '27BHJPJ2408Q1ZX',
  udyam: 'UDYAM-MH-23-0168519',
  bankName: 'HDFC BANK',
  accNo: '50200084118250',
  ifsc: 'HDFC0004663',
  series: 'DT',
  defaultHsn: '9988',
};
const REQUIRED = ['name', 'series', 'defaultHsn'];

const getSettings = () => {
  const s = { ...DEFAULTS };
  db.getAllSync('SELECT key, value FROM settings').forEach((r) => {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) s[r.key] = r.value;
  });
  REQUIRED.forEach((k) => { if (!String(s[k] || '').trim()) s[k] = DEFAULTS[k]; });
  return s;
};
const setSetting = (k, v) => db.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);
const getSetting = (k) => {
  const r = db.getFirstSync('SELECT value FROM settings WHERE key = ?', [k]);
  return r ? r.value : null;
};

const getCustomers = () => db.getAllSync('SELECT * FROM customers ORDER BY name COLLATE NOCASE');
const addCustomer = (c) => {
  const gst = String(c.gstin || '').trim().toUpperCase();
  const r = db.runSync('INSERT INTO customers (name, address, gstin, phone) VALUES (?,?,?,?)',
    [c.name.trim(), c.address || '', gst, c.phone || '']);
  return { id: r.lastInsertRowId, name: c.name.trim(), address: c.address || '', gstin: gst, phone: c.phone || '' };
};
const updateCustomer = (id, c) => db.runSync('UPDATE customers SET name=?, address=?, gstin=?, phone=? WHERE id=?',
  [c.name.trim(), c.address || '', String(c.gstin || '').trim().toUpperCase(), c.phone || '', id]);

// ----------------------- Saved items -----------------------
const getSavedItems = (kind) => (kind
  ? db.getAllSync('SELECT * FROM saved_items WHERE kind = ? ORDER BY descr COLLATE NOCASE', [kind])
  : db.getAllSync('SELECT * FROM saved_items ORDER BY kind, descr COLLATE NOCASE'));
// Row ko list mein save karo. Same description pehle se ho to update hota hai.
const saveItemRow = (kind, it) => {
  const descr = String(it.desc || '').trim();
  const rate = kind === 'invoice' ? String(it.rate || '') : String(it.amount || '');
  const ex = db.getFirstSync('SELECT id FROM saved_items WHERE kind = ? AND lower(descr) = lower(?)', [kind, descr]);
  if (ex) {
    db.runSync('UPDATE saved_items SET descr=?, hsn=?, gst=?, per=?, rate=? WHERE id=?',
      [descr, String(it.hsn || ''), String(it.gst === undefined ? '' : it.gst), String(it.per || ''), rate, ex.id]);
    return 'updated';
  }
  db.runSync('INSERT INTO saved_items (kind, descr, hsn, gst, per, rate) VALUES (?,?,?,?,?,?)',
    [kind, descr, String(it.hsn || ''), String(it.gst === undefined ? '' : it.gst), String(it.per || ''), rate]);
  return 'added';
};
const itemDetail = (it) => (it.kind === 'invoice'
  ? 'HSN ' + (it.hsn || '-') + ' • GST ' + (it.gst === '' || it.gst == null ? '-' : it.gst + '%') + ' • ₹' + fmt(num(it.rate)) + ' / ' + (it.per || 'no')
  : (num(it.rate) ? '₹' + inrQ(num(it.rate)) : 'Amount: har baar daalna'));

// Date ke hisaab se naya pehle, same date par naya id pehle
const getDocs = (type) => db.getAllSync('SELECT * FROM documents WHERE type = ?', [type])
  .sort((a, b) => (dmyKey(b.date) - dmyKey(a.date)) || (b.id - a.id));

// ----------------------- Numbering -----------------------
// Invoice numbers: 20/DT/26-27 (har financial year mein 1 se shuru)
const counterKey = (type, fy) => (type === 'invoice' ? 'ctr_inv_' + fy : 'ctr_quote');
const numOf = (type, number) => (type === 'invoice'
  ? parseInt(number, 10)
  : parseInt(String(number).replace(/\D/g, ''), 10));

const nextNumber = (type, dmy, S) => {
  if (type === 'invoice') {
    const fy = fyOf(dmy);
    const stored = getSetting(counterKey('invoice', fy));
    const n = stored ? parseInt(stored, 10) : (fy === '26-27' ? 20 : 1);
    return n + '/' + S.series + '/' + fy;
  }
  const stored = getSetting('ctr_quote');
  const n = stored ? parseInt(stored, 10) : 1;
  return 'QT-' + String(n).padStart(3, '0');
};
const bumpCounter = (type, number, dmy) => {
  const m = numOf(type, number);
  if (!m) return;
  const key = counterKey(type, fyOf(dmy));
  const cur = parseInt(getSetting(key) || '0', 10);
  if (m + 1 > cur) setSetting(key, m + 1);
};

// Delete ke baad: agar sabse naya number delete hua, to counter wapis peeche aa jata hai
// (taaki number gap na bane). Beech wala delete ho to gap "khali numbers" mein dikhta hai.
const resyncAfterDelete = (doc) => {
  const n = numOf(doc.type, doc.number);
  if (!n) return;
  const fy = fyOf(doc.date);
  const key = counterKey(doc.type, fy);
  const cur = parseInt(getSetting(key) || '0', 10);
  if (cur !== n + 1) return;
  let maxBelow = 0;
  getDocs(doc.type).forEach((d) => {
    if (doc.type === 'invoice' && fyOf(d.date) !== fy) return;
    const k = numOf(d.type, d.number);
    if (k && k < n && k > maxBelow) maxBelow = k;
  });
  setSetting(key, maxBelow ? maxBelow + 1 : n);
};

const missingNumbers = (fy) => {
  const ns = getDocs('invoice')
    .filter((d) => fyOf(d.date) === fy)
    .map((d) => parseInt(d.number, 10))
    .filter(Boolean);
  if (ns.length < 2) return [];
  const have = new Set(ns);
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  const out = [];
  for (let i = lo; i <= hi; i++) if (!have.has(i)) out.push(i);
  return out;
};

// ----------------------- PDF -----------------------
const makeAndSharePdf = async (doc) => {
  try {
    const S = getSettings();
    const html = doc.type === 'invoice' ? invoiceHtml(doc, S) : quotationHtml(doc);
    const { uri } = await Print.printToFileAsync({ html, width: 595, height: 842 });
    const name = pdfName(doc);
    const dest = FileSystem.cacheDirectory + name;
    try { await FileSystem.deleteAsync(dest, { idempotent: true }); } catch (e) {}
    await FileSystem.moveAsync({ from: uri, to: dest });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(dest, { mimeType: 'application/pdf', dialogTitle: name, UTI: 'com.adobe.pdf' });
    } else {
      Alert.alert('Share nahi ho sakta', 'Is device par sharing available nahi hai.');
    }
  } catch (e) {
    Alert.alert('PDF error', String(e && e.message ? e.message : e));
  }
};

// ----------------------- UI -----------------------
const ORANGE = '#F97316';
const ORANGE_D = '#EA580C';
const DARK = '#0F172A';
const MUTE = '#64748B';
const LINE = '#E2E8F0';
const BG = '#F3F5F8';
const GREEN = '#16A34A';
const RED = '#DC2626';
const BLUE = '#2563EB';
const SH = { shadowColor: '#0F172A', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 };

// Indian number format: 1,23,456.00
const inr = (n, dec = 2) => {
  const v = r2(n);
  const parts = Math.abs(v).toFixed(dec).split('.');
  const i = parts[0];
  let out = i;
  if (i.length > 3) {
    out = i.slice(-3);
    let rest = i.slice(0, -3);
    while (rest.length > 2) { out = rest.slice(-2) + ',' + out; rest = rest.slice(0, -2); }
    if (rest) out = rest + ',' + out;
  }
  return (v < 0 ? '-' : '') + out + (parts[1] ? '.' + parts[1] : '');
};
const inrQ = (n) => inr(n, Number.isInteger(r2(n)) ? 0 : 2);

const AV = ['#F97316', '#2563EB', '#16A34A', '#9333EA', '#0891B2', '#DB2777', '#CA8A04'];
const initials = (n) => {
  const p = String(n || '?').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
};
const avColor = (n) => {
  let h = 0;
  String(n || '').split('').forEach((ch) => { h = (h + ch.charCodeAt(0)) % AV.length; });
  return AV[h];
};
function Avatar({ name, size = 42 }) {
  const c = avColor(name);
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: c + '1F', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: c, fontWeight: '700', fontSize: size * 0.36 }}>{initials(name)}</Text>
    </View>
  );
}

// Chhote icons (koi icon library nahi chahiye)
function Icon({ name, size = 22, color = '#fff' }) {
  const lw = Math.max(1.6, size / 11);
  const box = { width: size, height: size, alignItems: 'center', justifyContent: 'center' };
  if (name === 'invoice' || name === 'quote') {
    return (
      <View style={box}>
        <View style={{ width: size * 0.72, height: size * 0.92, borderWidth: lw, borderColor: color, borderRadius: 3, paddingHorizontal: size * 0.1, justifyContent: 'center' }}>
          {name === 'quote' && <View style={{ height: lw * 1.8, backgroundColor: color, borderRadius: 1, marginBottom: size * 0.08 }} />}
          <View style={{ height: lw, backgroundColor: color, borderRadius: 1, marginBottom: size * 0.08 }} />
          {name === 'invoice' && <View style={{ height: lw, backgroundColor: color, borderRadius: 1, marginBottom: size * 0.08 }} />}
          <View style={{ height: lw, backgroundColor: color, borderRadius: 1, width: '60%' }} />
        </View>
      </View>
    );
  }
  if (name === 'people') {
    return (
      <View style={box}>
        <View style={{ width: size * 0.38, height: size * 0.38, borderRadius: size * 0.19, borderWidth: lw, borderColor: color }} />
        <View style={{ width: size * 0.78, height: size * 0.36, marginTop: size * 0.06, borderTopLeftRadius: size * 0.39, borderTopRightRadius: size * 0.39, borderWidth: lw, borderBottomWidth: 0, borderColor: color }} />
      </View>
    );
  }
  if (name === 'box') {
    return (
      <View style={box}>
        <View style={{ width: size * 0.82, height: size * 0.82, borderWidth: lw, borderColor: color, borderRadius: 4, alignItems: 'center' }}>
          <View style={{ width: '100%', height: lw, backgroundColor: color, marginTop: size * 0.2 }} />
          <View style={{ width: size * 0.26, height: lw * 1.6, backgroundColor: color, marginTop: size * 0.12, borderRadius: 1 }} />
        </View>
      </View>
    );
  }
  if (name === 'chart') {
    return (
      <View style={[box, { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: size * 0.1, paddingBottom: size * 0.08 }]}>
        {[0.45, 0.8, 0.6].map((h, i) => <View key={i} style={{ width: size * 0.2, height: size * h, backgroundColor: color, borderRadius: 2 }} />)}
      </View>
    );
  }
  if (name === 'sliders') {
    return (
      <View style={[box, { justifyContent: 'space-between', paddingVertical: size * 0.1 }]}>
        {[0.3, 0.7, 0.45].map((pp, i) => (
          <View key={i} style={{ width: size * 0.86, height: size * 0.24, justifyContent: 'center' }}>
            <View style={{ height: lw, backgroundColor: color, borderRadius: 1 }} />
            <View style={{ position: 'absolute', left: size * 0.86 * pp - size * 0.11, width: size * 0.22, height: size * 0.22, borderRadius: size * 0.11, backgroundColor: color }} />
          </View>
        ))}
      </View>
    );
  }
  if (name === 'plus') {
    return (
      <View style={box}>
        <View style={{ position: 'absolute', width: size * 0.6, height: lw * 1.4, backgroundColor: color, borderRadius: 2 }} />
        <View style={{ position: 'absolute', width: lw * 1.4, height: size * 0.6, backgroundColor: color, borderRadius: 2 }} />
      </View>
    );
  }
  if (name === 'chevL' || name === 'chevR') {
    return (
      <View style={box}>
        <View style={{ width: size * 0.42, height: size * 0.42, borderLeftWidth: lw * 1.3, borderBottomWidth: lw * 1.3, borderColor: color, transform: [{ rotate: name === 'chevL' ? '45deg' : '-135deg' }], marginLeft: name === 'chevL' ? size * 0.12 : -size * 0.1 }} />
      </View>
    );
  }
  if (name === 'search') {
    return (
      <View style={box}>
        <View style={{ width: size * 0.6, height: size * 0.6, borderRadius: size * 0.3, borderWidth: lw, borderColor: color, marginRight: size * 0.1, marginBottom: size * 0.1 }} />
        <View style={{ position: 'absolute', width: size * 0.34, height: lw * 1.2, backgroundColor: color, right: size * 0.04, bottom: size * 0.17, transform: [{ rotate: '45deg' }] }} />
      </View>
    );
  }
  return <View style={box} />;
}

function Input({ style, onFocus, onBlur, ...rest }) {
  const [focus, setFocus] = useState(false);
  return (
    <TextInput placeholderTextColor="#94A3B8" {...rest}
      onFocus={(e) => { setFocus(true); if (onFocus) onFocus(e); }}
      onBlur={(e) => { setFocus(false); if (onBlur) onBlur(e); }}
      style={[s.input, style, focus && s.inputFocus]} />
  );
}

function Empty({ icon, title, text }) {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIcon}><Icon name={icon} size={26} color={ORANGE} /></View>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

function Totals({ isInv, t, total }) {
  return (
    <View style={s.totalBox}>
      {isInv && <View style={s.sumRow}><Text style={s.sumLbl}>Amount</Text><Text style={s.sumVal}>₹{inr(t.sub)}</Text></View>}
      {isInv && t.lines.map((l, i) => (
        <View key={i} style={s.sumRow}><Text style={s.sumLbl}>{l.label.replace('Output ', '')}</Text><Text style={s.sumVal}>₹{inr(l.amt)}</Text></View>
      ))}
      <View style={s.grandRow}>
        <Text style={s.grandLbl}>Total</Text>
        <Text style={s.grand}>₹{isInv ? inr(total) : inrQ(total)}</Text>
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const insets = useSafeAreaInsets();
  const [screen, setScreen] = useState({ name: 'home' });
  const [tab, setTab] = useState('invoice');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const goHome = () => { refresh(); setScreen({ name: 'home' }); };
  const goBack = () => {
    if (screen.name === 'docForm' && (screen.doc || screen.copyFrom || screen.fromQuote)) {
      setScreen({ name: 'docView', docId: (screen.doc || screen.copyFrom || screen.fromQuote).id });
    } else goHome();
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'home') return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [screen]);

  const dt = screen.type || (screen.doc && screen.doc.type) || (screen.copyFrom && screen.copyFrom.type);
  const kindLbl = dt === 'quotation' ? 'quotation' : 'invoice';
  const brand = String(getSettings().name || 'My Business').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
  const titles = {
    home: brand, settings: 'Settings', reports: 'Reports',
    custForm: screen.customer ? 'Edit customer' : 'New customer',
    itemForm: screen.item ? 'Edit saved item' : 'New saved item',
    docForm: (screen.doc ? 'Edit ' : 'New ') + kindLbl,
    docView: 'Details',
  };

  return (
    <View style={[s.root, { paddingBottom: insets.bottom }]}>
      <StatusBar barStyle="light-content" />
      <View style={[s.header, { paddingTop: insets.top + 12 }, screen.name === 'home' && { paddingBottom: 6 }]}>
        {screen.name !== 'home' ? (
          <TouchableOpacity style={s.iconBtn} onPress={goBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="chevL" size={20} color="#fff" />
          </TouchableOpacity>
        ) : (
          <Image source={require('./icon.png')} style={s.logo} />
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.title} numberOfLines={1}>{titles[screen.name]}</Text>
          {screen.name === 'home' ? <Text style={s.subtitle}>Invoices & quotations</Text> : null}
        </View>
        {screen.name === 'home' ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity style={s.iconBtn} onPress={() => setScreen({ name: 'reports' })}>
              <Icon name="chart" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={s.iconBtn} onPress={() => setScreen({ name: 'settings' })}>
              <Icon name="sliders" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {screen.name === 'home' && (
        <Home tab={tab} setTab={setTab} tick={tick} setScreen={setScreen} />
      )}
      {screen.name === 'settings' && <SettingsScreen onDone={goHome} />}
      {screen.name === 'reports' && <ReportsScreen />}
      {screen.name === 'itemForm' && <ItemScreen item={screen.item} onDone={goHome} />}
      {screen.name === 'custForm' && <CustomerScreen customer={screen.customer} onDone={goHome} />}
      {screen.name === 'docForm' && (
        <DocForm type={screen.type} doc={screen.doc} copyFrom={screen.copyFrom} fromQuote={screen.fromQuote}
          onSaved={(id) => { refresh(); setScreen({ name: 'docView', docId: id }); }} />
      )}
      {screen.name === 'docView' && <DocView docId={screen.docId} setScreen={setScreen} onDeleted={goHome} />}
    </View>
  );
}

function Home({ tab, setTab, tick, setScreen }) {
  const [search, setSearch] = useState('');
  const [flt, setFlt] = useState('all');
  const [list, setList] = useState([]);
  useEffect(() => {
    setList(tab === 'customer' ? getCustomers() : tab === 'item' ? getSavedItems() : getDocs(tab));
  }, [tab, tick]);

  const isDoc = tab === 'invoice' || tab === 'quotation';
  const q = search.toLowerCase();
  const filtered = list.filter((i) => {
    if (tab === 'item') return (i.descr || '').toLowerCase().includes(q);
    if (!isDoc) return (i.name || '').toLowerCase().includes(q);
    if (flt === 'paid' && !i.paid) return false;
    if (flt === 'unpaid' && i.paid) return false;
    return (i.customer_name || '').toLowerCase().includes(q) || (i.number || '').toLowerCase().includes(q);
  });
  const unpaid = isDoc ? list.filter((i) => !i.paid) : [];
  const pendingAmt = unpaid.reduce((a, i) => a + num(i.total), 0);

  const addNew = () => {
    if (tab === 'customer') setScreen({ name: 'custForm' });
    else if (tab === 'item') setScreen({ name: 'itemForm' });
    else setScreen({ name: 'docForm', type: tab });
  };
  const tabs = [['invoice', 'Invoices', 'invoice'], ['quotation', 'Quotations', 'quote'], ['customer', 'Customers', 'people'], ['item', 'Items', 'box']];
  const flts = [['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid']];
  const nowP = parseDMY(todayDMY());
  const monthTotal = isDoc
    ? list.filter((i) => { const pp = parseDMY(i.date); return pp && pp.m === nowP.m && pp.y === nowP.y; }).reduce((a, i) => a + num(i.total), 0)
    : 0;
  const money = (v) => '₹' + (tab === 'invoice' ? inr(v) : inrQ(v));
  const searching = !!search || flt !== 'all';
  const emptyMap = {
    invoice: ['invoice', 'Abhi koi invoice nahi hai', 'Neeche + dabakar pehla invoice banao.'],
    quotation: ['quote', 'Abhi koi quotation nahi hai', 'Neeche + dabakar pehli quotation banao.'],
    customer: ['people', 'Abhi koi customer nahi hai', 'Neeche + dabakar pehla customer add karo.'],
    item: ['box', 'Abhi koi saved item nahi hai', 'Baar-baar use hone wale items yahan save karo, phir invoice mein tap karke daalo.'],
  };
  const em = searching ? ['search', 'Kuch nahi mila', 'Search ya filter badal kar dekho.'] : emptyMap[tab];

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <View style={s.hero}>
          {isDoc ? (
            <View>
              <Text style={s.heroLabel}>Pending payment</Text>
              <Text style={s.heroAmt} numberOfLines={1} adjustsFontSizeToFit>{money(pendingAmt)}</Text>
              <View style={s.heroRow}>
                <View style={s.heroPill}><Text style={s.heroPillText}>{unpaid.length ? unpaid.length + ' unpaid' : 'Sab paid'}</Text></View>
                <View style={s.heroPill}><Text style={s.heroPillText}>{money(monthTotal)} is mahine</Text></View>
              </View>
            </View>
          ) : (
            <View>
              <Text style={s.heroLabel}>{tab === 'customer' ? 'Saved customers' : 'Saved items'}</Text>
              <Text style={s.heroAmt}>{list.length}</Text>
            </View>
          )}
        </View>

        <View style={s.searchWrap}>
          <Icon name="search" size={18} color="#94A3B8" />
          <TextInput style={s.searchInput} placeholder={tab === 'customer' ? 'Search customers' : tab === 'item' ? 'Search items' : 'Search name or number'}
            placeholderTextColor="#94A3B8" value={search} onChangeText={setSearch} />
        </View>

        {isDoc && (
          <View style={s.seg}>
            {flts.map(([k, label]) => (
              <TouchableOpacity key={k} style={[s.segItem, flt === k && s.segOn]} onPress={() => setFlt(k)}>
                <Text style={[s.segText, flt === k && s.segTextOn]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <FlatList
          data={filtered}
          keyExtractor={(i) => String(i.id)}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: 4, paddingBottom: 110 }}
          ListEmptyComponent={<Empty icon={em[0]} title={em[1]} text={em[2]} />}
          renderItem={({ item }) => tab === 'item' ? (
            <TouchableOpacity activeOpacity={0.7} style={s.card} onPress={() => setScreen({ name: 'itemForm', item })}>
              <View style={[s.itemIcon, { backgroundColor: item.kind === 'invoice' ? '#FFEDD5' : '#DBEAFE' }]}>
                <Icon name="box" size={20} color={item.kind === 'invoice' ? ORANGE_D : BLUE} />
              </View>
              <View style={{ flex: 1, marginLeft: 12, marginRight: 8 }}>
                <Text style={s.cardTitle} numberOfLines={2}>{item.descr}</Text>
                <Text style={s.muted} numberOfLines={1}>{itemDetail(item)}</Text>
              </View>
              <View style={[s.pill, { backgroundColor: item.kind === 'invoice' ? '#FFEDD5' : '#DBEAFE' }]}>
                <Text style={[s.pillText, { color: item.kind === 'invoice' ? '#C2410C' : '#1D4ED8' }]}>{item.kind === 'invoice' ? 'Invoice' : 'Quotation'}</Text>
              </View>
            </TouchableOpacity>
          ) : tab === 'customer' ? (
            <TouchableOpacity activeOpacity={0.7} style={s.card} onPress={() => setScreen({ name: 'custForm', customer: item })}>
              <Avatar name={item.name} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.cardTitle} numberOfLines={1}>{item.name}</Text>
                <Text style={s.muted} numberOfLines={1}>{item.gstin ? 'GSTIN ' + item.gstin : item.phone || item.address}</Text>
              </View>
              <Icon name="chevR" size={16} color="#CBD5E1" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity activeOpacity={0.7} style={s.card} onPress={() => setScreen({ name: 'docView', docId: item.id })}>
              <Avatar name={item.customer_name} />
              <View style={{ flex: 1, marginLeft: 12, marginRight: 8 }}>
                <Text style={s.cardTitle} numberOfLines={1}>{item.customer_name}</Text>
                <Text style={s.muted} numberOfLines={1}>{item.number}</Text>
                <Text style={s.mutedSm}>{item.date}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={s.amt}>₹{item.type === 'invoice' ? inr(item.total) : inrQ(item.total)}</Text>
                <View style={[s.pill, { backgroundColor: item.paid ? '#DCFCE7' : '#FEE2E2', marginTop: 6 }]}>
                  <Text style={[s.pillText, { color: item.paid ? '#15803D' : '#B91C1C' }]}>{item.paid ? 'Paid' : 'Unpaid'}</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
        <TouchableOpacity style={s.fab} onPress={addNew} activeOpacity={0.85}>
          <Icon name="plus" size={28} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={s.nav}>
        {tabs.map(([k, label, icon]) => {
          const on = tab === k;
          return (
            <TouchableOpacity key={k} style={s.navItem} onPress={() => { setTab(k); setSearch(''); setFlt('all'); }}>
              <View style={[s.navBar, on && { backgroundColor: ORANGE }]} />
              <Icon name={icon} size={22} color={on ? ORANGE : '#94A3B8'} />
              <Text style={[s.navText, on && { color: ORANGE_D, fontWeight: '700' }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function Field({ label, value, onChangeText, ...rest }) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <Input value={value} onChangeText={onChangeText} {...rest} />
    </View>
  );
}

// ----------------------- Date picker (koi extra library nahi chahiye) -----------------------
function DatePickerModal({ visible, value, onClose, onPick, onClear }) {
  const [y, setY] = useState(2026);
  const [m, setM] = useState(1);
  useEffect(() => {
    if (visible) {
      const p = parseDMY(value) || parseDMY(todayDMY());
      setY(p.y);
      setM(p.m);
    }
  }, [visible]);
  const sel = parseDMY(value);
  const today = parseDMY(todayDMY());
  const daysIn = new Date(y, m, 0).getDate();
  const first = new Date(y, m - 1, 1).getDay();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const move = (dm) => {
    let nm = m + dm;
    let ny = y;
    if (nm < 1) { nm = 12; ny -= 1; }
    if (nm > 12) { nm = 1; ny += 1; }
    setM(nm);
    setY(ny);
  };
  const isSel = (d) => sel && sel.d === d && sel.m === m && sel.y === y;
  const isToday = (d) => today.d === d && today.m === m && today.y === y;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.dpOverlay}>
        <View style={s.dpBox}>
          <View style={s.dpHead}>
            <TouchableOpacity onPress={() => setY(y - 1)}><Text style={s.dpNav}>«</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => move(-1)}><Text style={s.dpNav}>‹</Text></TouchableOpacity>
            <Text style={s.dpTitle}>{MONTHS[m - 1]} {y}</Text>
            <TouchableOpacity onPress={() => move(1)}><Text style={s.dpNav}>›</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => setY(y + 1)}><Text style={s.dpNav}>»</Text></TouchableOpacity>
          </View>
          <View style={s.dpWeek}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <Text key={i} style={s.dpWeekText}>{w}</Text>)}
          </View>
          <View style={s.dpGrid}>
            {cells.map((d, i) => (
              <TouchableOpacity key={i} disabled={!d} style={s.dpCellWrap}
                onPress={() => onPick(pad(d) + '/' + pad(m) + '/' + y)}>
                {d ? (
                  <View style={[s.dpCell, isToday(d) && s.dpToday, isSel(d) && s.dpSel]}>
                    <Text style={[s.dpDay, isSel(d) && { color: '#fff', fontWeight: '700' }]}>{d}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.dpFoot}>
            <TouchableOpacity onPress={() => onPick(todayDMY())}><Text style={s.link}>Aaj</Text></TouchableOpacity>
            {onClear ? <TouchableOpacity onPress={onClear}><Text style={[s.link, { color: RED }]}>Hatao</Text></TouchableOpacity> : null}
            <TouchableOpacity onPress={onClose}><Text style={[s.link, { color: '#666' }]}>Band karo</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function DateField({ label, value, onChange, optional }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      {label ? <Text style={s.label}>{label}</Text> : null}
      <TouchableOpacity style={[s.input, { justifyContent: 'center' }]} onPress={() => setOpen(true)}>
        <Text style={{ fontSize: 15, color: value ? DARK : '#94A3B8' }}>{value || 'Date chuno'}</Text>
      </TouchableOpacity>
      <DatePickerModal visible={open} value={value} onClose={() => setOpen(false)}
        onPick={(v) => { onChange(v); setOpen(false); }}
        onClear={optional && value ? () => { onChange(''); setOpen(false); } : null} />
    </View>
  );
}

function SettingsScreen({ onDone }) {
  const [f, setF] = useState(getSettings());
  const fy = fyOf(todayDMY());
  const [ctr, setCtr] = useState(nextNumber('invoice', todayDMY(), getSettings()).split('/')[0]);
  const [qctr, setQctr] = useState(String(parseInt(getSetting('ctr_quote') || '1', 10)));
  const set = (k) => (v) => setF((prev) => ({ ...prev, [k]: v }));
  const save = () => {
    for (const k of REQUIRED) {
      if (!String(f[k] || '').trim()) return Alert.alert('Ye khali nahi ho sakta', 'Business naam, Invoice series aur Default HSN zaroori hain.');
    }
    Object.keys(DEFAULTS).forEach((k) => setSetting(k, String(f[k] || '').trim()));
    if (parseInt(ctr, 10) > 0) setSetting(counterKey('invoice', fy), parseInt(ctr, 10));
    if (parseInt(qctr, 10) > 0) setSetting('ctr_quote', parseInt(qctr, 10));
    onDone();
  };
  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      <Text style={s.section}>Business details (invoice par chhapte hain)</Text>
      <View style={s.panel}>
      <Field label="Business ka naam" value={f.name} onChangeText={set('name')} />
      <Field label="Address (state bhi likho, jaise MAHARASHTRA- 27)" value={f.address} onChangeText={set('address')} multiline />
      <Field label="Mobile" value={f.mobile} onChangeText={set('mobile')} keyboardType="phone-pad" />
      <Field label="GSTIN" value={f.gstin} onChangeText={set('gstin')} autoCapitalize="characters" />
      <Field label="Udyam Registration No" value={f.udyam} onChangeText={set('udyam')} />
      </View>
      <Text style={s.section}>Bank details</Text>
      <View style={s.panel}>
      <Field label="Bank Name" value={f.bankName} onChangeText={set('bankName')} />
      <Field label="A/C No" value={f.accNo} onChangeText={set('accNo')} keyboardType="number-pad" />
      <Field label="IFSC Code" value={f.ifsc} onChangeText={set('ifsc')} autoCapitalize="characters" />
      </View>
      <Text style={s.section}>Numbering</Text>
      <View style={s.panel}>
      <Field label="Invoice series (jaise DT)" value={f.series} onChangeText={set('series')} />
      <Field label={'Agla invoice number (FY ' + fy + ')'} value={ctr} onChangeText={setCtr} keyboardType="number-pad" />
      <Field label="Agla quotation number" value={qctr} onChangeText={setQctr} keyboardType="number-pad" />
      <Field label="Default HSN/SAC" value={f.defaultHsn} onChangeText={set('defaultHsn')} />
      </View>
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>Save</Text></TouchableOpacity>
    </ScrollView>
  );
}

function CustomerFields({ f, setF }) {
  const set = (k) => (v) => setF((prev) => ({ ...prev, [k]: v }));
  return (
    <View>
      <Field label="Customer / Company ka naam *" value={f.name} onChangeText={set('name')} autoCapitalize="characters" />
      <Field label="Address (state bhi likho, jaise Maharashtra -27)" value={f.address} onChangeText={set('address')} multiline />
      <Field label="GSTIN (optional)" value={f.gstin} onChangeText={set('gstin')} autoCapitalize="characters" />
      <Field label="Phone (optional)" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
    </View>
  );
}

function CustomerScreen({ customer, onDone }) {
  const [f, setF] = useState(customer ? { ...customer } : { name: '', address: '', gstin: '', phone: '' });
  const save = () => {
    if (!String(f.name || '').trim()) return Alert.alert('Naam daalo');
    checkGstin(f.gstin, () => {
      if (customer) updateCustomer(customer.id, f); else addCustomer(f);
      onDone();
    });
  };
  const del = () => Alert.alert('Delete?', 'Customer list se hat jayega. Purane invoice/quotation safe rahenge.', [
    { text: 'Cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { db.runSync('DELETE FROM customers WHERE id = ?', [customer.id]); onDone(); } },
  ]);
  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      <View style={s.panel}><CustomerFields f={f} setF={setF} /></View>
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>Save</Text></TouchableOpacity>
      {customer && <TouchableOpacity style={[s.btn, s.danger]} onPress={del}><Text style={s.btnText}>Delete</Text></TouchableOpacity>}
    </ScrollView>
  );
}

function CustomerPicker({ visible, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', address: '', gstin: '', phone: '' });
  const [list, setList] = useState([]);
  useEffect(() => { if (visible) { setList(getCustomers()); setAdding(false); setQ(''); } }, [visible]);
  const filtered = list.filter((c) => (c.name || '').toLowerCase().includes(q.toLowerCase()));
  const saveNew = () => {
    if (!String(f.name || '').trim()) return Alert.alert('Naam daalo');
    checkGstin(f.gstin, () => {
      const c = addCustomer(f);
      setF({ name: '', address: '', gstin: '', phone: '' });
      onPick(c);
    });
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#f5f6fa', paddingTop: 40 }}>
        <View style={s.modalHead}>
          <Text style={s.bold}>{adding ? 'Naya customer' : 'Customer chuno'}</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.link}>Band karo</Text></TouchableOpacity>
        </View>
        {adding ? (
          <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
            <View style={s.panel}><CustomerFields f={f} setF={setF} /></View>
            <TouchableOpacity style={s.btn} onPress={saveNew}><Text style={s.btnText}>Save karke chuno</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => setAdding(false)}><Text style={[s.link, { textAlign: 'center', marginTop: 14 }]}>← List par wapis</Text></TouchableOpacity>
          </ScrollView>
        ) : (
          <View style={{ flex: 1 }}>
            <Input style={[ { margin: 12 }]} placeholder="Search..." value={q} onChangeText={setQ} />
            <TouchableOpacity style={[s.card, { borderWidth: 1, borderColor: ORANGE }]} onPress={() => setAdding(true)}>
              <Text style={[s.bold, { color: ORANGE }]}>＋ Naya customer add karo</Text>
            </TouchableOpacity>
            <FlatList data={filtered} keyExtractor={(i) => String(i.id)}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={s.empty}>Koi customer nahi mila.</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.card} onPress={() => onPick(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.bold}>{item.name}</Text>
                    <Text style={s.muted} numberOfLines={1}>{item.gstin ? 'GSTIN: ' + item.gstin : item.address}</Text>
                  </View>
                </TouchableOpacity>
              )} />
          </View>
        )}
      </View>
    </Modal>
  );
}

function ItemScreen({ item, onDone }) {
  const S = getSettings();
  const [f, setF] = useState(item ? { ...item } : { kind: 'invoice', descr: '', hsn: S.defaultHsn || '9988', gst: '18', per: 'no', rate: '' });
  const set = (k) => (v) => setF((prev) => ({ ...prev, [k]: v }));
  const isInv = f.kind === 'invoice';
  const save = () => {
    const d = String(f.descr || '').trim();
    if (!d) return Alert.alert('Description daalo');
    const dup = db.getFirstSync('SELECT id FROM saved_items WHERE kind = ? AND lower(descr) = lower(?) AND id != ?', [f.kind, d, item ? item.id : -1]);
    if (dup) return Alert.alert('Ye item pehle se saved hai');
    const vals = [d, String(f.hsn || '').trim(), String(f.gst === undefined || f.gst === null ? '' : f.gst).trim(), String(f.per || '').trim(), String(f.rate || '').trim()];
    if (item) db.runSync('UPDATE saved_items SET descr=?, hsn=?, gst=?, per=?, rate=? WHERE id=?', [...vals, item.id]);
    else db.runSync('INSERT INTO saved_items (kind, descr, hsn, gst, per, rate) VALUES (?,?,?,?,?,?)', [f.kind, ...vals]);
    onDone();
  };
  const del = () => Alert.alert('Delete?', 'Saved list se hat jayega. Purane invoice/quotation par koi asar nahi padega.', [
    { text: 'Cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { db.runSync('DELETE FROM saved_items WHERE id = ?', [item.id]); onDone(); } },
  ]);
  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      {!item && (
        <View>
          <Text style={s.label}>Kis ke liye?</Text>
          <View style={s.chipRow}>
            {[['invoice', 'Invoice item'], ['quotation', 'Quotation item']].map(([k, label]) => (
              <TouchableOpacity key={k} style={[s.chip, f.kind === k && s.chipOn]} onPress={() => set('kind')(k)}>
                <Text style={[s.chipText, f.kind === k && s.chipTextOn]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      <View style={s.panel}>
      <Field label="Description *" value={f.descr} onChangeText={set('descr')} multiline />
      {isInv ? (
        <View>
          <Field label="HSN/SAC" value={f.hsn} onChangeText={set('hsn')} />
          <Field label="GST %" value={String(f.gst)} onChangeText={set('gst')} keyboardType="decimal-pad" />
          <Field label="per (no, kg, hr...)" value={f.per} onChangeText={set('per')} />
          <Field label="Rate ₹" value={String(f.rate)} onChangeText={set('rate')} keyboardType="decimal-pad" />
        </View>
      ) : (
        <Field label="Amount ₹ (optional)" value={String(f.rate)} onChangeText={set('rate')} keyboardType="decimal-pad" />
      )}
      </View>
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>Save</Text></TouchableOpacity>
      {item && <TouchableOpacity style={[s.btn, s.danger]} onPress={del}><Text style={s.btnText}>Delete</Text></TouchableOpacity>}
    </ScrollView>
  );
}

function SavedItemPicker({ visible, kind, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  useEffect(() => { if (visible) { setList(getSavedItems(kind)); setQ(''); } }, [visible]);
  const filtered = list.filter((i) => (i.descr || '').toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#f5f6fa', paddingTop: 40 }}>
        <View style={s.modalHead}>
          <Text style={s.bold}>Saved item chuno</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.link}>Band karo</Text></TouchableOpacity>
        </View>
        <Input style={[ { margin: 12 }]} placeholder="Search..." value={q} onChangeText={setQ} />
        <FlatList data={filtered} keyExtractor={(i) => String(i.id)} keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={s.empty}>
            Koi saved item nahi mila. Item banate waqt "List mein save karo" dabao, ya home par Items tab se add karo.
          </Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.card} onPress={() => onPick(item)}>
              <View style={{ flex: 1 }}>
                <Text style={s.bold} numberOfLines={2}>{item.descr}</Text>
                <Text style={s.muted} numberOfLines={1}>{itemDetail(item)}</Text>
              </View>
            </TouchableOpacity>
          )} />
      </View>
    </Modal>
  );
}

function DocForm({ type, doc, copyFrom, fromQuote, onSaved }) {
  const isInv = type === 'invoice';
  const S = getSettings();
  const src = doc || copyFrom || fromQuote;
  const ex = src ? JSON.parse(src.extra || '{}') : {};
  const [date, setDate] = useState(doc ? doc.date : todayDMY());
  const [number, setNumber] = useState(doc ? doc.number : nextNumber(type, todayDMY(), S));
  const [numTouched, setNumTouched] = useState(!!doc);
  const [customer, setCustomer] = useState(() => {
    if (!src) return null;
    const c = JSON.parse(src.customer || 'null');
    if ((copyFrom || fromQuote) && c && c.id) {
      // Duplicate karte waqt customer ki latest details lo
      const fresh = db.getFirstSync('SELECT * FROM customers WHERE id = ?', [c.id]);
      if (fresh) return fresh;
    }
    return c;
  });
  const [pick, setPick] = useState(false);
  const [pickIdx, setPickIdx] = useState(null);
  const [orderNo, setOrderNo] = useState(doc ? ex.orderNo || '' : '');
  const [orderDate, setOrderDate] = useState(doc ? ex.orderDate || '' : '');
  const [despatch, setDespatch] = useState(ex.despatch || '');
  const [destination, setDestination] = useState(ex.destination || '');
  const blankItem = isInv
    ? { desc: '', hsn: S.defaultHsn || '9988', gst: '18', qty: '1', rate: '', per: 'no' }
    : { date: todayDMY(), desc: '', amount: '' };
  const [items, setItems] = useState(() => {
    if (!src) return [blankItem];
    const arr = JSON.parse(src.items || '[]');
    if (fromQuote) {
      // Quotation ke amount ko Rate maana gaya hai, GST default 18% (form mein badal sakte ho)
      return arr.map((r) => ({ desc: r.desc || '', hsn: S.defaultHsn || '9988', gst: '18', qty: '1', rate: String(r.amount || ''), per: 'no' }));
    }
    if (copyFrom && !isInv) return arr.map((it) => ({ ...it, date: todayDMY() }));
    return arr;
  });

  useEffect(() => {
    if (!doc && !numTouched && isInv) setNumber(nextNumber('invoice', date, S));
  }, [date]);

  const fyNow = fyOf(date);
  const gaps = useMemo(() => (isInv && !doc ? missingNumbers(fyNow) : []), [fyNow]);

  const upd = (i, k, v) => setItems((prev) => prev.map((it, n) => (n === i ? { ...it, [k]: v } : it)));
  const applySaved = (idx, sv) => {
    const fill = (it) => (isInv
      ? { ...it, desc: sv.descr, hsn: sv.hsn || it.hsn, gst: (sv.gst !== null && sv.gst !== undefined && sv.gst !== '') ? sv.gst : it.gst, per: sv.per || it.per, rate: sv.rate || '' }
      : { ...it, desc: sv.descr, amount: sv.rate || '' });
    setItems((prev) => {
      if (idx >= 0) return prev.map((it, n) => (n === idx ? fill(it) : it));
      const empty = prev.findIndex((it) => !String(it.desc || '').trim());
      if (empty >= 0) return prev.map((it, n) => (n === empty ? fill(it) : it));
      return [...prev, fill({ ...blankItem })];
    });
    setPickIdx(null);
  };
  const saveRowToList = (i) => {
    const it = items[i];
    if (!String(it.desc || '').trim()) return Alert.alert('Pehle description daalo');
    const r = saveItemRow(type, it);
    Alert.alert(r === 'added' ? 'Saved list mein add ho gaya ✓' : 'Saved item update ho gaya ✓');
  };
  const inter = isInv && customer ? isInterstate(customer, S.gstin) : false;
  const t = isInv ? calcInvoice(items, inter) : null;
  const total = isInv ? t.total : calcQuote(items);

  const save = () => {
    if (!customer) return Alert.alert('Pehle customer chuno');
    const numTrim = number.trim();
    if (!numTrim) return Alert.alert('Number daalo');
    const dup = db.getFirstSync('SELECT id FROM documents WHERE type = ? AND number = ? AND id != ?', [type, numTrim, doc ? doc.id : -1]);
    if (dup) return Alert.alert('Ye number pehle se use ho chuka hai', 'Koi dusra number daalo.');

    const filled = items.filter((it) => String(it.desc || '').trim());
    if (!filled.length) return Alert.alert('Kam se kam ek item daalo (description ke saath)');
    const orphan = items.find((it) => !String(it.desc || '').trim() && (num(it.rate) > 0 || num(it.amount) > 0));
    if (orphan) return Alert.alert('Description daalo', 'Kisi item mein amount hai par description khali hai.');
    if (isInv) {
      const bad = filled.find((it) => num(it.qty) <= 0 || num(it.rate) <= 0);
      if (bad) return Alert.alert('Qty aur Rate daalo', 'Har item mein Qty aur Rate 0 se zyada hona chahiye.');
    } else {
      const bad = filled.find((it) => num(it.amount) <= 0);
      if (bad) return Alert.alert('Amount daalo', 'Har item mein amount 0 se zyada hona chahiye.');
    }

    const isInter = isInterstate(customer, S.gstin);
    const fq = doc ? ex.fromQuote : (fromQuote ? fromQuote.number : undefined);
    const extra = JSON.stringify(isInv
      ? { orderNo, orderDate, despatch, destination, inter: isInter, fromQuote: fq }
      : (doc ? { invoiceId: ex.invoiceId, invoiceNo: ex.invoiceNo } : {}));
    const cust = JSON.stringify(customer);
    const tot = isInv ? calcInvoice(filled, isInter).total : calcQuote(filled);
    let id;
    if (doc) {
      db.runSync('UPDATE documents SET number=?, date=?, customer_id=?, customer_name=?, customer=?, items=?, extra=?, total=? WHERE id=?',
        [numTrim, date.trim(), customer.id || null, customer.name, cust, JSON.stringify(filled), extra, tot, doc.id]);
      id = doc.id;
    } else {
      const r = db.runSync('INSERT INTO documents (type, number, date, customer_id, customer_name, customer, items, extra, total, paid) VALUES (?,?,?,?,?,?,?,?,?,0)',
        [type, numTrim, date.trim(), customer.id || null, customer.name, cust, JSON.stringify(filled), extra, tot]);
      id = r.lastInsertRowId;
    }
    bumpCounter(type, numTrim, date.trim());
    if (!doc && fromQuote) {
      // Quotation par yaad rakho ki isse invoice ban chuka hai
      const qr = db.getFirstSync('SELECT extra FROM documents WHERE id = ?', [fromQuote.id]);
      const qx = JSON.parse((qr && qr.extra) || '{}');
      qx.invoiceId = id;
      qx.invoiceNo = numTrim;
      db.runSync('UPDATE documents SET extra = ? WHERE id = ?', [JSON.stringify(qx), fromQuote.id]);
    }
    onSaved(id);
  };

  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      <Text style={s.section}>
        {isInv ? 'Tax Invoice' : 'Quotation'}{copyFrom ? ' (copy)' : ''}{fromQuote ? ' (Quotation ' + fromQuote.number + ' se)' : ''}
      </Text>
      {fromQuote ? <Text style={s.muted}>Quotation ka amount "Rate" mein aaya hai aur GST 18% default hai. Check karke Save dabao.</Text> : null}
      <View style={s.panel}>
      <Field label={isInv ? 'Invoice No.' : 'Quotation No.'} value={number} onChangeText={(v) => { setNumber(v); setNumTouched(true); }} />
      {gaps.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={s.muted}>Khali (delete hue) numbers, dabao to number set ho jayega:</Text>
          <View style={s.chipRow}>
            {gaps.slice(0, 8).map((g) => (
              <TouchableOpacity key={g} style={s.chip} onPress={() => { setNumber(g + '/' + S.series + '/' + fyNow); setNumTouched(true); }}>
                <Text style={s.chipText}>{g}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      <DateField label="Date" value={date} onChange={setDate} />

      <Text style={s.label}>Customer</Text>
      <TouchableOpacity style={[s.input, s.pickRow]} onPress={() => setPick(true)}>
        {customer ? <Avatar name={customer.name} size={30} /> : null}
        <Text style={{ flex: 1, fontSize: 15, marginLeft: customer ? 10 : 0, color: customer ? DARK : '#94A3B8', fontWeight: customer ? '600' : '400' }} numberOfLines={1}>
          {customer ? customer.name : 'Customer chuno'}
        </Text>
        <Icon name="chevR" size={16} color="#94A3B8" />
      </TouchableOpacity>
      {customer && isInv && inter && <Text style={s.muted}>Dusre state ka customer: IGST lagega.</Text>}

      {isInv && (
        <View>
          <Field label="Buyer's Order No. (optional)" value={orderNo} onChangeText={setOrderNo} />
          <DateField label="Order Date (optional)" value={orderDate} onChange={setOrderDate} optional />
          <Field label="Despatch Through (optional)" value={despatch} onChangeText={setDespatch} />
          <Field label="Destination (optional)" value={destination} onChangeText={setDestination} />
        </View>
      )}

      </View>

      <Text style={s.section}>Items</Text>
      {items.map((it, i) => (
        <View key={i} style={s.itemBox}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <TouchableOpacity onPress={() => setPickIdx(i)}><Text style={[s.link, { marginTop: 0 }]}>Saved item se chuno</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => saveRowToList(i)}><Text style={[s.link, { marginTop: 0 }]}>List mein save karo</Text></TouchableOpacity>
          </View>
          {!isInv && <DateField value={it.date} onChange={(v) => upd(i, 'date', v)} />}
          <Input style={[ { marginTop: !isInv ? 6 : 0, minHeight: 56 }]} multiline placeholder={isInv ? 'Description of Goods' : 'Description / kaam ki detail'}
            value={it.desc} onChangeText={(v) => upd(i, 'desc', v)} />
          {isInv ? (
            <View>
              <View style={s.row2}>
                <Input style={[ { flex: 1 }]} placeholder="HSN/SAC" value={it.hsn} onChangeText={(v) => upd(i, 'hsn', v)} />
                <Input style={[ { flex: 1 }]} placeholder="GST %" keyboardType="decimal-pad" value={String(it.gst)} onChangeText={(v) => upd(i, 'gst', v)} />
              </View>
              <View style={s.row2}>
                <Input style={[ { flex: 1 }]} placeholder="Qty" keyboardType="decimal-pad" value={String(it.qty)} onChangeText={(v) => upd(i, 'qty', v)} />
                <Input style={[ { flex: 1 }]} placeholder="per (no)" value={it.per} onChangeText={(v) => upd(i, 'per', v)} />
                <Input style={[ { flex: 2 }]} placeholder="Rate ₹" keyboardType="decimal-pad" value={String(it.rate)} onChangeText={(v) => upd(i, 'rate', v)} />
              </View>
              <Text style={[s.muted, { textAlign: 'right' }]}>Amount: ₹{inr(num(it.qty) * num(it.rate))}</Text>
            </View>
          ) : (
            <Input style={[ { marginTop: 6 }]} placeholder="Amount ₹" keyboardType="decimal-pad" value={String(it.amount)} onChangeText={(v) => upd(i, 'amount', v)} />
          )}
          {items.length > 1 && (
            <TouchableOpacity onPress={() => setItems((prev) => prev.filter((_, n) => n !== i))}>
              <Text style={[s.link, { color: RED, marginTop: 6 }]}>Ye item hatao</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 22, flexWrap: 'wrap' }}>
        <TouchableOpacity onPress={() => setItems((prev) => [...prev, { ...blankItem, ...(isInv ? {} : { date: todayDMY() }) }])}>
          <Text style={s.link}>+ Item add karo</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setPickIdx(-1)}>
          <Text style={s.link}>Saved item add karo</Text>
        </TouchableOpacity>
      </View>

      <Totals isInv={isInv} t={t} total={total} />
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>{doc ? 'Update karo' : 'Save karo'}</Text></TouchableOpacity>

      <CustomerPicker visible={pick} onClose={() => setPick(false)} onPick={(c) => { setCustomer(c); setPick(false); }} />
      <SavedItemPicker visible={pickIdx !== null} kind={type} onClose={() => setPickIdx(null)} onPick={(sv) => applySaved(pickIdx, sv)} />
    </ScrollView>
  );
}

function DocView({ docId, setScreen, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const doc = db.getFirstSync('SELECT * FROM documents WHERE id = ?', [docId]);
  if (!doc) return <Text style={s.empty}>Document nahi mila.</Text>;
  const isInv = doc.type === 'invoice';
  const c = JSON.parse(doc.customer || '{}');
  const items = JSON.parse(doc.items || '[]');
  const S = getSettings();
  const t = isInv ? calcInvoice(items, docInter(doc, S)) : null;
  const paid = !!doc.paid;
  const x = JSON.parse(doc.extra || '{}');
  const linked = !isInv && x.invoiceId ? db.getFirstSync('SELECT id, number FROM documents WHERE id = ?', [x.invoiceId]) : null;
  const toInvoice = () => {
    const go = () => setScreen({ name: 'docForm', type: 'invoice', fromQuote: doc });
    if (linked) {
      Alert.alert('Invoice pehle se ban chuka hai', 'Is quotation se invoice ' + linked.number + ' ban chuka hai. Phir bhi naya invoice banana hai?',
        [{ text: 'Nahi' }, { text: 'Haan, banao', onPress: go }]);
    } else go();
  };

  const share = async () => { setBusy(true); await makeAndSharePdf(doc); setBusy(false); };
  const togglePaid = () => {
    if (paid) db.runSync('UPDATE documents SET paid = 0, paid_date = NULL WHERE id = ?', [doc.id]);
    else db.runSync('UPDATE documents SET paid = 1, paid_date = ? WHERE id = ?', [todayDMY(), doc.id]);
    setTick((x) => x + 1);
  };
  const del = () => Alert.alert('Delete?', 'Ye hamesha ke liye hat jayega.', [
    { text: 'Cancel' },
    {
      text: 'Delete', style: 'destructive',
      onPress: () => {
        db.runSync('DELETE FROM documents WHERE id = ?', [doc.id]);
        resyncAfterDelete(doc);
        onDeleted();
      },
    },
  ]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
      <View style={s.docHero}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Avatar name={c.name} size={46} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.docName} numberOfLines={2}>{c.name}</Text>
            <Text style={s.muted}>{isInv ? 'Invoice' : 'Quotation'} {doc.number}</Text>
          </View>
        </View>
        <View style={s.docMeta}>
          <View>
            <Text style={s.metaLbl}>Date</Text>
            <Text style={s.metaVal}>{doc.date}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.metaLbl}>Total</Text>
            <Text style={s.docTotal}>₹{isInv ? inr(t.total) : inrQ(num(doc.total))}</Text>
          </View>
        </View>
      </View>

      {isInv && x.fromQuote ? <Text style={[s.muted, { marginTop: 10 }]}>Quotation {x.fromQuote} se bana</Text> : null}
      {linked ? (
        <TouchableOpacity onPress={() => setScreen({ name: 'docView', docId: linked.id })}>
          <Text style={[s.muted, { color: '#15803D', fontWeight: '700', marginTop: 10 }]}>Invoice ban chuka hai: {linked.number} (dekho)</Text>
        </TouchableOpacity>
      ) : null}

      <View style={[s.statusBox, { backgroundColor: paid ? '#DCFCE7' : '#FEE2E2' }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.cardTitle, { color: paid ? '#15803D' : '#B91C1C' }]}>{paid ? 'Paid' : 'Payment pending'}</Text>
          {paid && doc.paid_date ? <Text style={s.muted}>Payment mili: {doc.paid_date}</Text> : null}
        </View>
        <TouchableOpacity style={[s.smallBtn, { backgroundColor: paid ? '#475569' : GREEN }]} onPress={togglePaid}>
          <Text style={s.smallBtnText}>{paid ? 'Unpaid karo' : 'Paid mark karo'}</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.section}>Items</Text>
      <View style={[s.panel, { paddingVertical: 4 }]}>
        {items.map((i, n) => (
          <View key={n} style={[s.itemRow, n === 0 && { borderTopWidth: 0 }]}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={s.itemDesc}>{i.desc}</Text>
              <Text style={s.muted}>
                {isInv ? i.qty + ' × ₹' + inr(num(i.rate)) + (num(i.gst) ? '   GST ' + num(i.gst) + '%' : '') : i.date}
              </Text>
            </View>
            <Text style={s.itemAmt}>₹{isInv ? inr(num(i.qty) * num(i.rate)) : inrQ(num(i.amount))}</Text>
          </View>
        ))}
      </View>
      <Totals isInv={isInv} t={t} total={isInv ? t.total : num(doc.total)} />

      <TouchableOpacity style={s.btn} onPress={share} disabled={busy}>
        <Text style={s.btnText}>{busy ? 'PDF ban raha hai...' : 'PDF banao / Share karo'}</Text>
      </TouchableOpacity>
      <Text style={[s.mutedSm, { textAlign: 'center', marginTop: 6 }]}>{pdfName(doc)}</Text>
      {!isInv && (
        <TouchableOpacity style={[s.btn, { backgroundColor: GREEN }]} onPress={toInvoice}>
          <Text style={s.btnText}>{linked ? 'Dobara Invoice banao' : 'Invoice banao (is quotation se)'}</Text>
        </TouchableOpacity>
      )}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <TouchableOpacity style={s.btnGhost} onPress={() => setScreen({ name: 'docForm', type: doc.type, copyFrom: doc })}>
          <Text style={s.btnGhostText}>Duplicate</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnGhost} onPress={() => setScreen({ name: 'docForm', type: doc.type, doc })}>
          <Text style={s.btnGhostText}>Edit</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={del} style={{ alignItems: 'center', marginTop: 18, padding: 8 }}>
        <Text style={{ color: RED, fontWeight: '700' }}>Delete {isInv ? 'invoice' : 'quotation'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ----------------------- Reports -----------------------
function Cell({ children, flex = 1, bold, right, color }) {
  return (
    <Text style={[s.tCell, { flex }, right && { textAlign: 'right' }, bold && { fontWeight: '700' }, color && { color }]}
      numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
      {children}
    </Text>
  );
}

function ReportsScreen() {
  const S = getSettings();
  const all = useMemo(() => getDocs('invoice').map((d) => {
    const items = JSON.parse(d.items || '[]');
    const inter = docInter(d, S);
    const p = parseDMY(d.date);
    return {
      d,
      t: calcInvoice(items, inter),
      rates: gstByRate(items, inter),
      fy: fyOf(d.date),
      mk: p ? p.y * 100 + p.m : 0,
      paid: !!d.paid,
    };
  }), []);

  const fys = useMemo(() => {
    const set = new Set(all.map((x) => x.fy));
    set.add(fyOf(todayDMY()));
    return Array.from(set).sort().reverse();
  }, [all]);
  const [fy, setFy] = useState(fys[0]);
  const [month, setMonth] = useState(null);

  const inFy = all.filter((x) => x.fy === fy);
  const monthsMap = {};
  inFy.forEach((x) => {
    const o = monthsMap[x.mk] || (monthsMap[x.mk] = { mk: x.mk, count: 0, sub: 0, tax: 0, total: 0, pending: 0 });
    o.count += 1;
    o.sub += x.t.sub;
    o.tax += x.t.tax;
    o.total += x.t.total;
    if (!x.paid) o.pending += x.t.total;
  });
  const monthList = Object.values(monthsMap).sort((a, b) => a.mk - b.mk);
  const scope = month ? inFy.filter((x) => x.mk === month) : inFy;

  const sum = (arr, k) => r2(arr.reduce((a, x) => a + x[k], 0));
  const totals = {
    count: scope.length,
    sub: r2(scope.reduce((a, x) => a + x.t.sub, 0)),
    tax: r2(scope.reduce((a, x) => a + x.t.tax, 0)),
    total: r2(scope.reduce((a, x) => a + x.t.total, 0)),
    pending: r2(scope.filter((x) => !x.paid).reduce((a, x) => a + x.t.total, 0)),
  };

  const rateMap = {};
  scope.forEach((x) => {
    Object.keys(x.rates).forEach((k) => {
      const o = rateMap[k] || (rateMap[k] = { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
      o.taxable += x.rates[k].taxable;
      o.cgst += x.rates[k].cgst;
      o.sgst += x.rates[k].sgst;
      o.igst += x.rates[k].igst;
    });
  });
  const rateRows = Object.keys(rateMap).map(Number).sort((a, b) => a - b).map((k) => ({ rate: k, ...rateMap[k] }));
  const gt = {
    taxable: sum(rateRows, 'taxable'), cgst: sum(rateRows, 'cgst'), sgst: sum(rateRows, 'sgst'), igst: sum(rateRows, 'igst'),
  };
  const monthLabel = (mk) => MON3[(mk % 100) - 1] + ' ' + Math.floor(mk / 100);

  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 80 }}>
      <Text style={s.section}>Financial Year (Apr - Mar)</Text>
      <View style={s.chipRow}>
        {fys.map((f) => (
          <TouchableOpacity key={f} style={[s.chip, fy === f && s.chipOn]} onPress={() => { setFy(f); setMonth(null); }}>
            <Text style={[s.chipText, fy === f && s.chipTextOn]}>FY {f}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[s.section, { marginTop: 16 }]}>
        {month ? monthLabel(month) : 'Poora saal'} ka saar ({totals.count} invoice)
      </Text>
      <View style={s.statGrid}>
        <View style={s.stat}><Text style={s.statLabel}>Total Sales</Text><Text style={s.statVal}>₹{inr(totals.total)}</Text></View>
        <View style={s.stat}><Text style={s.statLabel}>Taxable Value</Text><Text style={s.statVal}>₹{inr(totals.sub)}</Text></View>
        <View style={s.stat}><Text style={s.statLabel}>Total GST</Text><Text style={s.statVal}>₹{inr(totals.tax)}</Text></View>
        <View style={s.stat}><Text style={s.statLabel}>Pending (unpaid)</Text><Text style={[s.statVal, { color: totals.pending ? RED : GREEN }]}>₹{inr(totals.pending)}</Text></View>
      </View>

      <Text style={[s.section, { marginTop: 18 }]}>Month-wise Sales</Text>
      <Text style={s.muted}>Month par dabao: neeche GST summary sirf us mahine ki dikhegi.</Text>
      <View style={s.table}>
        <View style={[s.tRow, s.tHead]}>
          <Cell flex={1.3} bold>Month</Cell><Cell flex={0.6} bold right>Inv</Cell>
          <Cell flex={1.2} bold right>Taxable</Cell><Cell flex={1} bold right>GST</Cell><Cell flex={1.2} bold right>Total</Cell>
        </View>
        {monthList.length === 0 && <Text style={[s.empty, { marginTop: 16, marginBottom: 16 }]}>Is saal koi invoice nahi.</Text>}
        {monthList.map((m) => (
          <TouchableOpacity key={m.mk} style={[s.tRow, month === m.mk && { backgroundColor: '#fff3e8' }]}
            onPress={() => setMonth(month === m.mk ? null : m.mk)}>
            <Cell flex={1.3}>{monthLabel(m.mk)}</Cell><Cell flex={0.6} right>{m.count}</Cell>
            <Cell flex={1.2} right>{inr(m.sub)}</Cell><Cell flex={1} right>{inr(m.tax)}</Cell><Cell flex={1.2} right>{inr(m.total)}</Cell>
          </TouchableOpacity>
        ))}
        {monthList.length > 0 && (
          <View style={[s.tRow, s.tHead]}>
            <Cell flex={1.3} bold>Total</Cell><Cell flex={0.6} bold right>{inFy.length}</Cell>
            <Cell flex={1.2} bold right>{inr(sum(inFy.map((x) => x.t), 'sub'))}</Cell>
            <Cell flex={1} bold right>{inr(sum(inFy.map((x) => x.t), 'tax'))}</Cell>
            <Cell flex={1.2} bold right>{inr(sum(inFy.map((x) => x.t), 'total'))}</Cell>
          </View>
        )}
      </View>
      {month ? (
        <TouchableOpacity onPress={() => setMonth(null)}><Text style={s.link}>← Poore saal ka dikhao</Text></TouchableOpacity>
      ) : null}

      <Text style={[s.section, { marginTop: 18 }]}>GST Summary ({month ? monthLabel(month) : 'FY ' + fy})</Text>
      <View style={s.table}>
        <View style={[s.tRow, s.tHead]}>
          <Cell flex={0.8} bold>Rate</Cell><Cell flex={1.4} bold right>Taxable</Cell>
          <Cell flex={1} bold right>CGST</Cell><Cell flex={1} bold right>SGST</Cell><Cell flex={1} bold right>IGST</Cell>
        </View>
        {rateRows.length === 0 && <Text style={[s.empty, { marginTop: 16, marginBottom: 16 }]}>Koi data nahi.</Text>}
        {rateRows.map((r) => (
          <View key={r.rate} style={s.tRow}>
            <Cell flex={0.8}>{r.rate ? r.rate + '%' : '0%'}</Cell><Cell flex={1.4} right>{inr(r.taxable)}</Cell>
            <Cell flex={1} right>{inr(r.cgst)}</Cell><Cell flex={1} right>{inr(r.sgst)}</Cell><Cell flex={1} right>{inr(r.igst)}</Cell>
          </View>
        ))}
        {rateRows.length > 0 && (
          <View style={[s.tRow, s.tHead]}>
            <Cell flex={0.8} bold>Total</Cell><Cell flex={1.4} bold right>{inr(gt.taxable)}</Cell>
            <Cell flex={1} bold right>{inr(gt.cgst)}</Cell><Cell flex={1} bold right>{inr(gt.sgst)}</Cell><Cell flex={1} bold right>{inr(gt.igst)}</Cell>
          </View>
        )}
      </View>
      <Text style={[s.muted, { marginTop: 8 }]}>
        Total GST = CGST + SGST + IGST = ₹{inr(gt.cgst + gt.sgst + gt.igst)}. Sirf Tax Invoices ginti mein hain (quotation nahi).
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: { backgroundColor: DARK, paddingHorizontal: 16, paddingBottom: 14, flexDirection: 'row', alignItems: 'center' },
  logo: { width: 40, height: 40, borderRadius: 11 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', letterSpacing: -0.2 },
  subtitle: { color: '#94A3B8', fontSize: 12, marginTop: 1 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },

  hero: { backgroundColor: DARK, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 38, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  heroLabel: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  heroAmt: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 2, letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  heroRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  heroPill: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  heroPillText: { color: '#E2E8F0', fontSize: 12.5, fontWeight: '600' },

  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 16, marginTop: -24, borderRadius: 14, paddingHorizontal: 14, ...SH },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 13, paddingLeft: 10, color: DARK },
  seg: { flexDirection: 'row', backgroundColor: '#E6EAF0', borderRadius: 12, padding: 3, marginHorizontal: 16, marginTop: 12, marginBottom: 6 },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
  segOn: { backgroundColor: '#fff', ...SH, shadowOpacity: 0.05, elevation: 1 },
  segText: { color: MUTE, fontWeight: '600', fontSize: 13 },
  segTextOn: { color: DARK, fontWeight: '700' },

  card: { backgroundColor: '#fff', marginHorizontal: 16, marginTop: 10, padding: 14, borderRadius: 16, flexDirection: 'row', alignItems: 'center', ...SH },
  cardTitle: { fontSize: 15.5, fontWeight: '700', color: DARK },
  amt: { fontSize: 16, fontWeight: '800', color: DARK, fontVariant: ['tabular-nums'] },
  itemIcon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  pillText: { fontSize: 11.5, fontWeight: '700' },

  nav: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: LINE },
  navItem: { flex: 1, alignItems: 'center', paddingTop: 0, paddingBottom: 8 },
  navBar: { height: 3, width: 28, borderRadius: 2, marginBottom: 8, backgroundColor: 'transparent' },
  navText: { fontSize: 11, color: '#94A3B8', marginTop: 3, fontWeight: '600' },
  fab: { position: 'absolute', right: 20, bottom: 18, backgroundColor: ORANGE, width: 58, height: 58, borderRadius: 20, alignItems: 'center', justifyContent: 'center', shadowColor: ORANGE, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 },

  emptyWrap: { alignItems: 'center', paddingHorizontal: 36, paddingTop: 48 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: '#FFEDD5', alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: DARK, marginTop: 16 },
  emptyText: { fontSize: 13.5, color: MUTE, textAlign: 'center', marginTop: 6, lineHeight: 19 },
  empty: { textAlign: 'center', marginTop: 60, color: '#94A3B8', paddingHorizontal: 20 },

  input: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: LINE, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, minHeight: 48, color: DARK },
  inputFocus: { borderColor: ORANGE, backgroundColor: '#fff' },
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start' },
  label: { marginTop: 14, marginBottom: 6, color: '#475569', fontWeight: '600', fontSize: 12.5 },
  section: { fontSize: 15, fontWeight: '800', color: DARK, marginTop: 22, marginBottom: 4, letterSpacing: -0.1 },
  panel: { backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, marginTop: 8, ...SH },
  bold: { fontWeight: '700', fontSize: 16, color: DARK },
  muted: { color: MUTE, marginTop: 2, fontSize: 13 },
  mutedSm: { color: '#94A3B8', fontSize: 12, marginTop: 1 },

  btn: { backgroundColor: ORANGE, paddingVertical: 15, borderRadius: 14, alignItems: 'center', marginTop: 16, shadowColor: ORANGE, shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  danger: { backgroundColor: RED, shadowColor: RED },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnGhost: { flex: 1, borderWidth: 1.5, borderColor: LINE, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  btnGhostText: { color: DARK, fontWeight: '700', fontSize: 15 },
  link: { color: ORANGE_D, fontWeight: '700', marginTop: 8 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  smallBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  itemBox: { backgroundColor: '#fff', padding: 12, borderRadius: 16, marginTop: 10, borderWidth: 1, borderColor: LINE },
  row2: { flexDirection: 'row', gap: 8, marginTop: 8 },
  row: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: LINE },

  totalBox: { backgroundColor: '#fff', padding: 16, borderRadius: 16, marginTop: 14, ...SH },
  sumRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  sumLbl: { color: MUTE, fontSize: 14 },
  sumVal: { color: DARK, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  grandRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: LINE, marginTop: 8, paddingTop: 10 },
  grandLbl: { fontSize: 15, fontWeight: '700', color: DARK },
  grand: { fontSize: 22, fontWeight: '800', color: DARK, fontVariant: ['tabular-nums'] },

  docHero: { backgroundColor: '#fff', borderRadius: 18, padding: 16, ...SH },
  docName: { fontSize: 18, fontWeight: '800', color: DARK },
  docMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', borderTopWidth: 1, borderTopColor: LINE, marginTop: 14, paddingTop: 12 },
  metaLbl: { color: '#94A3B8', fontSize: 12, fontWeight: '600' },
  metaVal: { color: DARK, fontSize: 15, fontWeight: '700', marginTop: 2 },
  docTotal: { color: DARK, fontSize: 24, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  statusBox: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, padding: 12, marginTop: 14 },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 11, borderTopWidth: 1, borderTopColor: LINE },
  itemDesc: { fontSize: 14.5, fontWeight: '600', color: DARK },
  itemAmt: { fontSize: 14.5, fontWeight: '700', color: DARK, fontVariant: ['tabular-nums'] },

  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: LINE },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#fff', borderWidth: 1, borderColor: LINE },
  chipOn: { backgroundColor: DARK, borderColor: DARK },
  chipText: { color: '#475569', fontWeight: '600' },
  chipTextOn: { color: '#fff' },

  dpOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', justifyContent: 'center', padding: 20 },
  dpBox: { backgroundColor: '#fff', borderRadius: 20, padding: 14 },
  dpHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  dpNav: { fontSize: 24, fontWeight: '700', color: ORANGE_D, paddingHorizontal: 10 },
  dpTitle: { fontSize: 16, fontWeight: '800', color: DARK },
  dpWeek: { flexDirection: 'row' },
  dpWeekText: { width: '14.285%', textAlign: 'center', color: '#94A3B8', fontWeight: '700', paddingVertical: 4 },
  dpGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dpCellWrap: { width: '14.285%', alignItems: 'center', justifyContent: 'center', paddingVertical: 3 },
  dpCell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  dpToday: { borderWidth: 1.5, borderColor: ORANGE },
  dpSel: { backgroundColor: ORANGE },
  dpDay: { fontSize: 15, color: DARK },
  dpFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingHorizontal: 8 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  stat: { backgroundColor: '#fff', borderRadius: 16, padding: 14, width: '48.3%', ...SH },
  statLabel: { color: MUTE, fontSize: 12.5, fontWeight: '600' },
  statVal: { fontSize: 17, fontWeight: '800', marginTop: 6, color: DARK, fontVariant: ['tabular-nums'] },
  table: { backgroundColor: '#fff', borderRadius: 16, marginTop: 10, overflow: 'hidden', ...SH },
  tRow: { flexDirection: 'row', paddingVertical: 11, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#EEF1F5' },
  tHead: { backgroundColor: '#F1F5F9' },
  tCell: { fontSize: 12, color: DARK, paddingHorizontal: 2, fontVariant: ['tabular-nums'] },
});
