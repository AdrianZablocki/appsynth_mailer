import { readTemplate, readDefaults } from '@/lib/store';
import { effectiveVars, type ClientRecord } from '@/lib/effective';
import { render } from '@/lib/render';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';

/** POST { template, record } → { html, text, leftovers, vars } */
export async function POST(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const { template, record } = (await req.json()) as { template: string; record: ClientRecord };
    const vars = effectiveVars(record, template, readDefaults());
    return ok({ ...render(readTemplate(template), vars), vars });
  } catch (e) { return fail(e); }
}
