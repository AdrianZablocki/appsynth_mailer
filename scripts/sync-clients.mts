/*
 Synchronizacja rekordów klientów: Vercel Blob (źródło) <-> mailer/clients/*.json (lokalna kopia).
   npm run clients:pull   # Blob → pliki (nadpisuje lokalne)
   npm run clients:push   # pliki → Blob (nadpisuje w Blobie)
 Token: BLOB_READ_WRITE_TOKEN z .env.local (npx vercel env pull .env.local --environment development).
*/
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
config({ path: resolve(process.cwd(), '.env.local') });
const { list, get, put } = await import('@vercel/blob');

const dir = resolve(process.cwd(), 'mailer', 'clients');
const mode = process.argv[2];
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Brak BLOB_READ_WRITE_TOKEN w .env.local');
if (mode !== 'pull' && mode !== 'push') throw new Error('Użycie: sync-clients.mts pull|push');

if (mode === 'push') {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const text = readFileSync(resolve(dir, f), 'utf8');
    JSON.parse(text); // walidacja
    await put(`clients/${f}`, text, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json; charset=utf-8' });
    console.log('→ Blob', f);
  }
} else {
  mkdirSync(dir, { recursive: true });
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: 'clients/', cursor, limit: 500 });
    for (const b of page.blobs) {
      const r = await get(b.pathname, { access: 'private', useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) continue;
      const name = b.pathname.replace(/^clients\//, '');
      writeFileSync(resolve(dir, name), await new Response(r.stream).text());
      console.log('← Blob', name);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}
