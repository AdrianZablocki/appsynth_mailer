import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { appendLog, attachmentPath, loadMailerEnv, writeOut, type Vars } from './store';

export type SendMode = 'test' | 'really';

export interface SendResult {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  attachments: string[];
  imap: { ok: true; folder: string } | { ok: false; error: string } | null;
  logged: boolean;
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);

export interface Sender { name: string; address: string }

/** Aliasy skrzynki z FROM_ADDRESSES ("Nazwa <adres>, …"); fallback: FROM_NAME <SMTP_USER>. Pierwszy = domyślny. */
export function senders(): Sender[] {
  loadMailerEnv();
  const list = (process.env.FROM_ADDRESSES ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = x.match(/^(.*?)\s*<([^>]+)>$/);
      return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: '', address: x.toLowerCase() };
    });
  if (!list.length && process.env.SMTP_USER) list.push({ name: process.env.FROM_NAME ?? '', address: process.env.SMTP_USER });
  return list;
}

/** Zwraca nadawcę z listy po adresie; nieznany adres = błąd (nie wysyłamy z czegokolwiek). */
export function resolveSender(address?: string): Sender {
  const all = senders();
  if (!all.length) throw new Error('Brak FROM_ADDRESSES/SMTP_USER w mailer/.env');
  if (!address) return all[0];
  const hit = all.find((s) => s.address === address.trim().toLowerCase());
  if (!hit) throw new Error(`Nadawca ${address} nie jest na liście FROM_ADDRESSES`);
  return hit;
}

export function senderInfo() {
  const all = senders();
  return { senders: all, from: all[0]?.address ?? '', fromName: all[0]?.name ?? '', testTo: process.env.TEST_TO ?? '' };
}

export async function sendMail(opts: {
  mode: SendMode;
  to?: string;
  subject: string;
  html: string;
  text: string;
  vars: Vars;
  templateName: string;
  customer: string;
  from?: string;
  /** załączniki wgrane z przeglądarki (nie zapisywane na dysku) */
  uploads?: { filename: string; content: Buffer }[];
}): Promise<SendResult> {
  loadMailerEnv();
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, TEST_TO, IMAP_HOST } = process.env;
  const sender = resolveSender(opts.from);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new Error('Uzupełnij SMTP_* w mailer/.env');

  const test = opts.mode === 'test';
  const to = test ? TEST_TO : opts.to;
  if (!to) throw new Error(test ? 'Brak TEST_TO w mailer/.env' : 'Brak adresata');

  const attachments: { path?: string; filename?: string; content?: Buffer }[] = [
    ...(opts.vars.attachments ?? []).map((rel) => ({ path: attachmentPath(rel) })),
    ...(opts.uploads ?? []).map((u) => ({ filename: u.filename, content: u.content })),
  ];
  const port = Number(SMTP_PORT ?? 465);
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  const message = {
    from: { name: sender.name || sender.address, address: sender.address },
    to,
    subject: test ? `[TEST] ${opts.subject}` : opts.subject,
    text: opts.text,
    html: opts.html,
    attachments,
  };
  const info = await transport.sendMail(message);
  writeOut(`${opts.customer || 'bez-klienta'}-${opts.templateName}${test ? '-TEST' : ''}-${new Date().toISOString().slice(0, 10)}`, opts.html);

  let imap: SendResult['imap'] = null;
  if (IMAP_HOST) {
    try {
      const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(message);
      const client = new ImapFlow({
        host: IMAP_HOST, port: Number(process.env.IMAP_PORT ?? 993), secure: true,
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD }, logger: false,
      });
      await withTimeout(client.connect(), 15000);
      const boxes = await withTimeout(client.list(), 15000);
      const sent =
        boxes.find((b) => b.specialUse === '\\Sent')?.path ??
        boxes.find((b) => /^(sent|wys[łl]ane|sent items)$/i.test(b.name))?.path ??
        process.env.IMAP_SENT_FOLDER ?? 'Sent';
      await withTimeout(client.append(sent, raw.message as Buffer, ['\\Seen']), 30000);
      await withTimeout(client.logout(), 5000).catch(() => client.close());
      imap = { ok: true, folder: sent };
    } catch (e) {
      imap = { ok: false, error: (e as Error).message };
    }
  }

  let logged = false;
  if (!test) {
    await appendLog(opts.customer, `${new Date().toISOString()} | ${opts.templateName} | from=${sender.address} | to=${to} | subject=${opts.subject}`).catch((e) => console.error('log:', e));
    logged = true;
  }

  return {
    from: sender.address, to, subject: message.subject, messageId: info.messageId,
    attachments: attachments.map((a) => a.filename ?? a.path?.split('/').pop() ?? '?'),
    imap, logged,
  };
}
