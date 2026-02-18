// Paste safety: detect potential secrets in clipboard content before pasting.

const SECRET_PATTERNS = [
  // AWS keys
  /AKIA[0-9A-Z]{16}/,
  // GitHub tokens
  /gh[ps]_[A-Za-z0-9_]{36,}/,
  // Generic API key patterns
  /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['""]?[A-Za-z0-9_\-]{20,}/i,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  // Private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  // Generic long hex strings (potential secrets)
  /(?:secret|password|token|key)\s*[:=]\s*['""]?[a-f0-9]{32,}/i,
  // npm tokens
  /npm_[A-Za-z0-9]{36,}/,
  // Slack tokens
  /xox[bpras]-[A-Za-z0-9\-]{10,}/,
];

export interface PasteSafetyResult {
  isSuspicious: boolean;
  reason: string | null;
}

export function checkPasteContent(text: string): PasteSafetyResult {
  // Only check multi-character pastes (not single chars)
  if (text.length < 10) {
    return { isSuspicious: false, reason: null };
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isSuspicious: true,
        reason: "This paste may contain a secret or API key.",
      };
    }
  }

  return { isSuspicious: false, reason: null };
}
