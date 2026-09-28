/*
 Synchronizacja rekordów klientów: Vercel Blob (źródło) <-> mailer/clients/*.json (lokalna kopia).
   npm run clients:pull                # Blob → pliki
   npm run clients:push                # pliki → Blob
   npm run clients:push -- --dry-run   # tylko pokaż, co by się stało
   npm run clients:push -- --force     # nadpisz też, gdy druga strona jest nowsza
 Plik identyczny po obu stronach jest pomijany. Plik, który po drugiej stronie jest NOWSZY i inny (np. edycja w panelu na
 prod po ostatnim pull), jest pomijany z ostrzeżeniem — bez --force push nie cofa zmian z panelu, a pull nie kasuje lokalnych.
 Po pull data modyfikacji pliku = data zapisu w Blobie, więc porównanie „kto nowszy” ma sens.
 Token: BLOB_READ_WRITE_TOKEN z .env.local (npx vercel env pull .env.local --environment development).
*/
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
config({ path: resolve(process.cwd(), '.env.local') });
const { list, get, put } = await import('@vercel/blob');

const dir = resolve(process.cwd(), 'mailer', 'clients');
const [mode, ...flags] = process.argv.slice(2);
const force = flags.includes('--force');
const dry = flags.includes('--dry-run');
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Brak BLOB_READ_WRITE_TOKEN w .env.local');
if (mode !== 'pull' && mode !== 'push') throw new Error('Użycie: sync-clients.mts pull|push [--dry-run] [--force]');

async function blobIndex(): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: 'clients/', cursor, limit: 500 });
    for (const b of page.blobs) out.set(b.pathname.replace(/^clients\//, ''), new Date(b.uploadedAt));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}
async function blobText(name: string): Promise<string | null> {
  const r = await get(`clients/${name}`, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return new Response(r.stream).text();
}
const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();

mkdirSync(dir, { recursive: true });
const remote = await blobIndex();
let skipped = 0;

if (mode === 'push') {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const path = resolve(dir, f);
    const text = readFileSync(path, 'utf8');
    JSON.parse(text); // walidacja
    const uploadedAt = remote.get(f);
    if (uploadedAt) {
      const cur = await blobText(f);
      if (cur != null && same(cur, text)) continue;
      if (uploadedAt.getTime() > statSync(path).mtimeMs && !force) {
        console.warn(`! pomijam ${f}: w Blobie nowsza wersja (${uploadedAt.toISOString()}) — najpierw clients:pull albo --force`);
        skipped++; continue;
      }
    }
    if (!dry) await put(`clients/${f}`, text, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json; charset=utf-8' });
    console.log(`${dry ? '(dry-run) ' : ''}→ Blob ${f}${uploadedAt ? '' : ' (nowy)'}`);
  }
  const local = new Set(readdirSync(dir));
  for (const f of remote.keys()) if (!local.has(f)) console.log(`  tylko w Blobie (bez zmian): ${f}`);
} else {
  for (const [f, uploadedAt] of remote) {
    const text = await blobText(f);
    if (text == null) continue;
    const path = resolve(dir, f);
    if (existsSync(path)) {
      const cur = readFileSync(path, 'utf8');
      if (same(cur, text)) continue;
      if (statSync(path).mtimeMs > uploadedAt.getTime() && !force) {
        console.warn(`! pomijam ${f}: lokalna kopia nowsza niż Blob (niewypchnięte zmiany?) — clients:push albo --force`);
        skipped++; continue;
      }
    }
    if (!dry) { writeFileSync(path, text); utimesSync(path, uploadedAt, uploadedAt); }
    console.log(`${dry ? '(dry-run) ' : ''}← Blob ${f}`);
  }
}
if (skipped) process.exitCode = 1;
