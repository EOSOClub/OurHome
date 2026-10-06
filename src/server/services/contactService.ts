import { prisma } from '@/server/db/prisma';
import { sendEmail } from '@/server/email/mailer';
import type { ContactInput } from '@/lib/validation/contact';
import type { ContactMessageDTO } from '@/lib/types';
import { APP_NAME } from '@/server/config';

// Where contact-form submissions are forwarded (CONTACT_FORWARD_TO). Unset →
// the message is still stored and confirmed to the sender, just not forwarded.
const FORWARD_TO = process.env.CONTACT_FORWARD_TO?.trim() || null;

interface SubmitMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Persist a contact-form submission, then send two emails:
 *   1. a confirmation to the visitor (from support@ — configured via SMTP_FROM),
 *   2. a forward to FORWARD_TO with the visitor's address as Reply-To.
 *
 * The row is stored first, so a mail failure never loses the message: we log it,
 * flag the row `email_failed`, and still return success to the caller (we already
 * have their message; surfacing an error after the fact would be worse UX).
 */
export async function submitContactMessage(
  input: Pick<ContactInput, 'name' | 'email' | 'description'>,
  meta: SubmitMeta = {},
) {
  const record = await prisma.contactMessage.create({
    data: {
      name: input.name,
      email: input.email,
      description: input.description,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      status: 'received',
    },
  });

  try {
    await sendEmail({
      to: input.email,
      subject: `We received your message — ${APP_NAME}`,
      text: confirmationText(input.name),
      html: confirmationHtml(input.name),
    });

    if (FORWARD_TO) {
      await sendEmail({
        to: FORWARD_TO,
        replyTo: input.email,
        subject: `New contact form message from ${input.name}`,
        text: forwardText(input, meta),
        html: forwardHtml(input, meta),
      });
    } else {
      console.warn(`[contact] CONTACT_FORWARD_TO not set; message ${record.id} stored but not forwarded.`);
    }

    await prisma.contactMessage.update({
      where: { id: record.id },
      data: { status: 'emailed' },
    });
  } catch (err) {
    console.error('[contact] failed to send email for message', record.id, err);
    await prisma.contactMessage
      .update({ where: { id: record.id }, data: { status: 'email_failed' } })
      .catch(() => {});
  }

  return record;
}

function toDTO(row: {
  id: string;
  name: string;
  email: string;
  description: string;
  status: string;
  createdAt: Date;
}): ContactMessageDTO {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Most recent contact-form submissions, newest first. ContactMessage is not
 * household-scoped (the public form has no household context), so callers must
 * gate access by permission — see /api/contact/messages. IP/UA are deliberately
 * omitted from the DTO; they exist only for abuse tracing.
 */
export async function listContactMessages(
  limit = 20,
): Promise<ContactMessageDTO[]> {
  const rows = await prisma.contactMessage.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(toDTO);
}

function confirmationText(name: string): string {
  return [
    `Hi ${name},`,
    '',
    `Thanks for reaching out to ${APP_NAME}. We received your message and someone will be in contact with you soon.`,
    '',
    'You do not need to reply to this email.',
    '',
    `— ${APP_NAME}`,
  ].join('\n');
}

function confirmationHtml(name: string): string {
  const appName = escapeHtml(APP_NAME);
  return `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Thanks for reaching out to ${appName}. We received your message and
    someone will be in contact with you soon.</p>
    <p>You do not need to reply to this email.</p>
    <p>— ${appName}</p>
  `;
}

function forwardText(
  input: Pick<ContactInput, 'name' | 'email' | 'description'>,
  meta: SubmitMeta,
): string {
  return [
    'New contact form submission:',
    '',
    `Name:  ${input.name}`,
    `Email: ${input.email}`,
    '',
    'Message:',
    input.description,
    '',
    '---',
    `IP: ${meta.ip ?? 'unknown'}`,
    `User-Agent: ${meta.userAgent ?? 'unknown'}`,
    '',
    'Reply directly to this email to respond to the sender.',
  ].join('\n');
}

function forwardHtml(
  input: Pick<ContactInput, 'name' | 'email' | 'description'>,
  meta: SubmitMeta,
): string {
  return `
    <p><strong>New contact form submission:</strong></p>
    <p><strong>Name:</strong> ${escapeHtml(input.name)}<br/>
    <strong>Email:</strong> ${escapeHtml(input.email)}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space:pre-wrap">${escapeHtml(input.description)}</p>
    <hr/>
    <p style="color:#666;font-size:12px">IP: ${escapeHtml(meta.ip ?? 'unknown')}<br/>
    User-Agent: ${escapeHtml(meta.userAgent ?? 'unknown')}</p>
    <p>Reply directly to this email to respond to the sender.</p>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
