import { readTemplate, readDefaults } from '@/lib/store';
import { effectiveVars, type ClientRecord } from '@/lib/effective';
import { render } from '@/lib/render';
import { sendMail, senderInfo, type SendMode } from '@/lib/send';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // SMTP + kopia IMAP potrafią przekroczyć domyślne 10 s na Vercelu
export const preferredRegion = 'fra1';

export async function GET() {
  const denied = await guard(); if (denied) return denied;
  try { return ok(senderInfo()); } catch (e) { return fail(e, 500); }
}

type SendBody = { template: string; record: ClientRecord; mode: SendMode; to?: string; confirm?: string };
const MAX_UPLOAD = 15 * 1024 * 1024;

/**
 POST JSON { template, record, mode: 'test'|'really', to?, confirm? }
 albo multipart: pole `payload` (ten sam JSON) + pliki `files` (załączniki z przeglądarki, tylko w pamięci, PDF/PNG/JPG ≤15 MB).
 Serwer sam liczy skuteczne vars z rekordu + defaults. mode=really wymaga confirm === record.customer (odpowiednik --really).
*/
export async function POST(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    let body: SendBody;
    const uploads: { filename: string; content: Buffer }[] = [];
    if (req.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await req.formData();
      body = JSON.parse(String(form.get('payload') ?? '{}')) as SendBody;
      for (const f of form.getAll('files')) {
        if (!(f instanceof File)) continue;
        if (!/\.(pdf|png|jpe?g)$/i.test(f.name)) throw new Error(`Niedozwolony typ załącznika: ${f.name}`);
        if (f.size > MAX_UPLOAD) throw new Error(`Załącznik ${f.name} większy niż 15 MB`);
        uploads.push({ filename: f.name, content: Buffer.from(await f.arrayBuffer()) });
      }
    } else {
      body = (await req.json()) as SendBody;
    }
    const { template, record, mode } = body;
    if (!template || !record || !mode) throw new Error('Brak template/record/mode');
    const customer = record.customer ?? '';
    if (!customer) throw new Error('record.customer jest puste — nie wiem, do kogo to jest');
    if (mode === 'really' && (body.confirm ?? '').trim().toLowerCase() !== customer.toLowerCase())
      return fail(`Potwierdzenie nie zgadza się z domeną klienta (${customer})`, 412);
    const vars = effectiveVars(record, template, readDefaults());
    const r = render(readTemplate(template), vars);
    if (r.leftovers.length) return fail(`Niewypełnione pola: ${r.leftovers.join(', ')}`, 422);
    if (!vars.subject) throw new Error('Brak "subject"');
    const to = mode === 'test' ? undefined : (body.to || vars.to);
    const result = await sendMail({ mode, to, from: vars.from, subject: vars.subject, html: r.html, text: r.text, vars, templateName: template, customer, uploads });
    return ok(result);
  } catch (e) { return fail(e); }
}
