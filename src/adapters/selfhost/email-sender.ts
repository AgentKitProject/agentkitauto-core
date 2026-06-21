/**
 * SMTP-backed EmailSender (Phase D result delivery, selfhost adapter).
 *
 * Uses nodemailer to send via any SMTP relay. Config is read from env vars:
 *   SMTP_HOST   — SMTP server hostname (required to enable; unset = inert)
 *   SMTP_PORT   — SMTP port (default 587)
 *   SMTP_SECURE — "true" to use TLS from the start (SSL/465); default false
 *                 (STARTTLS on port 587)
 *   SMTP_USER   — auth username (optional; omit for unauthenticated relay)
 *   SMTP_PASS   — auth password (optional; omit for unauthenticated relay)
 *   SMTP_FROM   — the "From" address (required to enable; unset = inert)
 *
 * INERT WHEN UNCONFIGURED: if SMTP_HOST or SMTP_FROM is unset (or blank),
 * the returned sender is a no-op that returns `{ status: "skipped" }` and
 * logs once — so a self-hosted deployment without SMTP config NEVER breaks
 * a run (webhook delivery still works). It NEVER throws: an SMTP error is
 * caught and returned as `{ status: "failed", error }`.
 *
 * The nodemailer transport is injected via SmtpEmailSenderOptions.createTransport
 * so tests can substitute a fake transport without any real SMTP connection.
 */

import type { EmailSender, EmailSendResult, OutboundEmail } from "../../core/ports.js";

/** The subset of a nodemailer transport we actually use. */
export interface SmtpTransport {
  sendMail(options: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

/** The subset of nodemailer.createTransport we need (for injection in tests). */
export type CreateTransportFn = (options: {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}) => SmtpTransport;

export interface SmtpEmailSenderOptions {
  /**
   * Inject a fake createTransport in tests (offline). In production, leave
   * unset and the real nodemailer.createTransport is used (lazy-loaded).
   */
  createTransport?: CreateTransportFn;
}

/**
 * Builds the SMTP EmailSender. When SMTP_HOST or SMTP_FROM is missing the
 * returned sender is inert (skips every send with status "skipped") so an
 * unconfigured self-hosted deployment never breaks a run.
 */
export function makeSmtpEmailSender(
  options: SmtpEmailSenderOptions = {},
  env: Record<string, string | undefined> = process.env,
): EmailSender {
  const host = (env["SMTP_HOST"] ?? "").trim();
  const from = (env["SMTP_FROM"] ?? "").trim();

  if (host === "" || from === "") {
    let warned = false;
    return {
      async sendEmail(): Promise<EmailSendResult> {
        if (!warned) {
          warned = true;
          console.warn(
            "[auto-core] SMTP_HOST/SMTP_FROM not configured — email delivery is a no-op. " +
              "Set SMTP_HOST and SMTP_FROM to enable SMTP delivery.",
          );
        }
        return {
          status: "skipped",
          error: "SMTP_HOST/SMTP_FROM is not configured.",
        };
      },
    };
  }

  const port = (() => {
    const raw = env["SMTP_PORT"];
    if (!raw || raw.trim() === "") return 587;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? 587 : n;
  })();

  const secure = (env["SMTP_SECURE"] ?? "").trim().toLowerCase() === "true";

  const user = (env["SMTP_USER"] ?? "").trim();
  const pass = (env["SMTP_PASS"] ?? "").trim();
  const auth = user !== "" && pass !== "" ? { user, pass } : undefined;

  // Build or reuse the transport. We lazily construct on first sendEmail to
  // avoid importing nodemailer at module-load time (keeps tests fast).
  let transport: SmtpTransport | undefined;

  return {
    async sendEmail(email: OutboundEmail): Promise<EmailSendResult> {
      try {
        if (!transport) {
          const createTransport =
            options.createTransport ??
            // Dynamic import so nodemailer is only loaded in the selfhost path.
            (await import("nodemailer")).default.createTransport;

          transport = (createTransport as CreateTransportFn)({
            host,
            port,
            secure,
            ...(auth ? { auth } : {}),
          });
        }

        await transport.sendMail({
          from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        });

        return { status: "delivered" };
      } catch (err) {
        // Best-effort: never throw — delivery failure must not affect the run.
        return {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * @deprecated Use makeSmtpEmailSender instead. Kept for backward compatibility
 * with any code that called the old no-op factory; now delegates to
 * makeSmtpEmailSender so env-configured deployments pick up SMTP automatically.
 */
export function makeSelfHostEmailSender(): EmailSender {
  return makeSmtpEmailSender();
}
