import { generateClient } from '@/lib/benchmark';
import { clientExists, writeClient, readClient } from '@/lib/store';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';
/** POST { host } → tworzy clients/<host>.json z benchmarku v0.4 (jeśli istnieje — zwraca istniejący, nic nie nadpisuje) */
export async function POST(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const { host } = (await req.json()) as { host: string };
    const { record, notes } = generateClient(host);
    const id = record.customer;
    if (await clientExists(id)) return ok({ id, record: await readClient(id), notes: [`Klient ${id} już istnieje — wczytano istniejący rekord`], existed: true });
    await writeClient(id, record);
    return ok({ id, record, notes, existed: false });
  } catch (e) { return fail(e); }
}
