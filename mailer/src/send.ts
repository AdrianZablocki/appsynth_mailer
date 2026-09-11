import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { htmlToText } from 'html-to-text';
import { ImapFlow } from 'imapflow';

/*
 Użycie:
   npm run preview -- --template cold-mail --client entas.no       # render → out/…html, otwiera w przeglądarce
   npm run send -- --template cold-mail --client entas.no --test   # wysyła TYLKO na TEST_TO
   npm run send -- --template cold-mail --client entas.no --to ror@entas.no --really
   npm run send -- ... --from kontakt@appsynth.pl                  # alias z FROM_ADDRESSES (domyślnie pierwszy)
 Dane: clients/<domena>.json — jeden rekord na klienta (klucze = teksty w [NAWIASACH] w szablonach),
 sekcja "templates": { "<szablon>": { nadpisania, np. subject, attachments } }. Wartości domyślne per szablon: defaults.json.
 Skuteczne vars = defaults[szablon] < rekord < rekord.templates[szablon]. Ta sama logika co mailer-ui/src/lib/effective.ts.
 (Stare pliki vars/ → vars-legacy/, flaga --vars nadal działa dla nich.)
*/

type Vars = Record<string, string> & { attachments?: string[]; from?: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const templateName = arg('template') ?? 'cold-mail';
const clientId = arg('client');
const varsName = arg('vars');
if (!clientId && !varsName) throw new Error('Podaj --client <domena> (plik clients/<domena>.json)');

const root = resolve(import.meta.dirname, '..');
// customers/ i załączniki: AUDIT_ROOT z .env (lokalnie = folder audit), domyślnie folder nad mailer/
const auditRoot = resolve(process.env.AUDIT_ROOT ?? resolve(root, '..'));
const template = readFileSync(resolve(root, 'templates', `${templateName}.html`), 'utf8')
  .replace(/^<!--[\s\S]*?-->\s*/, '');

type Scalar = string | string[] | undefined;
function effectiveVars(record: Record<string, unknown>, t: string): Vars {
  const defaultsPath = resolve(root, 'defaults.json');
  const defaults = existsSync(defaultsPath) ? (JSON.parse(readFileSync(defaultsPath, 'utf8')) as Record<string, Record<string, Scalar>>) : {};
  const d = defaults[t] ?? {};
  const base: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(record)) if (!['templates', 'notes', '_comment'].includes(k)) base[k] = v as Scalar;
  const o = ((record.templates as Record<string, Record<string, Scalar>> | undefined)?.[t]) ?? {};
  const v = { ...d, ...base, ...o } as Vars;
  v.attachments = (o.attachments ?? base.attachments ?? d.attachments ?? []) as string[];
  return v;
}
const vars: Vars = clientId
  ? effectiveVars(JSON.parse(readFileSync(resolve(root, 'clients', `${clientId}.json`), 'utf8')), templateName)
  : JSON.parse(readFileSync(resolve(root, 'vars-legacy', `${varsName}.json`), 'utf8'));
const outName = clientId ?? varsName!;

// dłuższe klucze najpierw, żeby "[KONKURRENT 1]" nie został zjedzony przez krótszy
const META = new Set(['subject', 'to', 'from', 'customer', 'attachments']);
const keys = Object.keys(vars).filter((k) => !META.has(k)).sort((a, b) => b.length - a.length);
let html = template;
for (const k of keys) html = html.split(`[${k}]`).join(vars[k]);

const leftovers = [...new Set(html.match(/\[[A-ZÆØÅ][^\]]{1,80}\]/g) ?? [])];
if (leftovers.length) {
  console.error('Niewypełnione pola:', leftovers.join(', '));
  process.exit(1);
}

let subject = vars.subject;
if (!subject) throw new Error('Brak "subject" (rekord/templates/defaults)');
for (const k of keys) subject = subject.split(`[${k}]`).join(vars[k]);
const text = htmlToText(html, { wordwrap: 78, selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }] });

mkdirSync(resolve(root, 'out'), { recursive: true });
const outFile = resolve(root, 'out', `${outName}-${templateName}.html`);
writeFileSync(outFile, html);

if (flag('preview')) {
  console.log(`Temat: ${subject}\nZałączniki: ${(vars.attachments ?? []).join(', ') || 'brak'}\nPodgląd: ${outFile}`);
  execSync(`open "${outFile}"`);
  process.exit(0);
}

const test = flag('test');
const to = test ? process.env.TEST_TO : (arg('to') ?? vars.to);
if (!to) throw new Error('Brak adresata: --to, "to" w vars, albo --test');
if (!test && !flag('really')) {
  console.error(`Wysyłka do ${to} wymaga flagi --really (albo użyj --test).`);
  process.exit(1);
}

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, FROM_NAME } = process.env;
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new Error('Uzupełnij SMTP_* w .env');

// nadawca: alias tej samej skrzynki z FROM_ADDRESSES ("Nazwa <adres>, …"); --from lub "from" w vars; domyślnie pierwszy
const senders = (process.env.FROM_ADDRESSES ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = x.match(/^(.*?)\s*<([^>]+)>$/);
  return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: '', address: x.toLowerCase() };
});
if (!senders.length) senders.push({ name: FROM_NAME ?? SMTP_USER, address: SMTP_USER });
const wantedFrom = (arg('from') ?? vars.from)?.trim().toLowerCase();
const sender = wantedFrom ? senders.find((s) => s.address === wantedFrom) : senders[0];
if (!sender) throw new Error(`Nadawca ${wantedFrom} nie jest na liście FROM_ADDRESSES w .env`);

const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT ?? 465),
  secure: Number(SMTP_PORT ?? 465) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
});

const attachments = (vars.attachments ?? []).map((rel) => {
  const path = resolve(auditRoot, rel);
  if (!existsSync(path)) throw new Error(`Brak załącznika: ${path}`);
  return { path };
});
const message = {
  from: { name: sender.name || sender.address, address: sender.address },
  to,
  subject: test ? `[TEST] ${subject}` : subject,
  text,
  html,
  attachments,
};
const info = await transport.sendMail(message);
console.log(`Wysłano od ${sender.address} do ${to} (messageId ${info.messageId})${attachments.length ? `, załączniki: ${attachments.map((a) => a.path.split('/').pop()).join(', ')}` : ''}`);

// kopia do "Wysłane" w webmailu (z limitem czasu — nie blokuje wysyłki)
if (process.env.IMAP_HOST) {
  const withTimeout = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
  try {
    const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(message);
    const client = new ImapFlow({
      host: process.env.IMAP_HOST,
      port: Number(process.env.IMAP_PORT ?? 993),
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      logger: false,
    });
    await withTimeout(client.connect(), 15000);
    const boxes = await withTimeout(client.list(), 15000);
    const sent =
      boxes.find((b) => b.specialUse === '\\Sent')?.path ??
      boxes.find((b) => /^(sent|wys[łl]ane|sent items)$/i.test(b.name))?.path ??
      process.env.IMAP_SENT_FOLDER ?? 'Sent';
    await withTimeout(client.append(sent, raw.message as Buffer, ['\\Seen']), 30000);
    await withTimeout(client.logout(), 5000).catch(() => client.close());
    console.log(`Kopia zapisana w folderze "${sent}".`);
  } catch (e) {
    console.error('Nie udało się zapisać kopii do Wysłane:', (e as Error).message);
  }
}

// log wysyłki (bez testów) do folderu klienta, jeśli istnieje
if (!test) {
  const customer = vars.customer ?? outName.split('-')[0];
  const customerDir = resolve(auditRoot, 'customers', customer);
  const line = `${new Date().toISOString()} | ${templateName} | from=${sender.address} | to=${to} | subject=${subject}\n`;
  if (existsSync(customerDir)) appendFileSync(resolve(customerDir, 'mailer-log.txt'), line);
  else appendFileSync(resolve(root, 'out', 'mailer-log.txt'), line);
}
