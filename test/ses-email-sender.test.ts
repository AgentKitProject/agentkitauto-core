/**
 * SES EmailSender (aws adapter). Offline: the SES client is faked.
 *
 * Asserts:
 *   - SES_SENDER unset → inert no-op (status "skipped"), client never called;
 *   - SES_SENDER set → SendEmailCommand with the right From / To / Subject /
 *     Body, status "delivered";
 *   - an SES API error is caught (status "failed"), never thrown.
 */

import { describe, expect, it } from "vitest";
import { makeSesEmailSender } from "../src/adapters/aws/ses-email-sender.js";

/** A fake SES client that records the command input it was sent. */
function fakeSes(throwErr?: Error) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      async send(command: { input: unknown }) {
        if (throwErr) throw throwErr;
        sent.push(command.input);
        return {};
      },
    } as { send: (c: { input: unknown }) => Promise<unknown> },
  };
}

describe("makeSesEmailSender", () => {
  it("is an inert no-op when SES_SENDER is unset", async () => {
    const { client, sent } = fakeSes();
    const sender = makeSesEmailSender({ client: client as never }, {});
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("skipped");
    expect(out.error).toMatch(/SES_SENDER/);
    expect(sent).toHaveLength(0);
  });

  it("sends via SES with the right From/To/Subject/Body when configured", async () => {
    const { client, sent } = fakeSes();
    const sender = makeSesEmailSender({ client: client as never }, { SES_SENDER: "noreply@auto.example.com" });
    const out = await sender.sendEmail({
      to: ["x@example.com", "y@example.com"],
      subject: "[AgentKitAuto] kit run succeeded",
      text: "body text",
    });
    expect(out.status).toBe("delivered");
    expect(sent).toHaveLength(1);
    const input = sent[0] as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } };
    };
    expect(input.FromEmailAddress).toBe("noreply@auto.example.com");
    expect(input.Destination.ToAddresses).toEqual(["x@example.com", "y@example.com"]);
    expect(input.Content.Simple.Subject.Data).toBe("[AgentKitAuto] kit run succeeded");
    expect(input.Content.Simple.Body.Text.Data).toBe("body text");
  });

  it("explicit sender option overrides env", async () => {
    const { client, sent } = fakeSes();
    const sender = makeSesEmailSender({ client: client as never, sender: "opt@example.com" }, { SES_SENDER: "env@example.com" });
    await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect((sent[0] as { FromEmailAddress: string }).FromEmailAddress).toBe("opt@example.com");
  });

  it("catches an SES API error (status 'failed'), never throws", async () => {
    const { client } = fakeSes(new Error("Throttling: rate exceeded"));
    const sender = makeSesEmailSender({ client: client as never }, { SES_SENDER: "noreply@auto.example.com" });
    const out = await sender.sendEmail({ to: ["a@example.com"], subject: "s", text: "t" });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/Throttling/);
  });
});
