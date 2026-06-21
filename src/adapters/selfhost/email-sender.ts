/**
 * Self-host EmailSender (Phase D result delivery, selfhost adapter).
 *
 * A NO-OP for now: self-hosted SMTP wiring is deferred (TODO: a nodemailer /
 * SMTP-backed sender configured from env). It returns `{ status: "skipped" }`
 * with a note so a self-hosted deployment can still use WEBHOOK delivery (which
 * is provider-agnostic, global fetch in core) without email breaking a run.
 */

import type { EmailSender, EmailSendResult } from "../../core/ports.js";

/** Builds the inert self-host EmailSender (webhook delivery is unaffected). */
export function makeSelfHostEmailSender(): EmailSender {
  let warned = false;
  return {
    async sendEmail(): Promise<EmailSendResult> {
      if (!warned) {
        warned = true;
        console.warn(
          "[auto-core] self-host EmailSender is a no-op (SMTP not yet wired). Webhook delivery still works.",
        );
      }
      return { status: "skipped", error: "Self-host email delivery is not configured (SMTP not wired)." };
    },
  };
}
