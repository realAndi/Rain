import { describe, it, expect } from "vitest";
import { checkPasteContent } from "../pasteSafety";

const fake = (prefix: string, body: string) => `${prefix}${body}`;

describe("checkPasteContent", () => {
  it("allows short pastes", () => {
    expect(checkPasteContent("hello")).toEqual({ isSuspicious: false, reason: null });
    expect(checkPasteContent("abc")).toEqual({ isSuspicious: false, reason: null });
  });

  it("allows normal text", () => {
    expect(checkPasteContent("npm install express body-parser cors")).toEqual({
      isSuspicious: false,
      reason: null,
    });
  });

  it("detects AWS access keys", () => {
    const result = checkPasteContent(
      `export AWS_ACCESS_KEY_ID=${fake("AKIA", "IOSFODNN7EXAMPLE")}`
    );
    expect(result.isSuspicious).toBe(true);
  });

  it("detects GitHub tokens (ghp_)", () => {
    const result = checkPasteContent(
      `git clone https://${fake("ghp_", "ABCDEFghijklmnopqrstuvwxyz0123456789")}@github.com/repo.git`
    );
    expect(result.isSuspicious).toBe(true);
  });

  it("detects GitHub tokens (ghs_)", () => {
    const result = checkPasteContent(
      `GITHUB_TOKEN=${fake("ghs_", "ABCDEFghijklmnopqrstuvwxyz0123456789")}`
    );
    expect(result.isSuspicious).toBe(true);
  });

  it("detects Bearer tokens", () => {
    const result = checkPasteContent(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw"
    );
    expect(result.isSuspicious).toBe(true);
  });

  it("detects private keys", () => {
    const result = checkPasteContent("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...");
    expect(result.isSuspicious).toBe(true);
  });

  it("detects npm tokens", () => {
    const result = checkPasteContent(
      `//registry.npmjs.org/:_authToken=${fake("npm_", "ABCDEFghijklmnopqrstuvwxyz0123456789")}`
    );
    expect(result.isSuspicious).toBe(true);
  });

  it("detects Slack tokens", () => {
    const result = checkPasteContent(
      `SLACK_TOKEN=${fake("xoxb-", "1234567890-abcdefghij")}`
    );
    expect(result.isSuspicious).toBe(true);
  });

  it("detects generic api_key patterns", () => {
    const result = checkPasteContent(
      'config.api_key = "abcdef1234567890abcdef1234567890"'
    );
    expect(result.isSuspicious).toBe(true);
  });
});
