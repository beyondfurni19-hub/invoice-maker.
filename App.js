import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, FlatList,
  Alert, StyleSheet, SafeAreaView, Platform, StatusBar, KeyboardAvoidingView,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

// ---------- Database (phone ki storage, offline) ----------
const db = SQLite.openDatabaseSync('invoices.db');
db.execSync(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT, date TEXT, customer TEXT, phone TEXT,
    items TEXT, tax REAL, discount REAL, total REAL, notes TEXT
  );
`);

const getSettings = () => {
  const rows = db.getAllSync('SELECT key, value FROM settings');
  const s = { name: '', address: '', phone: '', gst: '', prefix: 'INV-' };
  rows.forEach((r) => (s[r.key] = r.value));
  return s;
};
const saveSettings = (s) => {
  Object.keys(s).forEach((k) =>
    db.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, s[k] || ''])
  );
};
const getInvoices = () => db.getAllSync('SELECT * FROM invoices ORDER BY id DESC');

// ---------- Helpers ----------
const num = (v) => parseFloat(v) || 0;
const money = (n) => '₹' + (Math.round(n * 100) / 100).toFixed(2);
const todayStr = () => new Date().toISOString().slice(0, 10);

const calc = (items, tax, discount) => {
  const subtotal = items.reduce((a, i) => a + num(i.qty) * num(i.price), 0);
  const afterDisc = Math.max(subtotal - num(discount), 0);
  const taxAmt = (afterDisc * num(tax)) / 100;
  return { subtotal, taxAmt, total: afterDisc + taxAmt };
};

const esc = (t) =>
  String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const buildHtml = (inv, biz) => {
  const items = JSON.parse(inv.items);
  const c = calc(items, inv.tax, inv.discount);
  const rows = items
    .map(
      (i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}</td><td style="text-align:right">${esc(i.qty)}</td>
      <td style="text-align:right">${money(num(i.price))}</td>
      <td style="text-align:right">${money(num(i.qty) * num(i.price))}</td></tr>`
    )
    .join('');
  return `<html><body style="font-family:Arial;padding:24px;color:#222">
    <h2 style="margin:0">${esc(biz.name) || 'Business Name'}</h2>
    <div>${esc(biz.address)}</div>
    <div>${biz.phone ? 'Phone: ' + esc(biz.phone) : ''} ${biz.gst ? ' | GSTIN: ' + esc(biz.gst) : ''}</div>
    <hr/>
    <h3>INVOICE ${esc(inv.number)}</h3>
    <div>Date: ${esc(inv.date)}</div>
    <div><b>Bill To:</b> ${esc(inv.customer)} ${inv.phone ? '(' + esc(inv.phone) + ')' : ''}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:16px" border="1" cellpadding="6">
      <tr style="background:#eee"><th>#</th><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
      ${rows}
    </table>
    <div style="text-align:right;margin-top:12px">
      <div>Subtotal: ${money(c.subtotal)}</div>
      ${num(inv.discount) ? `<div>Discount: -${money(num(inv.discount))}</div>` : ''}
      ${num(inv.tax) ? `<div>GST (${num(inv.tax)}%): ${money(c.taxAmt)}</div>` : ''}
      <h3>Total: ${money(c.total)}</h3>
    </div>
    ${inv.notes ? `<div><b>Notes:</b> ${esc(inv.notes)}</div>` : ''}
    <p style="margin-top:32px;text-align:center;color:#777">Thank you for your business!</p>
  </body></html>`;
};

const sharePdf = async (inv, biz) => {
  try {
    const { uri } = await Print.printToFileAsync({ html: buildHtml(inv, biz) });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: inv.number });
    } else {
      Alert.alert('Share nahi ho sakta', 'Is device par sharing available nahi hai.');
    }
  } catch (e) {
    Alert.alert('Error', String(e));
  }
};

// ---------- App ----------
export default function App() {
  const [screen, setScreen] = useState('list'); // list | new | view | settings
  const [invoices, setInvoices] = useState([]);
  const [biz, setBiz] = useState(getSettings());
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');

  const refresh = () => {
    setInvoices(getInvoices());
    setBiz(getSettings());
  };
  useEffect(refresh, []);

  const filtered = invoices.filter(
    (i) =>
      i.customer.toLowerCase().includes(search.toLowerCase()) ||
      i.number.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#1f4e79" />
      <View style={s.header}>
        {screen !== 'list' && (
          <TouchableOpacity onPress={() => setScreen('list')}>
            <Text style={s.back}>← Back</Text>
          </TouchableOpacity>
        )}
        <Text style={s.title}>
          {screen === 'list' ? 'Invoices' : screen === 'new' ? 'Naya Invoice' : screen === 'settings' ? 'Business Settings' : selected?.number}
        </Text>
        {screen === 'list' && (
          <TouchableOpacity onPress={() => setScreen('settings')}>
            <Text style={s.back}>⚙ Settings</Text>
          </TouchableOpacity>
        )}
      </View>

      {screen === 'list' && (
        <View style={{ flex: 1 }}>
          <TextInput
            style={[s.input, { margin: 12 }]}
            placeholder="Customer ya invoice number se search karo"
            value={search}
            onChangeText={setSearch}
          />
          <FlatList
            data={filtered}
            keyExtractor={(i) => String(i.id)}
            ListEmptyComponent={<Text style={s.empty}>Abhi koi invoice nahi hai. Neeche + dabao.</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={s.card}
                onPress={() => { setSelected(item); setScreen('view'); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.bold}>{item.customer}</Text>
                  <Text style={s.muted}>{item.number} • {item.date}</Text>
                </View>
                <Text style={s.bold}>{money(item.total)}</Text>
              </TouchableOpacity>
            )}
          />
          <TouchableOpacity style={s.fab} onPress={() => setScreen('new')}>
            <Text style={s.fabText}>＋</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen === 'settings' && (
        <SettingsScreen biz={biz} onSave={(v) => { saveSettings(v); refresh(); setScreen('list'); }} />
      )}

      {screen === 'new' && (
        <NewInvoice
          biz={biz}
          count={invoices.length}
          onSave={() => { refresh(); setScreen('list'); }}
        />
      )}

      {screen === 'view' && selected && (
        <ViewInvoice
          inv={selected}
          biz={biz}
          onDelete={() => {
            Alert.alert('Delete?', 'Ye invoice hamesha ke liye hat jayega.', [
              { text: 'Cancel' },
              {
                text: 'Delete', style: 'destructive',
                onPress: () => {
                  db.runSync('DELETE FROM invoices WHERE id = ?', [selected.id]);
                  refresh(); setScreen('list');
                },
              },
            ]);
          }}
        />
      )}
    </SafeAreaView>
  );
}

function SettingsScreen({ biz, onSave }) {
  const [f, setF] = useState(biz);
  const set = (k) => (v) => setF({ ...f, [k]: v });
  return (
    <ScrollView style={{ padding: 16 }}>
      <Text style={s.label}>Business ka naam</Text>
      <TextInput style={s.input} value={f.name} onChangeText={set('name')} />
      <Text style={s.label}>Address</Text>
      <TextInput style={s.input} value={f.address} onChangeText={set('address')} multiline />
      <Text style={s.label}>Phone</Text>
      <TextInput style={s.input} value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Text style={s.label}>GSTIN (optional)</Text>
      <TextInput style={s.input} value={f.gst} onChangeText={set('gst')} autoCapitalize="characters" />
      <Text style={s.label}>Invoice number prefix</Text>
      <TextInput style={s.input} value={f.prefix} onChangeText={set('prefix')} />
      <TouchableOpacity style={s.btn} onPress={() => onSave(f)}>
        <Text style={s.btnText}>Save</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function NewInvoice({ biz, count, onSave }) {
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState(todayStr());
  const [items, setItems] = useState([{ name: '', qty: '1', price: '' }]);
  const [tax, setTax] = useState('0');
  const [discount, setDiscount] = useState('0');
  const [notes, setNotes] = useState('');

  const c = calc(items, tax, discount);
  const upd = (idx, k, v) => setItems(items.map((it, i) => (i === idx ? { ...it, [k]: v } : it)));

  const save = () => {
    if (!customer.trim()) return Alert.alert('Customer ka naam daalo');
    const valid = items.filter((i) => i.name.trim() && num(i.qty) > 0);
    if (!valid.length) return Alert.alert('Kam se kam ek item daalo');
    const last = db.getFirstSync('SELECT MAX(id) AS m FROM invoices');
    const number = (biz.prefix || 'INV-') + String((last?.m || 0) + 1).padStart(4, '0');
    db.runSync(
      'INSERT INTO invoices (number, date, customer, phone, items, tax, discount, total, notes) VALUES (?,?,?,?,?,?,?,?,?)',
      [number, date, customer.trim(), phone.trim(), JSON.stringify(valid), num(tax), num(discount), c.total, notes]
    );
    onSave();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <Text style={s.label}>Customer</Text>
        <TextInput style={s.input} value={customer} onChangeText={setCustomer} />
        <Text style={s.label}>Phone (optional)</Text>
        <TextInput style={s.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Text style={s.label}>Date (YYYY-MM-DD)</Text>
        <TextInput style={s.input} value={date} onChangeText={setDate} />

        <Text style={[s.label, { marginTop: 16 }]}>Items</Text>
        {items.map((it, idx) => (
          <View key={idx} style={s.itemBox}>
            <TextInput style={s.input} placeholder="Item ka naam" value={it.name} onChangeText={(v) => upd(idx, 'name', v)} />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <TextInput style={[s.input, { flex: 1 }]} placeholder="Qty" keyboardType="numeric" value={it.qty} onChangeText={(v) => upd(idx, 'qty', v)} />
              <TextInput style={[s.input, { flex: 2 }]} placeholder="Rate ₹" keyboardType="numeric" value={it.price} onChangeText={(v) => upd(idx, 'price', v)} />
              {items.length > 1 && (
                <TouchableOpacity onPress={() => setItems(items.filter((_, i) => i !== idx))} style={s.xBtn}>
                  <Text style={{ color: '#fff' }}>✕</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}
        <TouchableOpacity onPress={() => setItems([...items, { name: '', qty: '1', price: '' }])}>
          <Text style={s.link}>＋ Item add karo</Text>
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Discount ₹</Text>
            <TextInput style={s.input} keyboardType="numeric" value={discount} onChangeText={setDiscount} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>GST %</Text>
            <TextInput style={s.input} keyboardType="numeric" value={tax} onChangeText={setTax} />
          </View>
        </View>
        <Text style={s.label}>Notes (optional)</Text>
        <TextInput style={s.input} value={notes} onChangeText={setNotes} multiline />

        <View style={s.totalBox}>
          <Text>Subtotal: {money(c.subtotal)}</Text>
          <Text>GST: {money(c.taxAmt)}</Text>
          <Text style={s.grand}>Total: {money(c.total)}</Text>
        </View>
        <TouchableOpacity style={s.btn} onPress={save}>
          <Text style={s.btnText}>Invoice Save karo</Text>
        </TouchableOpacity>
        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ViewInvoice({ inv, biz, onDelete }) {
  const items = JSON.parse(inv.items);
  const c = calc(items, inv.tax, inv.discount);
  return (
    <ScrollView style={{ padding: 16 }}>
      <Text style={s.bold}>{inv.customer}</Text>
      <Text style={s.muted}>{inv.phone} • {inv.date}</Text>
      <View style={{ marginTop: 12 }}>
        {items.map((i, n) => (
          <View key={n} style={s.row}>
            <Text style={{ flex: 1 }}>{i.name} × {i.qty}</Text>
            <Text>{money(num(i.qty) * num(i.price))}</Text>
          </View>
        ))}
      </View>
      <View style={s.totalBox}>
        <Text>Subtotal: {money(c.subtotal)}</Text>
        {num(inv.discount) > 0 && <Text>Discount: -{money(num(inv.discount))}</Text>}
        {num(inv.tax) > 0 && <Text>GST ({inv.tax}%): {money(c.taxAmt)}</Text>}
        <Text style={s.grand}>Total: {money(c.total)}</Text>
      </View>
      {!!inv.notes && <Text style={s.muted}>Notes: {inv.notes}</Text>}
      <TouchableOpacity style={s.btn} onPress={() => sharePdf(inv, biz)}>
        <Text style={s.btnText}>PDF banao / Share karo</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[s.btn, { backgroundColor: '#c0392b' }]} onPress={onDelete}>
        <Text style={s.btnText}>Delete</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f6fa', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  header: { backgroundColor: '#1f4e79', padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  back: { color: '#cfe3f5', fontSize: 14 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d5dd', borderRadius: 8, padding: 10, fontSize: 15 },
  label: { marginTop: 10, marginBottom: 4, color: '#444', fontWeight: '600' },
  card: { backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: 10, flexDirection: 'row', alignItems: 'center' },
  bold: { fontWeight: '700', fontSize: 16 },
  muted: { color: '#777', marginTop: 2 },
  empty: { textAlign: 'center', marginTop: 60, color: '#888' },
  fab: { position: 'absolute', right: 20, bottom: 24, backgroundColor: '#1f4e79', width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', elevation: 5 },
  fabText: { color: '#fff', fontSize: 30, marginTop: -2 },
  btn: { backgroundColor: '#1f4e79', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 16 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  itemBox: { backgroundColor: '#eef2f7', padding: 8, borderRadius: 8, marginBottom: 8 },
  xBtn: { backgroundColor: '#c0392b', borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center' },
  link: { color: '#1f4e79', fontWeight: '700', marginTop: 4 },
  totalBox: { backgroundColor: '#fff', padding: 12, borderRadius: 8, marginTop: 14, alignItems: 'flex-end' },
  grand: { fontSize: 20, fontWeight: '800', marginTop: 4 },
  row: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
});
