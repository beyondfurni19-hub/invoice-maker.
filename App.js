import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, FlatList,
  Alert, StyleSheet, Platform, BackHandler, Modal, Image,
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
const fyOf = (dmy) => {
  const p = String(dmy || '').split('/');
  let m = parseInt(p[1], 10);
  let y = parseInt(p[2], 10);
  if (!m || !y) {
    const d = new Date();
    m = d.getMonth() + 1;
    y = d.getFullYear();
  }
  const start = m >= 4 ? y : y - 1;
  return String(start).slice(2) + '-' + String(start + 1).slice(2);
};

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

const isInterstate = (cust, sellerGstin) => {
  const b = String((cust && cust.gstin) || '').trim();
  if (b.length < 2) return false;
  return b.slice(0, 2) !== String(sellerGstin || '27').trim().slice(0, 2);
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
  const inter = isInterstate(c, S.gstin);
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
  const one = '<html><head><meta charset="utf-8"/><style>' +
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
    '<div class="sm">Mobile: ' + esc(S.mobile) + ', Maharashtra -27</div><div class="b sm">GSTIN/UIN:' + esc(S.gstin) + '</div></td>' +
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
  // Same invoice twice in one PDF: page 1 = Original, page 2 = Duplicate
  const bs = one.indexOf('<body>') + 6;
  const be = one.lastIndexOf('</body>');
  const body = one.slice(bs, be);
  const dup = body.replace('( ORIGINAL FOR RECIPIENT)', '( DUPLICATE FOR TRANSPORTER)');
  return one.slice(0, bs) + '<div>' + body + '</div>' +
    '<div style="page-break-before:always">' + dup + '</div>' + one.slice(be);
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

const getSettings = () => {
  const s = { ...DEFAULTS };
  db.getAllSync('SELECT key, value FROM settings').forEach((r) => { s[r.key] = r.value; });
  return s;
};
const setSetting = (k, v) => db.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);
const getSetting = (k) => {
  const r = db.getFirstSync('SELECT value FROM settings WHERE key = ?', [k]);
  return r ? r.value : null;
};

const getCustomers = () => db.getAllSync('SELECT * FROM customers ORDER BY name COLLATE NOCASE');
const addCustomer = (c) => {
  const r = db.runSync('INSERT INTO customers (name, address, gstin, phone) VALUES (?,?,?,?)',
    [c.name.trim(), c.address || '', String(c.gstin || '').trim().toUpperCase(), c.phone || '']);
  return { id: r.lastInsertRowId, name: c.name.trim(), address: c.address || '', gstin: String(c.gstin || '').trim().toUpperCase(), phone: c.phone || '' };
};
const updateCustomer = (id, c) => db.runSync('UPDATE customers SET name=?, address=?, gstin=?, phone=? WHERE id=?',
  [c.name.trim(), c.address || '', String(c.gstin || '').trim().toUpperCase(), c.phone || '', id]);

const getDocs = (type) => db.getAllSync('SELECT * FROM documents WHERE type = ? ORDER BY id DESC', [type]);

// Invoice numbers: 20/DT/26-27 (har financial year mein 1 se shuru)
const counterKey = (type, fy) => (type === 'invoice' ? 'ctr_inv_' + fy : 'ctr_quote');
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
  const m = type === 'invoice' ? parseInt(number, 10) : parseInt(String(number).replace(/\D/g, ''), 10);
  if (!m) return;
  const key = counterKey(type, fyOf(dmy));
  const cur = parseInt(getSetting(key) || '0', 10);
  if (m + 1 > cur) setSetting(key, m + 1);
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
const DARK = '#1a1a1a';

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

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'home') return false;
      if (screen.name === 'docForm' && screen.doc) setScreen({ name: 'docView', docId: screen.doc.id });
      else goHome();
      return true;
    });
    return () => sub.remove();
  }, [screen]);

  const titles = { home: 'Durgesh Tools', settings: 'Settings', custForm: 'Customer', docForm: 'Document', docView: 'Document' };

  return (
    <View style={[s.root, { paddingBottom: insets.bottom }]}>
      <View style={[s.header, { paddingTop: insets.top + 10 }]}>
        {screen.name !== 'home' ? (
          <TouchableOpacity onPress={() => (screen.name === 'docForm' && screen.doc ? setScreen({ name: 'docView', docId: screen.doc.id }) : goHome())}>
            <Text style={s.headerBtn}>← Back</Text>
          </TouchableOpacity>
        ) : (
          <Image source={require('./icon.png')} style={s.logo} />
        )}
        <Text style={s.title}>{titles[screen.name]}</Text>
        {screen.name === 'home' ? (
          <TouchableOpacity onPress={() => setScreen({ name: 'settings' })}>
            <Text style={s.headerBtn}>⚙ Settings</Text>
          </TouchableOpacity>
        ) : <View style={{ width: 60 }} />}
      </View>

      {screen.name === 'home' && (
        <Home tab={tab} setTab={setTab} tick={tick} setScreen={setScreen} />
      )}
      {screen.name === 'settings' && <SettingsScreen onDone={goHome} />}
      {screen.name === 'custForm' && <CustomerScreen customer={screen.customer} onDone={goHome} />}
      {screen.name === 'docForm' && (
        <DocForm type={screen.type} doc={screen.doc}
          onSaved={(id) => { refresh(); setScreen({ name: 'docView', docId: id }); }} />
      )}
      {screen.name === 'docView' && <DocView docId={screen.docId} setScreen={setScreen} onDeleted={goHome} />}
    </View>
  );
}

function Home({ tab, setTab, tick, setScreen }) {
  const [search, setSearch] = useState('');
  const [list, setList] = useState([]);
  useEffect(() => {
    setList(tab === 'customer' ? getCustomers() : getDocs(tab));
  }, [tab, tick]);

  const q = search.toLowerCase();
  const filtered = list.filter((i) => tab === 'customer'
    ? (i.name || '').toLowerCase().includes(q)
    : (i.customer_name || '').toLowerCase().includes(q) || (i.number || '').toLowerCase().includes(q));

  const addNew = () => {
    if (tab === 'customer') setScreen({ name: 'custForm' });
    else setScreen({ name: 'docForm', type: tab });
  };
  const tabs = [['invoice', 'Invoices'], ['quotation', 'Quotations'], ['customer', 'Customers']];

  return (
    <View style={{ flex: 1 }}>
      <View style={s.tabs}>
        {tabs.map(([k, label]) => (
          <TouchableOpacity key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => { setTab(k); setSearch(''); }}>
            <Text style={[s.tabText, tab === k && s.tabTextOn]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput style={[s.input, { margin: 12, marginBottom: 4 }]} placeholder="Search..." value={search} onChangeText={setSearch} />
      <FlatList
        data={filtered}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={{ paddingBottom: 100 }}
        ListEmptyComponent={<Text style={s.empty}>
          {tab === 'customer' ? 'Abhi koi customer nahi hai. Neeche ＋ dabao.' : 'Abhi kuch nahi hai. Neeche ＋ dabao.'}
        </Text>}
        renderItem={({ item }) => tab === 'customer' ? (
          <TouchableOpacity style={s.card} onPress={() => setScreen({ name: 'custForm', customer: item })}>
            <View style={{ flex: 1 }}>
              <Text style={s.bold}>{item.name}</Text>
              <Text style={s.muted} numberOfLines={1}>{item.gstin ? 'GSTIN: ' + item.gstin : item.phone || item.address}</Text>
            </View>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.card} onPress={() => setScreen({ name: 'docView', docId: item.id })}>
            <View style={{ flex: 1 }}>
              <Text style={s.bold}>{item.customer_name}</Text>
              <Text style={s.muted}>{item.number} • {item.date}</Text>
            </View>
            <Text style={s.bold}>₹{item.type === 'invoice' ? fmt(item.total) : fmtQ(item.total)}</Text>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity style={s.fab} onPress={addNew}>
        <Text style={s.fabText}>＋</Text>
      </TouchableOpacity>
    </View>
  );
}

function Field({ label, value, onChangeText, ...rest }) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={onChangeText} {...rest} />
    </View>
  );
}

function SettingsScreen({ onDone }) {
  const [f, setF] = useState(getSettings());
  const fy = fyOf(todayDMY());
  const [ctr, setCtr] = useState(nextNumber('invoice', todayDMY(), getSettings()).split('/')[0]);
  const [qctr, setQctr] = useState(String(parseInt(getSetting('ctr_quote') || '1', 10)));
  const set = (k) => (v) => setF({ ...f, [k]: v });
  const save = () => {
    Object.keys(DEFAULTS).forEach((k) => setSetting(k, f[k] || ''));
    if (parseInt(ctr, 10) > 0) setSetting(counterKey('invoice', fy), parseInt(ctr, 10));
    if (parseInt(qctr, 10) > 0) setSetting('ctr_quote', parseInt(qctr, 10));
    onDone();
  };
  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      <Text style={s.section}>Business details (invoice par chhapte hain)</Text>
      <Field label="Business ka naam" value={f.name} onChangeText={set('name')} />
      <Field label="Address" value={f.address} onChangeText={set('address')} multiline />
      <Field label="Mobile" value={f.mobile} onChangeText={set('mobile')} keyboardType="phone-pad" />
      <Field label="GSTIN" value={f.gstin} onChangeText={set('gstin')} autoCapitalize="characters" />
      <Field label="Udyam Registration No" value={f.udyam} onChangeText={set('udyam')} />
      <Text style={s.section}>Bank details</Text>
      <Field label="Bank Name" value={f.bankName} onChangeText={set('bankName')} />
      <Field label="A/C No" value={f.accNo} onChangeText={set('accNo')} keyboardType="number-pad" />
      <Field label="IFSC Code" value={f.ifsc} onChangeText={set('ifsc')} autoCapitalize="characters" />
      <Text style={s.section}>Numbering</Text>
      <Field label="Invoice series (jaise DT)" value={f.series} onChangeText={set('series')} />
      <Field label={'Agla invoice number (FY ' + fy + ')'} value={ctr} onChangeText={setCtr} keyboardType="number-pad" />
      <Field label="Agla quotation number" value={qctr} onChangeText={setQctr} keyboardType="number-pad" />
      <Field label="Default HSN/SAC" value={f.defaultHsn} onChangeText={set('defaultHsn')} />
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>Save</Text></TouchableOpacity>
    </ScrollView>
  );
}

function CustomerFields({ f, setF }) {
  const set = (k) => (v) => setF({ ...f, [k]: v });
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
    if (!f.name.trim()) return Alert.alert('Naam daalo');
    if (customer) updateCustomer(customer.id, f); else addCustomer(f);
    onDone();
  };
  const del = () => Alert.alert('Delete?', 'Customer list se hat jayega. Purane invoice/quotation safe rahenge.', [
    { text: 'Cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { db.runSync('DELETE FROM customers WHERE id = ?', [customer.id]); onDone(); } },
  ]);
  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      <CustomerFields f={f} setF={setF} />
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
    if (!f.name.trim()) return Alert.alert('Naam daalo');
    const c = addCustomer(f);
    setF({ name: '', address: '', gstin: '', phone: '' });
    onPick(c);
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
            <CustomerFields f={f} setF={setF} />
            <TouchableOpacity style={s.btn} onPress={saveNew}><Text style={s.btnText}>Save karke chuno</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => setAdding(false)}><Text style={[s.link, { textAlign: 'center', marginTop: 14 }]}>← List par wapis</Text></TouchableOpacity>
          </ScrollView>
        ) : (
          <View style={{ flex: 1 }}>
            <TextInput style={[s.input, { margin: 12 }]} placeholder="Search..." value={q} onChangeText={setQ} />
            <TouchableOpacity style={[s.card, { borderWidth: 1, borderColor: ORANGE }]} onPress={() => setAdding(true)}>
              <Text style={[s.bold, { color: ORANGE }]}>＋ Naya customer add karo</Text>
            </TouchableOpacity>
            <FlatList data={filtered} keyExtractor={(i) => String(i.id)}
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

function DocForm({ type, doc, onSaved }) {
  const isInv = type === 'invoice';
  const S = getSettings();
  const ex = doc ? JSON.parse(doc.extra || '{}') : {};
  const [date, setDate] = useState(doc ? doc.date : todayDMY());
  const [number, setNumber] = useState(doc ? doc.number : nextNumber(type, todayDMY(), S));
  const [numTouched, setNumTouched] = useState(!!doc);
  const [customer, setCustomer] = useState(doc ? JSON.parse(doc.customer || 'null') : null);
  const [pick, setPick] = useState(false);
  const [orderNo, setOrderNo] = useState(ex.orderNo || '');
  const [orderDate, setOrderDate] = useState(ex.orderDate || '');
  const [despatch, setDespatch] = useState(ex.despatch || '');
  const [destination, setDestination] = useState(ex.destination || '');
  const blankItem = isInv
    ? { desc: '', hsn: S.defaultHsn || '9988', gst: '18', qty: '1', rate: '', per: 'no' }
    : { date: todayDMY(), desc: '', amount: '' };
  const [items, setItems] = useState(doc ? JSON.parse(doc.items || '[]') : [blankItem]);

  useEffect(() => {
    if (!doc && !numTouched && isInv) setNumber(nextNumber('invoice', date, S));
  }, [date]);

  const upd = (i, k, v) => setItems(items.map((it, n) => (n === i ? { ...it, [k]: v } : it)));
  const inter = isInv && customer ? isInterstate(customer, S.gstin) : false;
  const t = isInv ? calcInvoice(items, inter) : null;
  const total = isInv ? t.total : calcQuote(items);

  const save = () => {
    if (!customer) return Alert.alert('Pehle customer chuno');
    if (!number.trim()) return Alert.alert('Number daalo');
    const clean = items.filter((it) => String(it.desc || '').trim() && (isInv ? num(it.qty) > 0 : true));
    if (!clean.length) return Alert.alert('Kam se kam ek item daalo (description ke saath)');
    const extra = JSON.stringify(isInv ? { orderNo, orderDate, despatch, destination } : {});
    const cust = JSON.stringify(customer);
    const tot = isInv ? calcInvoice(clean, inter).total : calcQuote(clean);
    let id;
    if (doc) {
      db.runSync('UPDATE documents SET number=?, date=?, customer_id=?, customer_name=?, customer=?, items=?, extra=?, total=? WHERE id=?',
        [number.trim(), date.trim(), customer.id || null, customer.name, cust, JSON.stringify(clean), extra, tot, doc.id]);
      id = doc.id;
    } else {
      const r = db.runSync('INSERT INTO documents (type, number, date, customer_id, customer_name, customer, items, extra, total) VALUES (?,?,?,?,?,?,?,?,?)',
        [type, number.trim(), date.trim(), customer.id || null, customer.name, cust, JSON.stringify(clean), extra, tot]);
      id = r.lastInsertRowId;
    }
    bumpCounter(type, number.trim(), date.trim());
    onSaved(id);
  };

  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 300 }} keyboardShouldPersistTaps="handled">
      <Text style={s.section}>{isInv ? 'Tax Invoice' : 'Quotation'}</Text>
      <Field label={isInv ? 'Invoice No.' : 'Quotation No.'} value={number} onChangeText={(v) => { setNumber(v); setNumTouched(true); }} />
      <Field label="Date (dd/mm/yyyy)" value={date} onChangeText={setDate} />

      <Text style={s.label}>Customer</Text>
      <TouchableOpacity style={[s.input, { justifyContent: 'center' }]} onPress={() => setPick(true)}>
        <Text style={{ fontSize: 15, color: customer ? '#000' : '#888' }}>{customer ? customer.name : 'Customer chuno ▼'}</Text>
      </TouchableOpacity>
      {customer && isInv && inter && <Text style={s.muted}>Dusre state ka customer: IGST lagega.</Text>}

      {isInv && (
        <View>
          <Field label="Buyer's Order No. (optional)" value={orderNo} onChangeText={setOrderNo} />
          <Field label="Order Date (optional)" value={orderDate} onChangeText={setOrderDate} />
          <Field label="Despatch Through (optional)" value={despatch} onChangeText={setDespatch} />
          <Field label="Destination (optional)" value={destination} onChangeText={setDestination} />
        </View>
      )}

      <Text style={[s.section, { marginTop: 18 }]}>Items</Text>
      {items.map((it, i) => (
        <View key={i} style={s.itemBox}>
          {!isInv && <TextInput style={s.input} placeholder="Date (dd/mm/yyyy)" value={it.date} onChangeText={(v) => upd(i, 'date', v)} />}
          <TextInput style={[s.input, { marginTop: !isInv ? 6 : 0, minHeight: 56 }]} multiline placeholder={isInv ? 'Description of Goods' : 'Description / kaam ki detail'}
            value={it.desc} onChangeText={(v) => upd(i, 'desc', v)} />
          {isInv ? (
            <View>
              <View style={s.row2}>
                <TextInput style={[s.input, { flex: 1 }]} placeholder="HSN/SAC" value={it.hsn} onChangeText={(v) => upd(i, 'hsn', v)} />
                <TextInput style={[s.input, { flex: 1 }]} placeholder="GST %" keyboardType="decimal-pad" value={String(it.gst)} onChangeText={(v) => upd(i, 'gst', v)} />
              </View>
              <View style={s.row2}>
                <TextInput style={[s.input, { flex: 1 }]} placeholder="Qty" keyboardType="decimal-pad" value={String(it.qty)} onChangeText={(v) => upd(i, 'qty', v)} />
                <TextInput style={[s.input, { flex: 1 }]} placeholder="per (no)" value={it.per} onChangeText={(v) => upd(i, 'per', v)} />
                <TextInput style={[s.input, { flex: 2 }]} placeholder="Rate ₹" keyboardType="decimal-pad" value={String(it.rate)} onChangeText={(v) => upd(i, 'rate', v)} />
              </View>
              <Text style={[s.muted, { textAlign: 'right' }]}>Amount: ₹{fmt(num(it.qty) * num(it.rate))}</Text>
            </View>
          ) : (
            <TextInput style={[s.input, { marginTop: 6 }]} placeholder="Amount ₹" keyboardType="decimal-pad" value={String(it.amount)} onChangeText={(v) => upd(i, 'amount', v)} />
          )}
          {items.length > 1 && (
            <TouchableOpacity onPress={() => setItems(items.filter((_, n) => n !== i))}>
              <Text style={[s.link, { color: '#c0392b', marginTop: 6 }]}>✕ Ye item hatao</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
      <TouchableOpacity onPress={() => setItems([...items, { ...blankItem, ...(isInv ? {} : { date: todayDMY() }) }])}>
        <Text style={s.link}>＋ Item add karo</Text>
      </TouchableOpacity>

      <View style={s.totalBox}>
        {isInv && <Text>Amt: ₹{fmt(t.sub)}</Text>}
        {isInv && t.lines.map((l, i) => <Text key={i}>{l.label}: ₹{fmt(l.amt)}</Text>)}
        <Text style={s.grand}>Total: ₹{isInv ? fmt(total) : fmtQ(total)}</Text>
      </View>
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>{doc ? 'Update karo' : 'Save karo'}</Text></TouchableOpacity>

      <CustomerPicker visible={pick} onClose={() => setPick(false)} onPick={(c) => { setCustomer(c); setPick(false); }} />
    </ScrollView>
  );
}

function DocView({ docId, setScreen, onDeleted }) {
  const doc = db.getFirstSync('SELECT * FROM documents WHERE id = ?', [docId]);
  const [busy, setBusy] = useState(false);
  if (!doc) return <Text style={s.empty}>Document nahi mila.</Text>;
  const isInv = doc.type === 'invoice';
  const c = JSON.parse(doc.customer || '{}');
  const items = JSON.parse(doc.items || '[]');
  const S = getSettings();
  const t = isInv ? calcInvoice(items, isInterstate(c, S.gstin)) : null;

  const share = async () => { setBusy(true); await makeAndSharePdf(doc); setBusy(false); };
  const del = () => Alert.alert('Delete?', 'Ye hamesha ke liye hat jayega.', [
    { text: 'Cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { db.runSync('DELETE FROM documents WHERE id = ?', [doc.id]); onDeleted(); } },
  ]);

  return (
    <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 60 }}>
      <Text style={s.bold}>{c.name}</Text>
      <Text style={s.muted}>{isInv ? 'Invoice' : 'Quotation'} {doc.number} • {doc.date}</Text>
      <View style={{ marginTop: 12 }}>
        {items.map((i, n) => (
          <View key={n} style={s.row}>
            <Text style={{ flex: 1 }}>{isInv ? `${i.desc} × ${i.qty}` : `${i.date}  ${i.desc}`}</Text>
            <Text>₹{isInv ? fmt(num(i.qty) * num(i.rate)) : fmtQ(num(i.amount))}</Text>
          </View>
        ))}
      </View>
      <View style={s.totalBox}>
        {isInv && <Text>Amt: ₹{fmt(t.sub)}</Text>}
        {isInv && t.lines.map((l, i) => <Text key={i}>{l.label}: ₹{fmt(l.amt)}</Text>)}
        <Text style={s.grand}>Total: ₹{isInv ? fmt(t.total) : fmtQ(doc.total)}</Text>
      </View>
      <Text style={[s.muted, { marginTop: 10 }]}>PDF ka naam: {pdfName(doc)}</Text>
      <TouchableOpacity style={s.btn} onPress={share} disabled={busy}>
        <Text style={s.btnText}>{busy ? 'PDF ban raha hai...' : 'PDF banao / Share karo'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[s.btn, { backgroundColor: DARK }]} onPress={() => setScreen({ name: 'docForm', type: doc.type, doc })}>
        <Text style={s.btnText}>Edit karo</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[s.btn, s.danger]} onPress={del}><Text style={s.btnText}>Delete</Text></TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f5f6fa' },
  header: { backgroundColor: DARK, paddingHorizontal: 14, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { width: 34, height: 34, borderRadius: 6 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  headerBtn: { color: ORANGE, fontSize: 14, fontWeight: '600', minWidth: 60 },
  tabs: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: ORANGE },
  tabText: { color: '#666', fontWeight: '600' },
  tabTextOn: { color: DARK },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 8, padding: 10, fontSize: 15, minHeight: 44 },
  label: { marginTop: 10, marginBottom: 4, color: '#444', fontWeight: '600' },
  section: { fontSize: 16, fontWeight: '800', color: DARK, marginTop: 8 },
  card: { backgroundColor: '#fff', marginHorizontal: 12, marginTop: 8, padding: 14, borderRadius: 10, flexDirection: 'row', alignItems: 'center' },
  bold: { fontWeight: '700', fontSize: 16 },
  muted: { color: '#777', marginTop: 2 },
  empty: { textAlign: 'center', marginTop: 60, color: '#888', paddingHorizontal: 20 },
  fab: { position: 'absolute', right: 20, bottom: 24, backgroundColor: ORANGE, width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', elevation: 5 },
  fabText: { color: '#fff', fontSize: 30, marginTop: -2 },
  btn: { backgroundColor: ORANGE, padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 16 },
  danger: { backgroundColor: '#c0392b' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  itemBox: { backgroundColor: '#eef2f7', padding: 8, borderRadius: 8, marginTop: 8 },
  row2: { flexDirection: 'row', gap: 6, marginTop: 6 },
  link: { color: ORANGE, fontWeight: '700', marginTop: 8 },
  totalBox: { backgroundColor: '#fff', padding: 12, borderRadius: 8, marginTop: 14, alignItems: 'flex-end' },
  grand: { fontSize: 20, fontWeight: '800', marginTop: 4 },
  row: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff' },
});
