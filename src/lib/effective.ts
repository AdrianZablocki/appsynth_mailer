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

/** Podmiana [PLACEHOLDERÓW] w dowolnym tekście (dłuższe klucze najpierw). */
export function fill(text: string, vars: Record<string, Scalar>): string {
  const keys = Object.keys(vars).filter((k) => !META_KEYS.has(k) && typeof vars[k] === 'string' && vars[k] !== '').sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) out = out.split(`[${k}]`).join(vars[k] as string);
  return out;
}

export function effectiveVars(client: ClientRecord, template: string, defaults: Defaults): Vars {
  const d = defaults[template] ?? {};
  const base: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(client)) if (!RECORD_ONLY.has(k)) base[k] = v as Scalar;
  const o = client.templates?.[template] ?? {};
  const v: Vars = { ...d, ...base, ...o };
  v.attachments = (o.attachments ?? base.attachments ?? d.attachments ?? []) as string[];
  if (typeof v.subject === 'string') v.subject = fill(v.subject, v);
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
