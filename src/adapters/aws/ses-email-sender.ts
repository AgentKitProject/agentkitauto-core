/**
 * SES-backed EmailSender (Phase D result delivery, aws adapter).
 *
 * Uses SES v2 `SendEmailCommand`. The sender ("From") identity is read from the
 * env var `SES_SENDER` (a SES-verified identity / verified domain).
 *
 * INERT WHEN UNCONFIGURED: if `SES_SENDER` is unset (or blank), this sender is a
 * no-op that returns `{ status: "skipped" }` with a clear note and logs once —
 * so a deployment without SES configured NEVER breaks a run (delivery is
 * best-effort). It NEVER throws: an SES API error is caught and returned as
 * `{ status: "failed", error }`.
 *
 * NOTE (ops, not code): SES requires a VERIFIED sender identity, and to email
 * arbitrary recipients the account must be out of the SES sandbox (production
 * access). Both are infra/ops steps, configured outside this package.
 */

import {
  SESv2Client,
  SendEmailCommand,
  type SESv2ClientConfig,
} from "@aws-sdk/client-sesv2";
import type { EmailSender, EmailSendResult, OutboundEmail } from "../../core/ports.js";

export interface SesEmailSenderOptions {
  /** The verified "From" identity. Defaults to env `SES_SENDER`. */
  sender?: string;
  /** A preconstructed SES client (tests inject a fake). */
  client?: Pick<SESv2Client, "send">;
  /** Client config when no client is supplied (region/creds). */
  clientConfig?: SESv2ClientConfig;
}

/**
 * Builds the SES EmailSender. When no sender identity is resolvable the returned
 * sender is inert (skips every send) rather than failing the run.
 */
export function makeSesEmailSender(
  options: SesEmailSenderOptions = {},
  env: Record<string, string | undefined> = process.env,
): EmailSender {
  const sender = (options.sender ?? env["SES_SENDER"] ?? "").trim();

  if (sender === "") {
    let warned = false;
    return {
      async sendEmail(): Promise<EmailSendResult> {
        if (!warned) {
          warned = true;
          console.warn(
            "[auto-core] SES_SENDER is unset — email delivery is a no-op. Set a verified SES_SENDER identity to enable it.",
          );
        }
        return { status: "skipped", error: "SES_SENDER is not configured." };
      },
    };
  }

  const client = options.client ?? new SESv2Client(options.clientConfig ?? {});

  return {
    async sendEmail(email: OutboundEmail): Promise<EmailSendResult> {
      try {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: sender,
            Destination: { ToAddresses: email.to },
            Content: {
              Simple: {
                Subject: { Data: email.subject, Charset: "UTF-8" },
                Body: {
                  Text: { Data: email.text, Charset: "UTF-8" },
                  ...(email.html
                    ? { Html: { Data: email.html, Charset: "UTF-8" } }
                    : {}),
                },
              },
            },
          }),
        );
        return { status: "delivered" };
      } catch (err) {
        // Best-effort: never throw — a delivery failure must not affect the run.
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
