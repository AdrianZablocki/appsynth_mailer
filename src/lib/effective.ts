/*
 Czysta logika (bez fs) — używana po stronie serwera i w przeglądarce.
 Rekord klienta = dane firmy/osoby + sekcja templates.<szablon> z nadpisaniami.
 Skuteczne vars dla szablonu = defaults[szablon] < rekord < rekord.templates[szablon].
*/
export type Scalar = string | string[] | undefined;
export type TemplateOverride = Record<string, Scalar>;
export interface ClientRecord {
  customer: string;
  templates?: Record<string, TemplateOverride>;
  notes?: string;
  [key: string]: Scalar | Record<string, TemplateOverride>;
}
export type Defaults = Record<string, Record<string, Scalar>>;
export type Vars = Record<string, Scalar> & { attachments?: string[]; customer?: string; subject?: string; to?: string; from?: string };

export const RECORD_ONLY = new Set(['templates', 'notes', '_comment']);
export const META_KEYS = new Set(['subject', 'to', 'from', 'customer', 'attachments']);

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 Podmiana [PLACEHOLDERÓW] w dowolnym tekście (dłuższe klucze najpierw). Wartość z samych spacji = niewypełniona.
 html: true — wartości są escapowane (np. FINDING «language tag (<html lang>)» nie znika jako tag, «&» nie psuje HTML).
*/
export function fill(text: string, vars: Record<string, Scalar>, opts: { html?: boolean } = {}): string {
  const keys = Object.keys(vars).filter((k) => !META_KEYS.has(k) && typeof vars[k] === 'string' && (vars[k] as string).trim() !== '').sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) out = out.split(`[${k}]`).join(opts.html ? escapeHtml(vars[k] as string) : (vars[k] as string));
  return out;
}

export function effectiveVars(client: ClientRecord, template: string, defaults: Defaults): Vars {
  const d = defaults[template] ?? {};
  const base: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(client)) if (!RECORD_ONLY.has(k)) base[k] = v as Scalar;
  const o = client.templates?.[template] ?? {};
  const v: Vars = { ...d, ...base, ...o };
  v.attachments = (o.attachments ?? base.attachments ?? d.attachments ?? []) as string[];
  // wartości mogą same zawierać [PLACEHOLDERY] (temat, HEADLINE z defaults.json) — jedna runda podstawień
  for (const k of Object.keys(v)) if (typeof v[k] === 'string' && (v[k] as string).includes('[')) v[k] = fill(v[k] as string, v);
  return v;
}

/** Czy edycja pola k dla szablonu t ma trafić do templates[t] (a nie do rekordu). */
export function isTemplateScoped(k: string, template: string, client: ClientRecord, defaults: Defaults): boolean {
  if (k === 'subject' || k === 'attachments') return true;
  if (client.templates?.[template] && k in client.templates[template]) return true;
  if (defaults[template] && k in defaults[template]) return true;
  return false;
}

export function setClientField(client: ClientRecord, template: string, defaults: Defaults, k: string, value: Scalar): ClientRecord {
  if (isTemplateScoped(k, template, client, defaults)) {
    const templates = { ...(client.templates ?? {}) };
    templates[template] = { ...(templates[template] ?? {}), [k]: value };
    return { ...client, templates };
  }
  return { ...client, [k]: value };
}

/**
 Szablony, które twierdzą coś o obecności firmy na listach AI. Pole LISTED w rekordzie (yes/no) = wynik testu G2
 i musi pasować do szablonu — inaczej mail stwierdza nieprawdę (Askel 25.09: `cold-mail` „was not on any of the lists”
 do firmy, która na listach była). Zwraca powód blokady albo null.
*/
export const LIST_CLAIM_TEMPLATES = new Set(['cold-mail', 'cold-mail-listed', 'follow-up', 'offer']);

export function listedValue(client: ClientRecord): 'yes' | 'no' | '' {
  const v = str(client.LISTED).trim().toLowerCase();
  return v === 'yes' || v === 'no' ? v : '';
}

/** cold-mail u firmy z listy jest dopuszczalny tylko z własnym tematem, LIST RESULT i HEADLINE (domyślny H1 mówi „Not [COMPANY]”; przypadek „1 z 8 odpowiedzi”). */
const hasCustomColdMail = (client: ClientRecord) =>
  ['subject', 'LIST RESULT', 'HEADLINE'].every((k) => !!str(client.templates?.['cold-mail']?.[k]).trim());

export function listClaimBlock(template: string, client: ClientRecord): string | null {
  if (!LIST_CLAIM_TEMPLATES.has(template)) return null;
  const listed = listedValue(client);
  if (!listed) return `Ustaw LISTED (yes/no) z wyniku testu G2, zanim wyślesz „${template}”: yes = firma pojawia się na listach AI, no = nie ma jej na żadnej.`;
  if (template === 'cold-mail-listed' && listed !== 'yes')
    return 'LISTED = no: firmy nie ma na listach AI, a „cold-mail-listed” twierdzi, że jest. Użyj „cold-mail”.';
  if (template === 'cold-mail' && listed === 'yes' && !hasCustomColdMail(client))
    return 'LISTED = yes: firma jest na listach AI, a „cold-mail” domyślnie mówi, że jej nie ma. Użyj „cold-mail-listed” albo wpisz dla „cold-mail” własny temat, LIST RESULT i HEADLINE.';
  return null;
}

/** Szablon pasujący do rekordu przy jego otwarciu (null = zostaw bieżący). */
export function suggestedTemplate(client: ClientRecord, current: string): string | null {
  if (current !== 'cold-mail' && current !== 'cold-mail-listed') return null;
  const listed = listedValue(client);
  if (!listed) return null;
  return listed === 'yes' && !hasCustomColdMail(client) ? 'cold-mail-listed' : 'cold-mail';
}
