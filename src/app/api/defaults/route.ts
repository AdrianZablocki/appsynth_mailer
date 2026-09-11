import { readDefaults } from '@/lib/store';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';
export async function GET() {
  const denied = await guard(); if (denied) return denied;
  try { return ok(readDefaults()); } catch (e) { return fail(e, 500); }
}
