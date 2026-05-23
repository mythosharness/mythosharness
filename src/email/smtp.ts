import nodemailer from "nodemailer";
import { config, requireMail } from "../config.ts";
import { log } from "../util/log.ts";

let _transport: nodemailer.Transporter | null = null;

function transport(): nodemailer.Transporter {
  if (_transport) return _transport;
  requireMail();
  _transport = nodemailer.createTransport({
    host: config.mail.smtpHost,
    port: config.mail.smtpPort,
    secure: config.mail.smtpPort === 465,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  return _transport;
}

export interface SendArgs {
  subject: string;
  text: string;
  markdown?: string;
  inReplyTo?: string;
  references?: string[];
}

export async function sendToOperator(args: SendArgs): Promise<void> {
  const t = transport();
  try {
    await t.sendMail({
      from: config.mail.user,
      to: config.mail.operator,
      subject: args.subject,
      text: args.text,
      html: args.markdown ? renderMdAsHtml(args.markdown) : undefined,
      inReplyTo: args.inReplyTo,
      references: args.references?.join(" "),
    });
    log.info(`Sent email: ${args.subject}`, { stage: "email" });
  } catch (e) {
    log.error(`SMTP send failed: ${(e as Error).message}`, { stage: "email" });
  }
}

function renderMdAsHtml(md: string): string {
  // Very small renderer — keep dependencies light. Operators can read the
  // attached/plaintext copy if they need fidelity.
  const escaped = md.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
  return `<pre style="font: 13px/1.4 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap;">${escaped}</pre>`;
}
