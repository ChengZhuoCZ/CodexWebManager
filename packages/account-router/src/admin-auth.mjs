import { createHash, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;
const REDACTED_AUTHENTICATOR = "[REDACTED AdminAuthenticator]";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createAdminAuthenticator({ token } = {}) {
  if (
    typeof token !== "string" ||
    token.length < 24 ||
    token.length > 4_096 ||
    !TOKEN_PATTERN.test(token)
  ) {
    throw new Error("admin token must be a 24 through 4096 character bearer value");
  }
  const expectedDigest = digest(token);

  return Object.freeze({
    authenticate(headers) {
      if (headers === null || typeof headers !== "object") {
        return false;
      }
      const authorization = headers.authorization;
      if (typeof authorization !== "string") {
        return false;
      }
      const match = BEARER_PATTERN.exec(authorization);
      if (!match) {
        return false;
      }
      const candidateDigest = digest(match[1]);
      return timingSafeEqual(expectedDigest, candidateDigest);
    },
    toString() {
      return REDACTED_AUTHENTICATOR;
    },
    toJSON() {
      return REDACTED_AUTHENTICATOR;
    },
    [inspect.custom]() {
      return REDACTED_AUTHENTICATOR;
    },
  });
}
