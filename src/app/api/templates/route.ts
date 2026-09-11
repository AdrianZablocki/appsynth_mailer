import { listTemplates, readTemplate } from '@/lib/store';
import { placeholders } from '@/lib/render';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';
export async function GET() {
  const denied = await guard(); if (denied) return denied;
  try {
    return ok(listTemplates().map((name) => ({ name, placeholders: placeholders(readTemplate(name)) })));
  } catch (e) { return fail(e, 500); }
}
