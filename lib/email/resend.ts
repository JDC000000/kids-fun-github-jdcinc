// lib/email/resend.ts — minimal Resend REST client for the weekly digest.
//
// Uses Resend's HTTP API (POST https://api.resend.com/emails) directly via fetch —
// no SDK dependency to pin, and the request payload is a plain object we can build
// and assert on without a network round-trip. The API key is read only here, only
// to construct the Authorization header, and is NEVER logged or returned.
//
// SAFETY: `dryRun` builds the exact payload and returns it WITHOUT dispatching, so
// the whole pipeline can be verified end-to-end (payload shape, recipient, headers)
// with zero real email sent. The orchestrator forces dryRun whenever sending is not
// explicitly enabled (lib/email/config.sendingEnabled()).
import { fromAddress, getResendApiKey } from './config';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  replyTo?: string;
  dryRun?: boolean;
}

/** The exact JSON body sent to Resend (no secret ever appears here). */
export interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  reply_to?: string;
}

export type SendResult =
  | { status: 'sent'; id: string; payload: ResendPayload }
  | { status: 'dry_run'; payload: ResendPayload }
  | { status: 'skipped_no_key'; payload: ResendPayload }
  | { status: 'error'; error: string; payload: ResendPayload };

function buildPayload(input: SendEmailInput): ResendPayload {
  const payload: ResendPayload = {
    from: fromAddress(),
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text) payload.text = input.text;
  if (input.headers && Object.keys(input.headers).length > 0) payload.headers = input.headers;
  if (input.replyTo) payload.reply_to = input.replyTo;
  return payload;
}

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  const payload = buildPayload(input);

  if (input.dryRun) return { status: 'dry_run', payload };

  const key = getResendApiKey();
  if (!key) return { status: 'skipped_no_key', payload };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: 'error', error: `resend responded ${res.status}: ${body.slice(0, 200)}`, payload };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { status: 'sent', id: data.id ?? '', payload };
  } catch (err) {
    return { status: 'error', error: (err as Error)?.message ?? 'network error', payload };
  }
}
