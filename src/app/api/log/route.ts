import { readLog } from '@/lib/store';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const customer = new URL(req.url).searchParams.get('customer') ?? '';
    return ok(customer ? await readLog(customer) : []);
  } catch (e) { return fail(e); }
}
