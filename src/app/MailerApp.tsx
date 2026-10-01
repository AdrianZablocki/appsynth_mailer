'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserButton } from '@clerk/nextjs';
import { effectiveVars, setClientField, str, suggestedTemplate, type ClientRecord, type Defaults, type Vars } from '@/lib/effective';

type Template = { name: string; placeholders: string[] };
type ClientRow = { id: string; customer: string; firma: string; mtime: number };
type BenchRow = { branch: string; host: string; navn: string; kommune: string; score: number | null; label: string; unreachable: boolean };
type Rendered = { html: string; text: string; leftovers: string[]; vars: Vars; blocked: string | null };
type Sender = { name: string; address: string };
type SendResult = { from: string; to: string; messageId: string; attachments: string[]; imap: { ok: true; folder: string } | { ok: false; error: string } | null; logged: boolean };
type Notice = { kind: 'ok' | 'warn' | 'err'; text: string } | null;

const META = ['customer', 'subject', 'to']; // 'from' ma selekt w nagłówku, 'attachments' własną sekcję

// Polskie opisy pól nad inputami. Klucz = placeholder z szablonu (bez nawiasów) albo pole meta.
const PL_LABELS: Record<string, string> = {
  customer: 'Klient (domena, identyfikator rekordu)',
  subject: 'Temat wiadomości',
  to: 'Adres e-mail odbiorcy',
  'FIRST NAME': 'Imię odbiorcy',
  COMPANY: 'Nazwa firmy',
  'company.no': 'Domena firmy',
  SERVICE: 'Usługa, o którą pytaliśmy AI (po angielsku, np. plumbing work)',
  CITY: 'Miasto',
  TRADE: 'Branża w liczbie mnogiej (po angielsku, np. plumbers)',
  COUNT: 'Liczba firm z wynikiem w fali benchmarku dla branży (np. 325)',
  '57': 'Wynik firmy w benchmarku (punkty na 100)',
  '70': 'Mediana branży w benchmarku (punkty na 100)',
  'AI OBSERVATION': 'Obserwacja z odpowiedzi AI (jedno zdanie)',
  'FIRST ADDRESS': 'Adres, na który poszedł pierwszy mail',
  PROPOSED_TIME: 'Proponowany termin rozmowy (po angielsku)',
  VALID_UNTIL: 'Oferta ważna do (data po angielsku)',
  PRICE_AUDIT: 'Cena audytu (NOK, bez VAT)',
  PRICE_PACKAGE: 'Cena pakietu wdrożeniowego (NOK, bez VAT)',
  PRICE_MONTHLY: 'Cena abonamentu miesięcznego (NOK, bez VAT)',
  REPORT_FILE: 'Nazwa pliku raportu PDF (jak w załączniku)',
  OFFER_FILE: 'Nazwa pliku oferty PDF (jak w załączniku)',
  TABLE_TITLE: 'Tytuł tabeli z cenami',
  HEADLINE: 'Nagłówek H1 maila (po angielsku, może zawierać [PLACEHOLDERY]; w cold-mail kończy go stałe «Yet.», w cold-mail-listed «For now.», w follow-up «Free.»)',
  LISTED: 'Czy firma jest na listach AI wg testu G2: yes / no (musi pasować do szablonu, inaczej wysyłka jest zablokowana)',
  'LIST RESULT': 'Wynik na listach AI, po «[COMPANY]», z kropką (np. «was not on any of the lists.») — szablon cold-mail, bez wartości domyślnej',
  'AI SOURCE': 'Skąd AI bierze wiedzę / dlaczego nie poleca, po «but» (np. «it relies on third-party sources, not on your website») — szablon cold-mail, bez wartości domyślnej',
  PLACE: 'Pozycja firmy na liście AI (np. «last, 5th of 5») — szablon cold-mail-listed, bez wartości domyślnej',
  'AI RESULT': 'Zdanie o wyniku na listach AI, z kropką (np. «none of them mentioned Entas.» albo «ChatGPT named Askel fifth of five, Gemini fourth of four.») — follow-up i offer',
  'AI REMARK': 'Zastrzeżenie AI przy firmie, cytat po angielsku (np. «very good ratings, but few reviews so far»)',
};
function plLabel(k: string): string | undefined {
  if (PL_LABELS[k]) return PL_LABELS[k];
  let m: RegExpMatchArray | null;
  if ((m = k.match(/^COMPETITOR (\d+)$/))) return `Konkurent nr ${m[1]} wskazany przez AI`;
  if ((m = k.match(/^FINDING (\d+)$/))) return `Ustalenie nr ${m[1]}: brak na stronie (po angielsku, krótko)`;
  return undefined;
}

/** Etykieta nad polem i podpowiedź pod nim: PL_LABELS trzyma „Etykieta (podpowiedź)” albo „Etykieta — podpowiedź”. */
function labelParts(k: string): { label: string; hint?: string } {
  const full = plLabel(k);
  if (!full) return { label: k };
  const m = full.match(/^([^(—]*?)\s+(?:\(([\s\S]*)\)|—\s+([\s\S]*))$/);
  if (!m) return { label: full };
  return { label: m[1], hint: (m[2] ?? m[3])?.trim() };
}

/** Linia logu „ISO | szablon | from=… | to=… | messageId=… | subject=…” → wpis historii. */
function parseLog(line: string): { when: string; template: string; note: string; to: string; subject: string } {
  const p = line.split(' | ');
  const kv = (prefix: string) => p.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? '';
  const d = new Date(p[0]);
  const when = isNaN(d.getTime()) ? p[0] : `${d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })} · ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
  // „correction (reply, manual script)” → plakietka „correction”, dopisek przy adresacie
  const t = (p[1] ?? '').match(/^([^(]*?)\s*(?:\((.*)\))?$/);
  return { when, template: t?.[1] || p[1] || '', note: t?.[2] ?? '', to: kv('to='), subject: kv('subject=') || p.slice(2).join(' | ') };
}

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
  const [resend, setResend] = useState(false);
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
      setTemplate((cur) => suggestedTemplate(r.record, cur) ?? cur);
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
      setTemplate((cur) => suggestedTemplate(r.record, cur) ?? cur);
      setClients(await api<ClientRow[]>('/api/clients'));
      setNotice({ kind: r.existed ? 'ok' : 'warn', text: r.notes.join(' · ') });
    } catch (e) { setNotice({ kind: 'err', text: (e as Error).message }); }
  };

  /** Nowy klient „z palca”: rekord z domeną i pustymi polami wszystkich szablonów. */
  const createManual = async () => {
    const raw = prompt('Domena klienta (np. firma.no) — będzie identyfikatorem rekordu:');
    if (!raw) return;
    const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) { setNotice({ kind: 'err', text: `To nie wygląda na domenę: ${raw}` }); return; }
    const record: ClientRecord = { customer: host, to: '', 'company.no': host, LISTED: '', templates: {}, notes: '' };
    for (const t of templates) for (const k of t.placeholders) if (!(k in record) && !defaults[t.name]?.[k]) record[k] = '';
    try {
      await api('/api/clients', { method: 'PUT', body: JSON.stringify({ id: host, record, create: true }) });
      setClients(await api<ClientRow[]>('/api/clients'));
      setClientId(host); setClient(record); setDirty(false); setToOverride('');
      setNotice({ kind: 'ok', text: `Utworzono klienta ${host} — wypełnij pola i zapisz` });
    } catch (e) { setNotice({ kind: 'err', text: (e as Error).message }); }
  };

  const removeClient = async () => {
    if (!clientId) return;
    const typed = prompt(`Usunąć klienta ${clientId} z bazy? Historia wysyłek zostaje. Wpisz domenę, żeby potwierdzić:`);
    if (!typed || typed.trim().toLowerCase() !== clientId.toLowerCase()) return;
    try {
      await api(`/api/clients?id=${encodeURIComponent(clientId)}`, { method: 'DELETE' });
      setClients(await api<ClientRow[]>('/api/clients'));
      setClientId(''); setClient(null); setDirty(false); setRendered(null);
      setNotice({ kind: 'ok', text: `Usunięto klienta ${clientId}` });
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
      const payload = { template, record: outgoing, mode, to: toOverride || undefined, confirm: confirmText, resend: mode === 'really' && resend };
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
      // po teście załączniki zostają — prawdziwa wysyłka zwykle idzie zaraz po nim, z tym samym PDF-em
      setConfirmOpen(false); setConfirmText(''); setResend(false);
      if (mode === 'really') setUploads([]);
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
  const canSend = !!rendered && rendered.leftovers.length === 0 && !rendered.blocked && !!vars.subject;
  const finalTo = toOverride || str(vars.to);
  const attachmentNames = [...(vars.attachments ?? []).map((a) => a.split('/').pop() ?? a), ...uploads.map((f) => f.name)];
  /** daty wcześniejszych wysyłek tego szablonu do klienta (z logu: „data | szablon | …”) */
  const alreadySent = log.map((l) => l.split(' | ')).filter((p) => p[1] === template).map((p) => p[0].slice(0, 16).replace('T', ' '));
  const sendBlocked = alreadySent.length > 0 && !resend;

  const field = (k: string, kind: 'meta' | 'tpl') => {
    const { label, hint } = labelParts(k);
    const id = `f-${k.replace(/[^a-z0-9]+/gi, '-')}`;
    const unused = kind === 'tpl' && unusedKeys.has(k);
    return (
      <div key={k} className={`field ${!str(vars[k]) ? 'empty' : ''} ${unused ? 'unused' : ''}`}>
        <div className="field-head">
          <label htmlFor={id}>{label}</label>
          <span className="key">{kind === 'tpl' ? `[${k}]` : k}{scoped(k) && ` · ${template}`}</span>
        </div>
        {kind === 'tpl' && isLong(k)
          ? <textarea id={id} className="input" value={str(vars[k])} onChange={(e) => setField(k, e.target.value)} />
          : <input id={id} className="input" type="text" value={str(vars[k])} onChange={(e) => setField(k, e.target.value)} readOnly={k === 'customer'} />}
        {(hint || unused) && <span className="hint">{unused ? 'Klucz z rekordu, nieużywany w tym szablonie.' : hint}</span>}
      </div>
    );
  };
  const history = log.slice().reverse().map(parseLog);
  const companyName = str(client?.COMPANY) || clientId;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element -- statyczny 60 px PNG, bez optymalizacji */}
          <img src="/logo-nav.png" alt="" width={26} height={26} />
          <b>AppSynth</b>
          <span className="eyebrow">Mailer</span>
        </div>
        {senderList.length ? (
          <label className="from">
            <span className="eyebrow">Od</span>
            <select className="input" value={fromAddr} onChange={(e) => { setFromSel(e.target.value); setDirty(true); }}>
              {senderList.map((s) => <option key={s.address} value={s.address}>{s.name ? `${s.name} <${s.address}>` : s.address}</option>)}
            </select>
          </label>
        ) : <span className="badge coral">brak konfiguracji SMTP w mailer/.env</span>}
        <span className="spacer" />
        <span className="test">test → {sender?.testTo || '—'}</span>
        <UserButton />
      </header>

      <div className="grid">
        {/* LEWA: klienci, benchmark, szablon, historia */}
        <aside className="col side">
          <section>
            <div className="sec-head"><span className="eyebrow">Klienci</span><span className="mono muted">{clients.length}</span></div>
            <div className="list">
              {clients.map((c) => (
                <button key={c.id} className={`item ${c.id === clientId ? 'active' : ''}`} onClick={() => loadClient(c.id)}>
                  <span className="main"><b>{c.customer}</b>{c.firma && <small>{c.firma}</small>}</span>
                  <span className="aside">{new Date(c.mtime).toLocaleDateString('pl-PL')}</span>
                </button>
              ))}
              {clients.length === 0 && <span className="muted" style={{ padding: '0 12px', fontSize: 13 }}>brak klientów</span>}
            </div>
            <div style={{ paddingTop: 6 }}><button className="btn ghost sm" onClick={createManual}>+ Nowy klient ręcznie</button></div>
          </section>

          <section>
            <span className="eyebrow" style={{ padding: '0 4px' }}>Z benchmarku</span>
            {!showBench ? (
              <div><button className="btn ghost sm" onClick={() => setShowBench(true)}>Wybierz firmę · fala 2, v0.4</button></div>
            ) : (
              <>
                <input className="input" type="text" placeholder="domena, nazwa lub gmina…" value={benchQ} onChange={(e) => setBenchQ(e.target.value)} autoFocus />
                <div className="bench">
                  {bench.map((b) => (
                    <button key={b.host} className="item" disabled={b.unreachable} onClick={() => generate(b.host)} title={b.navn}>
                      <span className="main"><b>{b.host}</b><small>{b.navn} · {b.kommune}</small></span>
                      <span className="aside">{b.score ?? '—'}</span>
                    </button>
                  ))}
                  {bench.length === 0 && <div className="muted" style={{ padding: 12, fontSize: 13 }}>brak wyników</div>}
                </div>
                <span className="hint muted" style={{ fontSize: 13, lineHeight: '18px' }}>Domyślnie: wszystkie od najsłabszych. Kliknięcie tworzy rekord klienta (istniejącego nie nadpisuje).</span>
                <div><button className="btn ghost sm" onClick={() => setShowBench(false)}>Zamknij</button></div>
              </>
            )}
          </section>

          <section>
            <label className="eyebrow" htmlFor="tpl" style={{ padding: '0 4px' }}>Szablon</label>
            <select id="tpl" className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </section>

          <section>
            <span className="eyebrow" style={{ padding: '0 4px' }}>Historia wysyłek{customer && ` · ${customer}`}</span>
            <div className="history">
              {history.length === 0 && <div className="empty">{customer ? 'brak wysyłek do klienta' : 'wybierz klienta'}</div>}
              {history.map((h, i) => (
                <div key={i} className="entry">
                  <div className="head">
                    <span className={`badge ${h.template === template ? 'signal' : ''}`}>{h.template || '?'}</span>
                    <span className="mono">{h.when}</span>
                  </div>
                  {h.subject && <span className="subject">{h.subject}</span>}
                  {(h.to || h.note) && <span className="to">→ {[h.to, h.note].filter(Boolean).join(' · ')}</span>}
                </div>
              ))}
            </div>
          </section>
        </aside>

        {/* ŚRODEK: formularz */}
        <main className="col editor">
          <div className="editor-head">
            <div className="who">
              <b>{clientId ? companyName : 'Wybierz klienta'}</b>
              <span className="mono muted">{clientId ? `clients/${clientId}.json` : 'albo firmę z benchmarku'}</span>
            </div>
            {client && <span className={`badge ${dirty ? 'amber' : 'signal'}`}>{dirty ? 'niezapisane' : 'zapisano'}</span>}
            <button className="btn secondary sm" disabled={!dirty || !client} onClick={save}>Zapisz</button>
            {clientId && <button className="btn ghost sm" title="Usuń rekord klienta (historia wysyłek zostaje)" onClick={removeClient}>Usuń</button>}
          </div>

          {client && (
            <div className="editor-body">
              <section>
                <span className="eyebrow">01 — Meta</span>
                {META.map((k) => field(k, 'meta'))}
              </section>

              <section>
                <div className="sec-head"><span className="eyebrow">02 — Pola szablonu</span><span className="mono">{template}</span></div>
                {fieldKeys.map((k) => field(k, 'tpl'))}
              </section>

              <section>
                <div className="sec-head"><span className="eyebrow">03 — Załączniki</span><span className="mono muted">{customer ? `customers/${customer}` : 'mailer/uploads'}</span></div>
                <div>
                  <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
                    Dodaj plik z dysku…
                    <input type="file" accept=".pdf,.png,.jpg,.jpeg" multiple style={{ display: 'none' }}
                      onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) addUpload(f); e.target.value = ''; }} />
                  </label>
                </div>
                {uploads.map((f) => (
                  <label key={f.name} className="check">
                    <input type="checkbox" checked readOnly onChange={() => setUploads((u) => u.filter((x) => x !== f))} />
                    <span className="mono">{f.name} <em className="muted">· z dysku, tylko do tej wysyłki</em></span>
                  </label>
                ))}
                {files.length === 0 && uploads.length === 0 && <span className="hint">Brak plików — dodaj z dysku{customer && ` albo wrzuć PDF do customers/${customer}/`}.</span>}
                {files.map((f) => (
                  <label key={f} className="check">
                    <input type="checkbox" checked={(vars.attachments ?? []).includes(f)} onChange={() => toggleAttachment(f)} />
                    <span className="mono">{customer ? f.replace(`customers/${customer}/`, '') : f}</span>
                  </label>
                ))}
              </section>

              <section>
                <span className="eyebrow">04 — Notatki</span>
                <textarea className="input" value={str(client.notes)} onChange={(e) => { setClient({ ...client, notes: e.target.value }); setDirty(true); }} />
              </section>
            </div>
          )}
        </main>

        {/* PRAWA: podgląd + wysyłka */}
        <section className="col preview-col">
          <div className="preview-head">
            <div className="tabs" role="tablist">
              <button className={`tab ${tab === 'html' ? 'active' : ''}`} role="tab" onClick={() => setTab('html')}>HTML</button>
              <button className={`tab ${tab === 'text' ? 'active' : ''}`} role="tab" onClick={() => setTab('text')}>Tekst</button>
            </div>
            {rendered && rendered.leftovers.length > 0
              ? <span className="badge amber" title={rendered.leftovers.join(' ')}>niewypełnione: {rendered.leftovers.length}</span>
              : <span className="mono muted">podgląd · 600 px</span>}
          </div>
          <div className="preview">
            {!rendered ? <div className="placeholder">Podgląd pojawi się po wybraniu klienta.</div>
              : tab === 'html' ? <iframe title="podgląd" sandbox="" srcDoc={rendered.html} />
              : <div className="text"><pre>{rendered.text}</pre></div>}
          </div>
          <div className="sendbar">
            {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
            {rendered?.blocked && <div className="notice err">Wysyłka zablokowana: {rendered.blocked}</div>}
            {rendered && rendered.leftovers.length > 0 && <div className="notice warn">Niewypełnione: {rendered.leftovers.join(' ')}</div>}
            <div className="subject"><span className="eyebrow">Temat</span><span>{vars.subject || <span className="muted">brak tematu</span>}</span></div>
            <div className="row">
              <button className="btn ghost" disabled={!canSend || busy || !sender?.testTo} onClick={() => send('test')} title={sender?.testTo ? `na ${sender.testTo}` : 'brak TEST_TO w mailer/.env'}>
                {busy ? 'Wysyłam…' : 'Wyślij test'}
              </button>
              <div className="to-field grow">
                <span className="prefix">do:</span>
                <input className="input" type="text" placeholder={str(vars.to) || 'adres klienta'} value={toOverride} onChange={(e) => setToOverride(e.target.value)} />
              </div>
              <button className="btn primary" disabled={!canSend || busy || !finalTo || !customer} onClick={() => { setConfirmText(''); setResend(false); setConfirmOpen(true); }}>
                Wyślij do klienta <span className="arrow" aria-hidden>→</span>
              </button>
            </div>
            {attachmentNames.length > 0 && <div className="mono muted">załączniki: {attachmentNames.join(', ')}</div>}
          </div>
        </section>
      </div>

      {confirmOpen && (
        <div className="dialog" onClick={() => !busy && setConfirmOpen(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <h3>Wysyłka do klienta</h3>
            <div>Mail <span className="badge">{template}</span> pójdzie od <b>{fromLabel}</b> na <b>{finalTo}</b>. Zostanie zapisany w Wysłane i zalogowany w customers/{customer}/mailer-log.txt.{dirty && <> <b>Rekord ma niezapisane zmiany</b> — wysyłka użyje ich, ale zapisz po wysyłce.</>}</div>
            <div>Załączniki: {attachmentNames.length ? <b>{attachmentNames.join(', ')}</b> : <b>brak</b>}</div>
            {alreadySent.length > 0 && (
              <div className="notice warn">
                „{template}” już poszedł do {customer}: {alreadySent.join(', ')}.
                <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} /> wyślij ponownie (celowo)</label>
              </div>
            )}
            <div>Żeby potwierdzić, wpisz domenę klienta: <span className="mono">{customer}</span></div>
            <input className="input" type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && !busy && !sendBlocked && confirmText.trim().toLowerCase() === customer.toLowerCase() && send('really')} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" disabled={busy} onClick={() => setConfirmOpen(false)}>Anuluj</button>
              <button className="btn danger" disabled={busy || sendBlocked || confirmText.trim().toLowerCase() !== customer.toLowerCase()} onClick={() => send('really')}>
                {busy ? 'Wysyłam…' : 'Wyślij naprawdę'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
