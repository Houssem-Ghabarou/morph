/**
 * Clean, self-contained HTML email templates for the automation engine.
 * All styling is inlined because email clients strip <style> blocks / external CSS.
 */

export type EmailTemplate = 'report' | 'alert' | 'reminder' | 'notification';

export interface RenderEmailInput {
  template: EmailTemplate;
  heading: string;
  /** LLM-generated 2-3 sentence summary paragraph. */
  summary?: string;
  /** LLM-generated next-action suggestion. */
  suggestion?: string;
  /** Pre-rendered custom message (used by alert / reminder / notification). */
  message?: string;
  /** Tabular data to render. */
  rows?: Record<string, unknown>[];
  columns?: string[];
  maxRows?: number;
  /** Multiple labelled tables (used by multi-module session digests). */
  sections?: Array<{ title: string; rows: Record<string, unknown>[]; columns?: string[] }>;
  /** Optional "Open in Morph" link. */
  sessionLink?: string;
  /** Footer note, e.g. automation name. */
  footerNote?: string;
}

const BRAND = '#7c3aed';

const ACCENTS: Record<EmailTemplate, { color: string; bg: string; label: string }> = {
  report:       { color: '#7c3aed', bg: '#f5f3ff', label: 'Report' },
  alert:        { color: '#dc2626', bg: '#fef2f2', label: 'Alert' },
  reminder:     { color: '#d97706', bg: '#fffbeb', label: 'Reminder' },
  notification: { color: '#2563eb', bg: '#eff6ff', label: 'Notification' },
};

/** Replace {{key}} placeholders with values from vars (count, name, etc.). */
export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prettyHeader(col: string): string {
  return col.replace(/^s\d+_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderTable(rows: Record<string, unknown>[], columns: string[], maxRows: number): string {
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  const shown = rows.slice(0, maxRows);

  const head = cols
    .map(
      (c) =>
        `<th style="text-align:left;padding:8px 12px;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.03em;">${escapeHtml(prettyHeader(c))}</th>`
    )
    .join('');

  const body = shown
    .map((row, i) => {
      const cells = cols
        .map(
          (c) =>
            `<td style="padding:8px 12px;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;">${escapeHtml(row[c])}</td>`
        )
        .join('');
      const bg = i % 2 === 0 ? '#ffffff' : '#fafafa';
      return `<tr style="background:${bg};">${cells}</tr>`;
    })
    .join('');

  const more =
    rows.length > maxRows
      ? `<p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">+ ${rows.length - maxRows} more row(s)</p>`
      : '';

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:8px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>${more}`;
}

/** Render an automation email to HTML + plain-text. */
export function renderEmail(input: RenderEmailInput): { html: string; text: string } {
  const accent = ACCENTS[input.template];
  const maxRows = input.maxRows ?? 50;
  const hasTable = !!(input.rows && input.rows.length > 0);

  const parts: string[] = [];

  if (input.message) {
    parts.push(
      `<div style="padding:14px 16px;background:${accent.bg};border-left:4px solid ${accent.color};border-radius:6px;margin:0 0 16px;">
         <p style="margin:0;font-size:15px;line-height:1.6;color:#1f2937;">${escapeHtml(input.message)}</p>
       </div>`
    );
  }

  if (input.summary) {
    parts.push(
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">${escapeHtml(input.summary)}</p>`
    );
  }

  if (hasTable) {
    parts.push(renderTable(input.rows!, input.columns ?? [], maxRows));
  }

  if (input.sections) {
    for (const section of input.sections) {
      parts.push(
        `<h2 style="margin:22px 0 6px;font-size:14px;font-weight:700;color:#374151;">${escapeHtml(section.title)}</h2>`
      );
      if (section.rows.length > 0) {
        parts.push(renderTable(section.rows, section.columns ?? [], maxRows));
      } else {
        parts.push(`<p style="margin:0;font-size:13px;color:#9ca3af;">No records.</p>`);
      }
    }
  }

  if (input.suggestion) {
    parts.push(
      `<div style="margin:18px 0 0;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
         <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;letter-spacing:0.05em;">Suggested next step</p>
         <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">${escapeHtml(input.suggestion)}</p>
       </div>`
    );
  }

  const cta = input.sessionLink
    ? `<a href="${escapeHtml(input.sessionLink)}" style="display:inline-block;margin-top:20px;padding:10px 18px;background:${BRAND};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;border-radius:8px;">Open in Morph</a>`
    : '';

  const footer = input.footerNote
    ? `<p style="margin:24px 0 0;font-size:11px;color:#9ca3af;">${escapeHtml(input.footerNote)}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="padding:20px 28px;background:linear-gradient(135deg,${BRAND},#6d28d9);">
          <table role="presentation" width="100%"><tr>
            <td style="font-size:16px;font-weight:700;color:#ffffff;">◆ Morph</td>
            <td align="right"><span style="display:inline-block;padding:3px 10px;background:rgba(255,255,255,0.2);color:#ffffff;font-size:11px;font-weight:600;border-radius:20px;text-transform:uppercase;letter-spacing:0.04em;">${accent.label}</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 18px;font-size:20px;font-weight:700;color:#111827;line-height:1.3;">${escapeHtml(input.heading)}</h1>
          ${parts.join('\n')}
          ${cta}
          ${footer}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">Sent automatically by Morph · your data, working for you.</p>
    </td></tr>
  </table>
</body></html>`;

  const sectionText = (input.sections ?? [])
    .map((s) => `${s.title}\n${s.rows.length ? renderTableText(s.rows, s.columns ?? [], maxRows) : 'No records.'}`)
    .join('\n\n');

  const textParts = [
    input.heading,
    input.message ?? '',
    input.summary ?? '',
    hasTable ? renderTableText(input.rows!, input.columns ?? [], maxRows) : '',
    sectionText,
    input.suggestion ? `Suggested next step: ${input.suggestion}` : '',
  ].filter(Boolean);

  return { html, text: textParts.join('\n\n') };
}

function renderTableText(rows: Record<string, unknown>[], columns: string[], maxRows: number): string {
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  const header = cols.map(prettyHeader).join(' | ');
  const lines = rows.slice(0, maxRows).map((r) => cols.map((c) => String(r[c] ?? '')).join(' | '));
  return [header, ...lines].join('\n');
}
