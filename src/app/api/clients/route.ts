import { listClients, readClient, writeClient, clientExists, deleteClient } from '@/lib/store';
import type { ClientRecord } from '@/lib/effective';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const id = new URL(req.url).searchParams.get('id');
    return ok(id ? { id, record: await readClient(id) } : await listClients());
  } catch (e) { return fail(e); }
}

/** PUT { id, record, create? } — zapis clients/<id>.json (create=true odmawia nadpisania) */
export async function PUT(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const { id, record, create } = (await req.json()) as { id: string; record: ClientRecord; create?: boolean };
    if (!id || !record?.customer) throw new Error('Podaj id i record.customer');
    if (create && (await clientExists(id))) return fail(`Klient ${id} już istnieje`, 409);
    await writeClient(id, record);
    return ok({ saved: id });
  } catch (e) { return fail(e); }
}

/** DELETE ?id=<domena> — usuwa rekord klienta (log wysyłek zostaje) */
export async function DELETE(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) throw new Error('Podaj id');
    if (!(await clientExists(id))) return fail(`Brak klienta ${id}`, 404);
    await deleteClient(id);
    return ok({ deleted: id });
  } catch (e) { return fail(e); }
}
