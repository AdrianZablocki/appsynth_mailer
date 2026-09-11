'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserButton } from '@clerk/nextjs';
import { effectiveVars, setClientField, str, type ClientRecord, type Defaults, type Vars } from '@/lib/effective';

type Template = { name: string; placeholders: string[] };
type ClientRow = { id: string; customer: string; firma: string; mtime: number };
type BenchRow = { branch: string; host: string; navn: string; kommune: string; score: number | null; label: string; unreachable: boolean };
type Rendered = { html: string; text: string; leftovers: string[]; vars: Vars };
type Sender = { name: string; address: string };
type SendResult = { from: string; to: string; messageId: string; attachments: string[]; imap: { ok: true; folder: string } | { ok: false; error: string } | null; logged: boolean };
type Notice = { kind: 'ok' | 'warn' | 'err'; text: string } | null;

const META = ['customer', 'subject', 'to']; // 'from' ma selekt w nagłówku, 'attachments' własną sekcję

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export default function MailerApp() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [defaults, setDefaults] = useState<Defaults>({});
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [sender, setSender] = useState<{ senders: Sender[]; testTo: string } | null>(null);

  const [template, setTemplate] = useState('cold-mail');
  const [clientId, setClientId] = useState('');
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fromSel, setFromSel] = useState('');
  /** załączniki z dysku użytkownika — tylko w pamięci przeglądarki, idą razem z wysyłką */
  const [uploads, setUploads] = useState<File[]>([]);

  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);

  const [benchQ, setBenchQ] = useState('');
  const [bench, setBench] = useState<BenchRow[]>([]);
  const [showBench, setShowBench] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [toOverride, setToOverride] = useState('');

  const tpl = templates.find((t) => t.name === template);
  const customer = client?.customer ?? '';
  const senderList = sender?.senders ?? [];
  const vars = useMemo<Vars>(() => (client ? effectiveVars(client, template, defaults) : {}), [client, template, defaults]);
  const fromAddr = ([fromSel, str(vars.from)].find((a) => a && senderList.some((s) => s.address === a)) ?? senderList[0]?.address) ?? '';
  const fromLabel = (() => { const s = senderList.find((x) => x.address === fromAddr); return s ? `${s.name} <${s.address}>` : fromAddr; })();
  /** rekord, jaki idzie na serwer: z aktualnym nadawcą */
  const outgoing = useMemo<ClientRecord | null>(() => (client ? { ...client, from: fromAddr } : null), [client, fromAddr]);

  useEffect(() => {
    api<Template[]>('/api/templates').then(setTemplates).catch((e) => setNotice({ kind: 'err', text: e.message }));
    api<Defaults>('/api/defaults').then(setDefaults).catch(() => {});
    api<ClientRow[]>('/api/clients').then(setClients).catch(() => {});
    api<typeof sender>('/api/send').then(setSender).catch(() => {});
  }, []);

  useEffect(() => {
    const c = customer;
    api<string[]>(c ? `/api/log?customer=${encodeURIComponent(c)}` : '/api/log').then(setLog).catch(() => setLog([]));
    api<string[]>(c ? `/api/attachments?customer=${encodeURIComponent(c)}` : '/api/attachments').then(setFiles).catch(() => setFiles([]));
  }, [customer, rendered]);

  // podgląd z opóźnieniem po każdej zmianie
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!template || !outgoing) { setRendered(null); return; }
      api<Rendered>('/api/render', { method: 'POST', body: JSON.stringify({ template, record: outgoing }) })
        .then(setRendered)
        .catch((e) => setNotice({ kind: 'err', text: e.message }));
    }, 250);
  }, [template, outgoing]);

  useEffect(() => {
    if (!showBench) return;
    const t = setTimeout(() => {
      api<{ rows: BenchRow[] }>(`/api/benchmark?q=${encodeURIComponent(benchQ)}`).then((r) => setBench(r.rows)).catch(() => setBench([]));
    }, 200);
    return () => clearTimeout(t);
  }, [benchQ, showBench]);

  const loadClient = useCallback(async (id: string) => {
    try {
      const r = await api<{ id: string; record: ClientRecord }>(`/api/clients?id=${encodeURIComponent(id)}`);
      setClientId(r.id); setClient(r.record); setDirty(false); setNotice(null); setToOverride('');
      if (typeof r.record.from === 'string' && r.record.from) setFromSel(r.record.from);
    } catch (e) { setNotice({ kind: 'err', text: (e as Error).message }); }
  }, []);

  const setField = (k: string, v: string) => { if (client) { setClient(setClientField(client, template, defaults, k, v)); setDirty(true); } };
  const toggleAttachment = (rel: string) => {
    if (!client) return;
    const cur = vars.attachments ?? [];
    setClient(setClientField(client, template, defaults, 'attachments', cur.includes(rel) ? cur.filter((x) => x !== rel) : [...cur, rel]));
    setDirty(true);
  };

  const save = async () => {
    if (!outgoing || !clientId) return;
    try {
      await api('/api/clients', { method: 'PUT', body: JSON.stringify({ id: clientId, record: outgoing }) });
      setClient(outgoing); setDirty(false);
      setClients(await api<ClientRow[]>('/api/clients'));
      setNotice({ kind: 'ok', text: `Zapisano clients/${clientId}.json` });
    } catch (e) { setNotice({ kind: 'err', text: (e as Error).message }); }
  };

  const generate = async (host: string) => {
    try {
      const r = await api<{ id: string; record: ClientRecord; notes: string[]; existed: boolean }>('/api/generate', { method: 'POST', body: JSON.stringify({ host }) });
      setClientId(r.id); setClient(r.record); setDirty(false); setShowBench(false); setToOverride('');
      setClients(await api<ClientRow[]>('/api/clients'));
      setNotice({ kind: r.existed ? 'ok' : 'warn', text: r.notes.join(' · ') });
    } catch (e) { setNotice({ kind: 'err', text: (e as Error).message }); }
  };

  const addUpload = (file: File | undefined) => {
    if (!file) return;
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) { setNotice({ kind: 'err', text: 'Dozwolone tylko PDF, PNG i JPG' }); return; }
    if (file.size > 15 * 1024 * 1024) { setNotice({ kind: 'err', text: 'Plik większy niż 15 MB' }); return; }
    setUploads((u) => (u.some((x) => x.name === file.name) ? u : [...u, file]));
  };

  const send = async (mode: 'test' | 'really') => {
    if (!outgoing) return;
    setBusy(true); setNotice(null);
    try {
      const payload = { template, record: outgoing, mode, to: toOverride || undefined, confirm: confirmText };
      let r: SendResult;
      if (uploads.length) {
        const fd = new FormData(); fd.append('payload', JSON.stringify(payload)); for (const f of uploads) fd.append('files', f);
        const res = await fetch('/api/send', { method: 'POST', body: fd }); const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? res.statusText); r = j as SendResult;
      } else {
        r = await api<SendResult>('/api/send', { method: 'POST', body: JSON.stringify(payload) });
      }
      const imap = r.imap == null ? '' : r.imap.ok ? ` · kopia w „${r.imap.folder}”` : ` · kopia do Wysłane NIE zapisana (${r.imap.error})`;
      const att = r.attachments.length ? ` · załączniki: ${r.attachments.join(', ')}` : '';
      setNotice({ kind: 'ok', text: `Wysłano z ${r.from} do ${r.to} (${r.messageId})${att}${imap}${r.logged ? ' · zalogowano' : ''}` });
      setConfirmOpen(false); setConfirmText(''); setUploads([]);
      if (mode === 'really') setLog(await api<string[]>(`/api/log?customer=${encodeURIComponent(customer)}`));
    } catch (e) { setNotice({ kind: 'err', text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  // pola formularza: placeholdery szablonu + klucze z rekordu (bez meta), w kolejności szablonu
  const fieldKeys = useMemo(() => {
    const fromTpl = tpl?.placeholders ?? [];
    const extra = Object.keys(vars).filter((k) => !META.includes(k) && k !== 'attachments' && k !== 'from' && !fromTpl.includes(k));
    return [...fromTpl, ...extra];
  }, [tpl, vars]);
  const unusedKeys = useMemo(() => new Set(Object.keys(vars).filter((k) => !META.includes(k) && k !== 'attachments' && k !== 'from' && !(tpl?.placeholders ?? []).includes(k))), [tpl, vars]);
  const scoped = (k: string) => k === 'subject' || (client?.templates?.[template] && k in client.templates[template]) || (defaults[template] && k in defaults[template]);
  const isLong = (k: string) => k.length > 30 || /OBSERV|FUNN|FINDING|TID/.test(k);
  const canSend = !!rendered && rendered.leftovers.length === 0 && !!vars.subject;
  const finalTo = toOverride || str(vars.to);

  return (
    <div className="app">
      <header className="top">
        <span className="brand">AppSynth mailer</span>
        {senderList.length ? (
          <label className="from row" style={{ gap: 6 }}>od:
            <select value={fromAddr} onChange={(e) => { setFromSel(e.target.value); setDirty(true); }} style={{ width: 'auto', padding: '4px 8px' }}>
              {senderList.map((s) => <option key={s.address} value={s.address}>{s.name ? `${s.name} <${s.address}>` : s.address}</option>)}
            </select>
          </label>
        ) : <span className="from">brak konfiguracji SMTP w mailer/.env</span>}
        <span className="spacer" />
        <span className="muted">test → {sender?.testTo || '—'}</span>
        <UserButton />
      </header>

      {/* LEWA: klienci, szablon, benchmark, log */}
      <aside className="col">
        <h2>Klienci</h2>
        <div className="list">
          {clients.map((c) => (
            <button key={c.id} className={`item ${c.id === clientId ? 'active' : ''}`} onClick={() => loadClient(c.id)}>
              <span>{c.customer}{c.firma && <><br /><small>{c.firma}</small></>}</span><small>{new Date(c.mtime).toLocaleDateString('pl-PL')}</small>
            </button>
          ))}
          {clients.length === 0 && <span className="muted">brak rekordów w mailer/clients</span>}
        </div>

        <h2>Nowy klient z benchmarku</h2>
        {!showBench ? (
          <button className="btn" onClick={() => setShowBench(true)}>Wybierz firmę (fala 2, v0.4)</button>
        ) : (
          <>
            <input type="text" placeholder="domena, nazwa lub gmina…" value={benchQ} onChange={(e) => setBenchQ(e.target.value)} autoFocus />
            <div className="bench" style={{ marginTop: 6 }}>
              {bench.map((b) => (
                <button key={b.host} className="item" disabled={b.unreachable} onClick={() => generate(b.host)} title={b.navn}>
                  <span>{b.host}<br /><small>{b.navn} · {b.kommune}</small></span>
                  <small>{b.score ?? '—'}</small>
                </button>
              ))}
              {bench.length === 0 && <div className="muted" style={{ padding: 8 }}>brak wyników</div>}
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>Domyślnie: wszystkie od najsłabszych. Kliknięcie tworzy rekord klienta (istniejącego nie nadpisuje).</div>
            <button className="btn" style={{ marginTop: 6 }} onClick={() => setShowBench(false)}>Zamknij</button>
          </>
        )}

        <h2>Szablon</h2>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>

        <h2>Historia wysyłek {customer && <span className="mono">({customer})</span>}</h2>
        <div className="log">{log.length ? log.slice().reverse().join('\n') : <span className="muted">brak wysyłek do klienta</span>}</div>
      </aside>

      {/* ŚRODEK: formularz */}
      <section className="col">
        <div className="row" style={{ marginBottom: 12 }}>
          <strong className="grow">{clientId ? `clients/${clientId}.json` : 'wybierz klienta albo firmę z benchmarku'}{dirty && ' *'}</strong>
          <button className="btn" disabled={!dirty || !client} onClick={save}>Zapisz</button>
        </div>

        {client && (
          <>
            <h2>Meta</h2>
            {META.map((k) => (
              <label key={k} className={`field ${!str(vars[k]) ? 'empty' : ''}`}>
                <span>{k}{k === 'to' && ' (adres klienta)'}{scoped(k) && <em className="muted"> · dla szablonu {template}</em>}</span>
                <input type="text" value={str(vars[k])} onChange={(e) => setField(k, e.target.value)} readOnly={k === 'customer'} />
              </label>
            ))}

            <h2>Pola szablonu „{template}”</h2>
            {fieldKeys.map((k) => (
              <label key={k} className={`field ${!str(vars[k]) ? 'empty' : ''}`} title={unusedKeys.has(k) ? 'klucz nieużywany w tym szablonie' : undefined}>
                <span>[{k}]{scoped(k) && <em className="muted"> · dla szablonu {template}</em>}{unusedKeys.has(k) && <em className="muted"> · nieużywane w tym szablonie</em>}</span>
                {isLong(k)
                  ? <textarea value={str(vars[k])} onChange={(e) => setField(k, e.target.value)} />
                  : <input type="text" value={str(vars[k])} onChange={(e) => setField(k, e.target.value)} />}
              </label>
            ))}

            <h2>Załączniki <span className="muted">(dla szablonu {template} · {customer ? `customers/${customer}` : 'mailer/uploads'})</span></h2>
            <label className="btn" style={{ display: 'inline-block', marginBottom: 8 }}>
              Dodaj plik z dysku…
              <input type="file" accept=".pdf,.png,.jpg,.jpeg" multiple style={{ display: 'none' }}
                onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) addUpload(f); e.target.value = ''; }} />
            </label>
            {uploads.map((f) => (
              <label key={f.name} className="check">
                <input type="checkbox" checked readOnly onChange={() => setUploads((u) => u.filter((x) => x !== f))} />
                <span className="mono">{f.name} <em className="muted">· z dysku, tylko do tej wysyłki</em></span>
              </label>
            ))}
            {files.length === 0 && uploads.length === 0 && <div className="muted">brak plików — dodaj z dysku{customer && ` albo wrzuć PDF do customers/${customer}/`}</div>}
            {files.map((f) => (
              <label key={f} className="check">
                <input type="checkbox" checked={(vars.attachments ?? []).includes(f)} onChange={() => toggleAttachment(f)} />
                <span className="mono">{customer ? f.replace(`customers/${customer}/`, '') : f}</span>
              </label>
            ))}

            <h2>Notatki</h2>
            <textarea value={str(client.notes)} onChange={(e) => { setClient({ ...client, notes: e.target.value }); setDirty(true); }} />
          </>
        )}
      </section>

      {/* PRAWA: podgląd + wysyłka */}
      <section className="col">
        <div className="tabs">
          <button className={`tab ${tab === 'html' ? 'active' : ''}`} onClick={() => setTab('html')}>HTML</button>
          <button className={`tab ${tab === 'text' ? 'active' : ''}`} onClick={() => setTab('text')}>Tekst</button>
          {rendered && rendered.leftovers.length > 0 && <span className="notice warn" style={{ marginLeft: 'auto' }}>niewypełnione: {rendered.leftovers.join(' ')}</span>}
        </div>
        <div className="preview">
          {!rendered ? <div className="muted" style={{ padding: 20 }}>Podgląd pojawi się po wybraniu klienta.</div>
            : tab === 'html' ? <iframe title="podgląd" sandbox="" srcDoc={rendered.html} />
            : <pre>{rendered.text}</pre>}
        </div>
        <div className="sendbar">
          {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
          <div className="subject">{vars.subject || <span className="muted">brak tematu</span>}</div>
          <div className="row">
            <button className="btn" disabled={!canSend || busy || !sender?.testTo} onClick={() => send('test')}>
              {busy ? 'Wysyłam…' : `Wyślij test → ${sender?.testTo || 'brak TEST_TO'}`}
            </button>
            <input className="grow" type="text" placeholder={vars.to ? `do: ${vars.to}` : 'adres klienta (nadpisuje "to")'} value={toOverride} onChange={(e) => setToOverride(e.target.value)} />
            <button className="btn primary" disabled={!canSend || busy || !finalTo || !customer} onClick={() => { setConfirmText(''); setConfirmOpen(true); }}>
              Wyślij do klienta…
            </button>
          </div>
          {((vars.attachments ?? []).length > 0 || uploads.length > 0) && <div className="muted mono">załączniki: {[...(vars.attachments ?? []).map((a) => a.split('/').pop()), ...uploads.map((f) => f.name)].join(', ')}</div>}
        </div>
      </section>

      {confirmOpen && (
        <div className="dialog" onClick={() => !busy && setConfirmOpen(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <strong>Wysyłka do klienta</strong>
            <div>Mail „{template}” pójdzie od <b>{fromLabel}</b> na <b>{finalTo}</b>. Zostanie zapisany w Wysłane i zalogowany w customers/{customer}/mailer-log.txt.{dirty && <> <b>Rekord ma niezapisane zmiany</b> — wysyłka użyje ich, ale zapisz po wysyłce.</>}</div>
            <div>Żeby potwierdzić, wpisz domenę klienta: <span className="mono">{customer}</span></div>
            <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && confirmText.trim().toLowerCase() === customer.toLowerCase() && send('really')} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" disabled={busy} onClick={() => setConfirmOpen(false)}>Anuluj</button>
              <button className="btn danger" disabled={busy || confirmText.trim().toLowerCase() !== customer.toLowerCase()} onClick={() => send('really')}>
                {busy ? 'Wysyłam…' : 'Wyślij naprawdę'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
