/**
 * SMTP EmailSender (selfhost adapter). Offline: the nodemailer transport is faked
 * via the injected createTransport option — no real SMTP connection is made.
 *
 * Asserts:
 *   - SMTP_HOST or SMTP_FROM unset → inert no-op (status "skipped"), transport
 *     never created;
 *   - both configured → sendMail called with the right from/to/subject/text;
 *   - HTML body forwarded when provided;
 *   - SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS wired into transport opts;
 *   - an SMTP error is caught (status "failed"), never thrown;
 *   - makeSelfHostEmailSender (legacy re-export) still delegates to SMTP logic.
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeSmtpEmailSender,
  makeSelfHostEmailSender,
  type SmtpTransport,
} from "../src/adapters/selfhost/email-sender.js";

// ---------------------------------------------------------------------------
// Fake transport factory
// ---------------------------------------------------------------------------

type SendMailArgs = Parameters<SmtpTransport["sendMail"]>[0];

function fakeTransport(throwErr?: Error) {
  const sent: SendMailArgs[] = [];
  const transport: SmtpTransport = {
    async sendMail(opts) {
      if (throwErr) throw throwErr;
      sent.push(opts);
    },
  };
  return { sent, transport };
}

type TransportOpts = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
};

function fakeCreateTransport(throwErr?: Error) {
  const calls: TransportOpts[] = [];
  const { sent, transport } = fakeTransport(throwErr);
  const createTransport = (opts: TransportOpts): SmtpTransport => {
    calls.push(opts);
    return transport;
  };
  return { calls, sent, createTransport };
}

// ---------------------------------------------------------------------------
// Inert when unconfigured
// ---------------------------------------------------------------------------

describe("makeSmtpEmailSender — inert when unconfigured", () => {
  it("is a no-op when SMTP_HOST is missing", async () => {
    const { createTransport, calls } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, { SMTP_FROM: "noreply@example.com" });
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("skipped");
    expect(out.error).toMatch(/SMTP_HOST/);
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when SMTP_FROM is missing", async () => {
    const { createTransport, calls } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, { SMTP_HOST: "smtp.example.com" });
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("skipped");
    expect(out.error).toMatch(/SMTP_FROM/);
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when both SMTP_HOST and SMTP_FROM are missing", async () => {
    const { createTransport } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, {});
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("skipped");
  });

  it("logs a warning once, not on every call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sender = makeSmtpEmailSender({}, {});
    await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    await sender.sendEmail({ to: ["b@example.com"], subject: "s2", text: "t2" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Successful delivery
// ---------------------------------------------------------------------------

const CONFIGURED_ENV = {
  SMTP_HOST: "smtp.example.com",
  SMTP_FROM: "auto@example.com",
};

describe("makeSmtpEmailSender — successful delivery", () => {
  it("calls sendMail with the right from/to/subject/text", async () => {
    const { createTransport, sent } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, CONFIGURED_ENV);
    const out = await sender.sendEmail({
      to: ["x@example.com", "y@example.com"],
      subject: "[AgentKitAuto] run succeeded",
      text: "plain body",
    });
    expect(out.status).toBe("delivered");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe("auto@example.com");
    expect(sent[0]!.to).toEqual(["x@example.com", "y@example.com"]);
    expect(sent[0]!.subject).toBe("[AgentKitAuto] run succeeded");
    expect(sent[0]!.text).toBe("plain body");
    expect(sent[0]!.html).toBeUndefined();
  });

  it("forwards the HTML body when provided", async () => {
    const { createTransport, sent } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, CONFIGURED_ENV);
    await sender.sendEmail({
      to: ["a@example.com"],
      subject: "s",
      text: "t",
      html: "<b>bold</b>",
    });
    expect(sent[0]!.html).toBe("<b>bold</b>");
  });

  it("reuses the same transport across multiple sends", async () => {
    const { createTransport, calls, sent } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, CONFIGURED_ENV);
    await sender.sendEmail({ to: ["a@example.com"], subject: "s1", text: "t1" });
    await sender.sendEmail({ to: ["b@example.com"], subject: "s2", text: "t2" });
    // createTransport called once, sendMail called twice
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Transport options (port / secure / auth)
// ---------------------------------------------------------------------------

describe("makeSmtpEmailSender — transport options", () => {
  it("defaults to port 587, secure=false, no auth", async () => {
    const { createTransport, calls } = fakeCreateTransport();
    const sender = makeSmtpEmailSender({ createTransport }, CONFIGURED_ENV);
    await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(calls[0]!.port).toBe(587);
    expect(calls[0]!.secure).toBe(false);
    expect(calls[0]!.auth).toBeUndefined();
  });

  it("reads SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS from env", async () => {
    const { createTransport, calls } = fakeCreateTransport();
    const sender = makeSmtpEmailSender(
      { createTransport },
      {
        ...CONFIGURED_ENV,
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "user@example.com",
        SMTP_PASS: "secret",
      },
    );
    await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(calls[0]!.port).toBe(465);
    expect(calls[0]!.secure).toBe(true);
    expect(calls[0]!.auth).toEqual({ user: "user@example.com", pass: "secret" });
  });

  it("omits auth when only one of SMTP_USER/SMTP_PASS is set", async () => {
    const { createTransport, calls } = fakeCreateTransport();
    const sender = makeSmtpEmailSender(
      { createTransport },
      { ...CONFIGURED_ENV, SMTP_USER: "only-user" },
    );
    await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(calls[0]!.auth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling — never throw
// ---------------------------------------------------------------------------

describe("makeSmtpEmailSender — error handling", () => {
  it("catches an SMTP error (status 'failed'), never throws", async () => {
    const { createTransport } = fakeCreateTransport(new Error("Connection refused"));
    const sender = makeSmtpEmailSender({ createTransport }, CONFIGURED_ENV);
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/Connection refused/);
  });

  it("does not throw on a non-Error rejection", async () => {
    const { sent, transport } = fakeTransport();
    const throwingTransport: SmtpTransport = {
      async sendMail() {
        throw "string error";
      },
    };
    const createTransport = () => throwingTransport;
    const sender = makeSmtpEmailSender(
      { createTransport: createTransport as never },
      CONFIGURED_ENV,
    );
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("string error");
    // unused — suppress linter
    void sent;
    void transport;
  });
});

// ---------------------------------------------------------------------------
// makeSelfHostEmailSender backward-compat shim
// ---------------------------------------------------------------------------

describe("makeSelfHostEmailSender (legacy shim)", () => {
  it("is inert when SMTP vars are absent (process.env has no SMTP_HOST)", async () => {
    // Remove SMTP vars from process.env for this call so the shim is inert.
    const orig = { SMTP_HOST: process.env["SMTP_HOST"], SMTP_FROM: process.env["SMTP_FROM"] };
    delete process.env["SMTP_HOST"];
    delete process.env["SMTP_FROM"];
    try {
      const sender = makeSelfHostEmailSender();
      const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
      expect(out.status).toBe("skipped");
    } finally {
      if (orig.SMTP_HOST !== undefined) process.env["SMTP_HOST"] = orig.SMTP_HOST;
      if (orig.SMTP_FROM !== undefined) process.env["SMTP_FROM"] = orig.SMTP_FROM;
    }
  });
});
