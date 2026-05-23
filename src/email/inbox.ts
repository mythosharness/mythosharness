import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config, requireMail } from "../config.ts";
import { db } from "../memory/db.ts";
import { log } from "../util/log.ts";

export interface InboundCommand {
  uid: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

function alreadyProcessed(uid: string): boolean {
  const r = db().query("SELECT 1 FROM processed_emails WHERE uid=?").get(uid);
  return !!r;
}

function markProcessed(uid: string, messageId: string) {
  db().run(
    "INSERT OR REPLACE INTO processed_emails(uid,message_id,processed_at) VALUES(?,?,?)",
    [uid, messageId, new Date().toISOString()],
  );
}

/** One-shot poll: fetches unseen mail from INBOX, returns ones from the
 *  configured operator that we haven't seen before, and marks them processed.
 *  Mailbox flag is NOT changed — operators can keep using the inbox normally. */
export async function pollInbox(): Promise<InboundCommand[]> {
  requireMail();
  const c = new ImapFlow({
    host: config.mail.imapHost,
    port: config.mail.imapPort,
    secure: config.mail.imapPort === 993,
    auth: { user: config.mail.user, pass: config.mail.pass },
    logger: false,
  });

  const out: InboundCommand[] = [];
  try {
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      for await (const msg of c.fetch(
        { since, from: config.mail.operator },
        { uid: true, envelope: true, source: true },
      )) {
        const uid = String(msg.uid);
        if (alreadyProcessed(uid)) continue;
        const parsed = await simpleParser(msg.source!);
        out.push({
          uid,
          messageId: parsed.messageId ?? msg.envelope?.messageId ?? `uid:${uid}`,
          from:
            parsed.from?.value?.[0]?.address ??
            msg.envelope?.from?.[0]?.address ??
            "",
          subject: parsed.subject ?? msg.envelope?.subject ?? "",
          body: (parsed.text ?? "").trim(),
          receivedAt: (parsed.date ?? new Date()).toISOString(),
        });
        markProcessed(uid, parsed.messageId ?? `uid:${uid}`);
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    log.warn(`IMAP poll failed: ${(e as Error).message}`, { stage: "email" });
  } finally {
    try {
      await c.logout();
    } catch {
      /* ignore */
    }
  }
  return out;
}
