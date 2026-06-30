import nodemailer from 'nodemailer';
import { query } from './postgres';

export interface SmtpSettings {
  id?: number;
  user_id?: number;
  provider: string;       // 'smtp' | 'dev' (resend/sendgrid reserved for later)
  host: string | null;
  port: number | null;
  secure: boolean;
  smtp_user: string | null;
  smtp_pass: string | null;
  from_name: string | null;
  from_email: string | null;
  api_key: string | null;
}

export interface SendEmailInput {
  to: string[];
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  via: 'smtp' | 'dev';
  detail: string;
}

/** Load a user's saved email settings, or null if none configured. */
export async function getEmailSettings(userId: number): Promise<SmtpSettings | null> {
  const res = await query(
    `SELECT * FROM morph_smtp_settings WHERE user_id = $1`,
    [userId]
  );
  return res.rows.length > 0 ? (res.rows[0] as SmtpSettings) : null;
}

/**
 * True when the settings have enough info to actually reach an SMTP server.
 * When false we fall back to dev mode (log to console) so automations still
 * run end-to-end without credentials.
 */
function isSmtpUsable(s: SmtpSettings | null): s is SmtpSettings {
  return !!(s && s.provider === 'smtp' && s.host && s.from_email);
}

function fromHeader(s: SmtpSettings): string {
  const email = s.from_email ?? s.smtp_user ?? 'morph@localhost';
  return s.from_name ? `"${s.from_name}" <${email}>` : email;
}

/**
 * Send an email using the user's configured provider.
 * Falls back to a dev "console" transport when SMTP isn't configured —
 * the email is logged but reported as sent, so the rest of the pipeline works.
 */
export async function sendEmail(
  settings: SmtpSettings | null,
  input: SendEmailInput
): Promise<SendEmailResult> {
  const recipients = input.to.filter((t) => t && t.includes('@'));
  if (recipients.length === 0) {
    return { ok: false, via: 'dev', detail: 'No valid recipients' };
  }

  if (!isSmtpUsable(settings)) {
    // Dev fallback — log instead of sending so the flow is testable offline.
    console.log('\n📧 [DEV EMAIL — not sent, no SMTP configured]');
    console.log(`   To:      ${recipients.join(', ')}`);
    console.log(`   Subject: ${input.subject}`);
    console.log(`   Body:    ${(input.text ?? stripHtml(input.html)).slice(0, 300)}\n`);
    return {
      ok: true,
      via: 'dev',
      detail: `Logged to console (dev mode) for ${recipients.length} recipient(s)`,
    };
  }

  const transporter = nodemailer.createTransport({
    host: settings.host!,
    port: settings.port ?? 587,
    secure: settings.secure ?? false,
    auth: settings.smtp_user
      ? { user: settings.smtp_user, pass: settings.smtp_pass ?? '' }
      : undefined,
  });

  await transporter.sendMail({
    from: fromHeader(settings),
    to: recipients.join(', '),
    subject: input.subject,
    html: input.html,
    text: input.text ?? stripHtml(input.html),
  });

  return {
    ok: true,
    via: 'smtp',
    detail: `Sent via SMTP to ${recipients.length} recipient(s)`,
  };
}

/** Verify SMTP credentials without sending anything. */
export async function verifySmtp(settings: SmtpSettings): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: settings.host!,
    port: settings.port ?? 587,
    secure: settings.secure ?? false,
    auth: settings.smtp_user
      ? { user: settings.smtp_user, pass: settings.smtp_pass ?? '' }
      : undefined,
  });
  await transporter.verify();
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
