import nodemailer, { type Transporter } from 'nodemailer';

// SMTP mailer. Configured for Proton Mail's SMTP submission service
// (smtp.protonmail.ch) but works with any SMTP provider via env vars:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
// Proton notes: use port 587 (STARTTLS), SMTP_USER is your Proton address, and
// SMTP_PASS is an SMTP token generated in Proton settings (not your login password).

interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // Optional Reply-To. The envelope `from` always stays SMTP_FROM (Proton only
  // lets you send as an address you own), so to route replies elsewhere — e.g. a
  // contact-form forward that should reply to the visitor — set replyTo.
  replyTo?: string;
}

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT ?? 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM ?? user;

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!host || !user || !pass) return null;
  transporter ??= nodemailer.createTransport({
    host,
    port,
    // 465 = implicit TLS; 587 = STARTTLS (the Proton default).
    secure: port === 465,
    auth: { user, pass },
  });
  return transporter;
}

/** Whether SMTP is configured; when it isn't, sendEmail only logs and returns. */
export function isEmailConfigured(): boolean {
  return Boolean(host && user && pass);
}

export async function sendEmail({ to, subject, text, html, replyTo }: SendEmailArgs): Promise<void> {
  const tx = getTransporter();
  if (!tx) {
    // No SMTP configured (e.g. local dev). Log so the flow is still testable
    // without silently dropping the message.
    console.warn(
      `[email] SMTP not configured; skipping send to ${to}.\nSubject: ${subject}\n${replyTo ? `Reply-To: ${replyTo}\n` : ''}${text}`,
    );
    return;
  }
  await tx.sendMail({ from, to, subject, text, html, replyTo });
}
