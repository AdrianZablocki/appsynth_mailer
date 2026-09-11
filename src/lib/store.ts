/*
 Jedyny moduł, który dotyka dysku. Przy przenosinach na Vercel podmienić ten plik
 (Vercel Blob / KV) — reszta aplikacji zna tylko te funkcje.
*/
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
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

/*
 Rekordy klientów: Vercel Blob (prywatny store `mailer-eu`, region fra1), gdy jest BLOB_READ_WRITE_TOKEN —
 lokalnie i na Vercelu to samo źródło. Bez tokenu: pliki mailer/clients/<id>.json (tryb offline).
 Lokalny folder clients/ jest KOPIĄ: `npm run clients:pull` / `clients:push` (scripts/sync-clients.mts).
*/
export const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
const blobKey = (id: string) => `clients/${safeName(id)}.json`;

async function blobGetText(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return new Response(r.stream).text();
}
async function blobPutText(pathname: string, text: string, contentType: string) {
  const { put } = await import('@vercel/blob');
  await put(pathname, text, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType });
}

export async function listClients(): Promise<{ id: string; customer: string; firma: string; mtime: number }[]> {
  if (USE_BLOB) {
    const { list } = await import('@vercel/blob');
    const out: { id: string; customer: string; firma: string; mtime: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'clients/', cursor, limit: 500 });
      for (const b of page.blobs) {
        const id = b.pathname.replace(/^clients\//, '').replace(/\.json$/, '');
        out.push({ id, customer: id, firma: '', mtime: new Date(b.uploadedAt).getTime() });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    // FIRMA do listy: rekordy są małe, pobieramy równolegle
    await Promise.all(out.map(async (row) => {
      try { const r = JSON.parse((await blobGetText(blobKey(row.id))) ?? '{}') as ClientRecord; row.customer = r.customer ?? row.id; row.firma = typeof r.FIRMA === 'string' ? r.FIRMA : ''; } catch { /* zepsuty json */ }
    }));
    return out.sort((a, b) => b.mtime - a.mtime);
  }
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

export async function readClient(id: string): Promise<ClientRecord> {
  if (USE_BLOB) {
    const t = await blobGetText(blobKey(id));
    if (t == null) throw new Error(`Brak klienta ${id}`);
    return JSON.parse(t) as ClientRecord;
  }
  return JSON.parse(readFileSync(resolve(clientsDir(), `${safeName(id)}.json`), 'utf8'));
}

export async function clientExists(id: string): Promise<boolean> {
  if (USE_BLOB) return (await blobGetText(blobKey(id))) != null;
  return existsSync(resolve(clientsDir(), `${safeName(id)}.json`));
}

export async function writeClient(id: string, record: ClientRecord): Promise<void> {
  const text = JSON.stringify(record, null, 2) + '\n';
  if (USE_BLOB) { await blobPutText(blobKey(id), text, 'application/json; charset=utf-8'); return; }
  if (READ_ONLY) throw new Error('Brak BLOB_READ_WRITE_TOKEN — na Vercelu rekordy klientów wymagają Vercel Blob');
  mkdirSync(clientsDir(), { recursive: true });
  writeFileSync(resolve(clientsDir(), `${safeName(id)}.json`), text);
}

/** Usuwa rekord klienta (Blob albo plik). Log wysyłek zostaje jako ślad. */
export async function deleteClient(id: string): Promise<void> {
  if (USE_BLOB) { const { del } = await import('@vercel/blob'); await del(blobKey(id)); return; }
  if (READ_ONLY) throw new Error('Brak BLOB_READ_WRITE_TOKEN');
  const p = resolve(clientsDir(), `${safeName(id)}.json`);
  if (existsSync(p)) unlinkSync(p);
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
  if (USE_BLOB) {
    const key = `mailer-log/${safeName(customer || 'bez-klienta')}.txt`;
    const prev = (await blobGetText(key)) ?? '';
    await blobPutText(key, prev + text, 'text/plain; charset=utf-8');
    if (READ_ONLY) return; // lokalnie dopisujemy też do pliku klienta (kopia)
  } else if (READ_ONLY) return;
  const dir = resolve(AUDIT_ROOT, 'customers', safeName(customer));
  const target = existsSync(dir) ? resolve(dir, 'mailer-log.txt') : resolve(MAILER_ROOT, 'out', 'mailer-log.txt');
  mkdirSync(resolve(MAILER_ROOT, 'out'), { recursive: true });
  appendFileSync(target, text);
}

export async function readLog(customer: string): Promise<string[]> {
  if (USE_BLOB && customer) {
    const t = await blobGetText(`mailer-log/${safeName(customer)}.txt`);
    if (t != null) return t.split('\n').filter(Boolean);
    if (READ_ONLY) return [];
  } else if (READ_ONLY) return [];
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
