import { htmlToText } from 'html-to-text';
import { fill, META_KEYS, type Vars } from './effective';
export { META_KEYS } from './effective';

/** Usuwa komentarz nagłówkowy szablonu (instrukcja dla webmaila). */
export const stripHeaderComment = (t: string) => t.replace(/^<!--[\s\S]*?-->\s*/, '');

/** Placeholdery [W NAWIASACH] w szablonie, w kolejności wystąpienia. */
export function placeholders(template: string): string[] {
  const seen = new Set<string>();
  for (const m of stripHeaderComment(template).matchAll(/\[([A-Za-zÆØÅæøå0-9][^\]\n]{0,140})\]/g)) seen.add(m[1]);
  return [...seen];
}

export function render(template: string, vars: Vars) {
  const body = stripHeaderComment(template);
  const html = fill(body, vars, { html: true });
  // placeholdery szablonu, które zostały w treści (też małymi literami, np. [company.no]) + ogólny wzorzec [WIELKIE]
  const fromTemplate = placeholders(body).filter((k) => !META_KEYS.has(k) && html.includes(`[${k}]`)).map((k) => `[${k}]`);
  const leftovers = [...new Set([...fromTemplate, ...(html.match(/\[[A-ZÆØÅ0-9][^\]\n]{0,140}\]/g) ?? [])])];
  const text = htmlToText(html, { wordwrap: 78, selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }, { selector: '.preheader', format: 'skip' }, { selector: 'img', format: 'skip' }, { selector: 'h1', options: { uppercase: false } }] });
  return { html, text, leftovers };
}
