import { readTemplate, readDefaults, readLog, sentEntries } from '@/lib/store';
import { effectiveVars, listClaimBlock, type ClientRecord } from '@/lib/effective';
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

type SendBody = { template: string; record: ClientRecord; mode: SendMode; to?: string; confirm?: string; resend?: boolean };
const ONE_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
/** Szablony, na które follow-up odpowiada w wątku (In-Reply-To = Message-ID ostatniego z nich). */
const THREAD_PARENTS = ['cold-mail', 'cold-mail-listed'];
const MAX_UPLOAD = 15 * 1024 * 1024;

/**
 POST JSON { template, record, mode: 'test'|'really', to?, confirm?, resend? }
 albo multipart: pole `payload` (ten sam JSON) + pliki `files` (załączniki z przeglądarki, tylko w pamięci, PDF/PNG/JPG ≤15 MB).
 Serwer sam liczy skuteczne vars z rekordu + defaults. mode=really wymaga confirm === record.customer (odpowiednik --really)
 i odrzuca (409) szablon, który już jest w logu klienta, chyba że resend=true. follow-up idzie w wątku cold maila.
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
    if (mode !== 'test' && mode !== 'really') return fail(`Nieznany tryb wysyłki: ${String(mode)}`, 400);
    const blocked = listClaimBlock(template, record);
    if (blocked) return fail(blocked, 422);
    if (mode === 'really' && (body.confirm ?? '').trim().toLowerCase() !== customer.toLowerCase())
      return fail(`Potwierdzenie nie zgadza się z domeną klienta (${customer})`, 412);
    const vars = effectiveVars(record, template, readDefaults());
    const r = render(readTemplate(template), vars);
    if (r.leftovers.length) return fail(`Niewypełnione pola: ${r.leftovers.join(', ')}`, 422);
    if (!vars.subject) throw new Error('Brak "subject"');
    const to = mode === 'test' ? undefined : (body.to || vars.to)?.trim();
    if (mode === 'really' && (!to || !ONE_ADDRESS.test(to))) return fail(`Adres odbiorcy musi być jednym adresem e-mail: ${to ?? '(pusty)'}`, 422);
    const log = await readLog(customer);
    if (mode === 'really' && !body.resend) {
      const prev = sentEntries(log, template);
      if (prev.length) return fail(`„${template}” już poszedł do ${customer} (${prev[prev.length - 1].at}). Zaznacz „wyślij ponownie”, jeśli to celowe.`, 409);
    }
    const inReplyTo = template === 'follow-up'
      ? THREAD_PARENTS.flatMap((t) => sentEntries(log, t)).filter((e) => e.messageId).sort((a, b) => a.at.localeCompare(b.at)).pop()?.messageId
      : undefined;
    const result = await sendMail({ mode, to, from: vars.from, subject: vars.subject, html: r.html, text: r.text, vars, templateName: template, customer, uploads, inReplyTo });
    return ok(result);
  } catch (e) { return fail(e); }
}
