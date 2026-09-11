/*
 Jedyny moduł, który dotyka dysku. Przy przenosinach na Vercel podmienić ten plik
 (Vercel Blob / KV) — reszta aplikacji zna tylko te funkcje.
*/
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { config as loadEnv } from 'dotenv';


/*
 Układ repo (appsynth_mailer): korzeń = ta apka Next, `mailer/` (szablony, defaults, CLI) i `benchmarks/` obok.
 Lokalnie w audit/ są dowiązania: audit/mailer-ui → repo, audit/mailer → repo/mailer; AUDIT_ROOT w mailer/.env
 wskazuje na audit/ (customers/, benchmarks/). Na Vercelu AUDIT_ROOT = korzeń repo (benchmarks/ w repo, customers/ brak).
*/
function firstExisting(cands: string[], probe: string): string {
  return cands.find((c) => existsSync(resolve(c, probe))) ?? cands[0];
}
export const MAILER_ROOT = resolve(
  process.env.MAILER_ROOT ?? firstExisting([resolve(process.cwd(), 'mailer'), resolve(process.cwd(), '..', 'mailer')], 'templates'),
);
/** Vercel: system plików tylko do odczytu (poza /tmp) — bez zapisu klientów, uploadów i lokalnego logu. */
export const READ_ONLY = !!process.env.VERCEL;

let envLoaded = false;
export function loadMailerEnv() {
  if (envLoaded) return;
  loadEnv({ path: resolve(MAILER_ROOT, '.env') });
  envLoaded = true;
}
loadMailerEnv(); // AUDIT_ROOT może być w mailer/.env
export const AUDIT_ROOT = resolve(process.env.AUDIT_ROOT ?? resolve(MAILER_ROOT, '..'));

import type { ClientRecord, Defaults } from './effective';
export type { Vars } from './effective';

const safeName = (n: string) => {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(n)) throw new Error(`Niedozwolona nazwa: ${n}`);
  return n;
};

export function listTemplates(): string[] {
  return readdirSync(resolve(MAILER_ROOT, 'templates'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.replace(/\.html$/, ''))
    .sort();
}

export function readTemplate(name: string): string {
  return readFileSync(resolve(MAILER_ROOT, 'templates', `${safeName(name)}.html`), 'utf8');
}

export function readDefaults(): Defaults {
  const p = resolve(MAILER_ROOT, 'defaults.json');
  if (!existsSync(p)) return {};
  const d = JSON.parse(readFileSync(p, 'utf8')) as Defaults & { _comment?: string };
  delete d._comment;
  return d;
}

const clientsDir = () => resolve(MAILER_ROOT, 'clients');

export function listClients(): { id: string; customer: string; firma: string; mtime: number }[] {
  if (READ_ONLY) return [];
  mkdirSync(clientsDir(), { recursive: true });
  return readdirSync(clientsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const id = f.replace(/\.json$/, '');
      const p = resolve(clientsDir(), f);
      let customer = id, firma = '';
      try { const r = JSON.parse(readFileSync(p, 'utf8')) as ClientRecord; customer = r.customer ?? id; firma = typeof r.FIRMA === 'string' ? r.FIRMA : ''; } catch { /* zepsuty json — pokazujemy i tak */ }
      return { id, customer, firma, mtime: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function readClient(id: string): ClientRecord {
  return JSON.parse(readFileSync(resolve(clientsDir(), `${safeName(id)}.json`), 'utf8'));
}

export function clientExists(id: string): boolean {
  return existsSync(resolve(clientsDir(), `${safeName(id)}.json`));
}

export function writeClient(id: string, record: ClientRecord) {
  if (READ_ONLY) throw new Error('Na Vercelu rekordy klientów nie są zapisywane (decyzja: dane klientów zostają lokalnie)');
  mkdirSync(clientsDir(), { recursive: true });
  writeFileSync(resolve(clientsDir(), `${safeName(id)}.json`), JSON.stringify(record, null, 2) + '\n');
}

export function writeOut(name: string, html: string): string {
  if (READ_ONLY) return '';
  mkdirSync(resolve(MAILER_ROOT, 'out'), { recursive: true });
  const p = resolve(MAILER_ROOT, 'out', `${safeName(name)}.html`);
  writeFileSync(p, html);
  return p;
}

/** Ścieżka załącznika względem katalogu audit (tak jak w CLI). */
export function attachmentPath(rel: string): string {
  const p = resolve(AUDIT_ROOT, rel);
  if (!p.startsWith(AUDIT_ROOT + '/')) throw new Error(`Załącznik poza katalogiem audit: ${rel}`);
  if (!existsSync(p)) throw new Error(`Brak załącznika: ${rel}`);
  return p;
}

/** PDF-y w customers/<customer>/** — kandydaci na załączniki. */
export function listCustomerFiles(customer: string): string[] {
  if (READ_ONLY) return [];
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'evidence') walk(p, depth + 1); }
      else if (/\.(pdf|png|jpg|jpeg)$/i.test(e.name)) out.push(relative(AUDIT_ROOT, p));
    }
  };
  const dir = customer ? resolve(AUDIT_ROOT, 'customers', safeName(customer)) : '';
  if (dir && existsSync(dir)) walk(dir, 0);
  const uploads = resolve(MAILER_ROOT, 'uploads');
  if (existsSync(uploads)) walk(uploads, 3);
  return out.sort();
}

/** Log wysyłek: lokalnie plik w folderze klienta; na Vercelu Vercel Blob (`mailer-log/<klient>.txt`), jeśli jest BLOB_READ_WRITE_TOKEN. */
export async function appendLog(customer: string, line: string): Promise<void> {
  const text = line.endsWith('\n') ? line : line + '\n';
  if (READ_ONLY) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return;
    const { put, list } = await import('@vercel/blob');
    const key = `mailer-log/${safeName(customer || 'bez-klienta')}.txt`;
    let prev = '';
    const existing = (await list({ prefix: key, limit: 1 })).blobs.find((b) => b.pathname === key);
    if (existing) prev = await (await fetch(existing.downloadUrl)).text();
    await put(key, prev + text, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain; charset=utf-8' });
    return;
  }
  const dir = resolve(AUDIT_ROOT, 'customers', safeName(customer));
  const target = existsSync(dir) ? resolve(dir, 'mailer-log.txt') : resolve(MAILER_ROOT, 'out', 'mailer-log.txt');
  mkdirSync(resolve(MAILER_ROOT, 'out'), { recursive: true });
  appendFileSync(target, text);
}

export async function readLog(customer: string): Promise<string[]> {
  if (READ_ONLY) {
    if (!process.env.BLOB_READ_WRITE_TOKEN || !customer) return [];
    const { list } = await import('@vercel/blob');
    const key = `mailer-log/${safeName(customer)}.txt`;
    const existing = (await list({ prefix: key, limit: 1 })).blobs.find((b) => b.pathname === key);
    return existing ? (await (await fetch(existing.downloadUrl)).text()).split('\n').filter(Boolean) : [];
  }
  const p = resolve(AUDIT_ROOT, 'customers', safeName(customer), 'mailer-log.txt');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

export function readBenchmarkFiles(): { branch: 'rorleggere' | 'elektrikere'; lines: string[] }[] {
  const dir = resolve(AUDIT_ROOT, 'benchmarks');
  return (['rorleggere', 'elektrikere'] as const)
    .map((branch) => ({ branch, file: resolve(dir, `norge-${branch}-v0.4.jsonl`) }))
    .filter(({ file }) => existsSync(file))
    .map(({ branch, file }) => ({ branch, lines: readFileSync(file, 'utf8').split('\n').filter(Boolean) }));
}
