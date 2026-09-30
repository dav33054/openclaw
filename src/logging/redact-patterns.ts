import {
  HTTP_AUTH_HEADER_BOUNDARY_PATTERN,
  HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN,
  HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN,
  HTTP_AUTH_SCHEME_PATTERN,
  HTTP_AUTH_SERIALIZED_QUOTE_PATTERN,
} from "../../packages/acp-core/src/structured-auth-redaction.js";
import type {
  RedactMatch,
  RedactPattern,
  ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";
import { PEM_REDACT_PATTERN_SOURCE } from "./redact-pem.js";

export const PAYMENT_CREDENTIAL_ENV_KEYS = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`;
export const PAYMENT_CREDENTIAL_QUERY_KEYS = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`;
export const PAYMENT_CREDENTIAL_JSON_KEYS = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`;
export const AWS_SECRET_ACCESS_KEY_FIELD_KEYS = String.raw`aws[-_]?secret[-_]?access[-_]?key|awsSecretAccessKey|SecretAccessKey`;
const AUTH_QUERY_KEYS = String.raw`access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|client[-_]?secret|app[-_]?secret|private[-_]?key|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|token|key|secret|password|pass|passwd|auth|jwt|session|code|signature|x[-_]?amz[-_]?(?:signature|security[-_]?token)`;
const FORM_BODY_FIRST_PAIR_KEYS = String.raw`${AUTH_QUERY_KEYS}|app[-_]?secret|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const STANDALONE_ASSIGNMENT_SECRET_KEYS = String.raw`access_token|refresh_token|id_token|auth[-_]?token|hook[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|private[-_]?key|authorization|jwt|token|secret|password|pass|passwd|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const CONFIG_ASSIGNMENT_SECRET_KEYS = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
// Bare `pass` is ordinary prose far more often than a key ("tests now pass: older clients"), so the
// generic unquoted colon form skips it; BARE_PASS_ASSIGNMENT_MATCHER keeps config-shaped `pass:` masked, and
// `pass=`, `pass = `, namespaced, prefixed, and quoted forms are unchanged.
const CONFIG_COLON_ASSIGNMENT_SECRET_KEYS = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|passwd|credential|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const CONFIG_DIRECT_ASSIGNMENT_SECRET_KEYS = String.raw`access-token|refresh-token|id-token|auth-token|hook-token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|passphrase`;
const CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS = String.raw`password|passphrase|pass|passwd`;
const CLI_SECRET_FLAG_KEYS = String.raw`${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|api[-_]?key|hook[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|private[-_]?key|client[-_]?secret|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;

export const BODY_SECRET_KEYS = new Set([
  "access_token",
  "auth_token",
  "awssecretaccesskey",
  "aws_secret_access_key",
  "hook_token",
  "refresh_token",
  "id_token",
  "token",
  "api_key",
  "apikey",
  "client_secret",
  "app_secret",
  "password",
  "pass",
  "passwd",
  "auth",
  "jwt",
  "session",
  "code",
  "signature",
  "x_amz_signature",
  "x_amz_security_token",
  "secret",
  "secretaccesskey",
  "credential",
  "private_key",
  "authorization",
  "key",
  "card_number",
  "card_cvc",
  "card_cvv",
  "cvc",
  "cvv",
  "security_code",
  "payment_credential",
  "shared_payment_token",
]);

export const FORM_BODY_KEY_INVISIBLE_CHARS = String.raw`\p{C}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0`;
const ENV_ASSIGNMENT_REDACT_PATTERN = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`;
const ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g`;
// Quoted values may contain the other quote characters; only the matching closing quote ends
// the value. The unquoted variant accepts one leading quote so unterminated values still mask.
const STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN = String.raw`(^|[\s,;({\["])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60])((?:(?!\2)[^\r\n])+)\2`;
const STANDALONE_ASSIGNMENT_REDACT_PATTERN = String.raw`(^|[\s,;({\["])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60]?[^\s&#"'\x60<>]+)`;
const CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS}`;
const CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])(?:(?:${CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS})(?:\s*:\s*|\s+=\s*|=\s*)|[a-z0-9][a-z0-9._-]{0,79}[-_](?:${CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*|[a-z0-9_.-]{1,80}\.(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*)(["'\x60])((?:(?!\2)[^\r\n])+)\2/g`;
const CONFIG_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])(?:(?:${CONFIG_COLON_ASSIGNMENT_SECRET_KEYS})\s*:\s*|(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})(?:\s+=\s*|=\s+))([^\s#"'\x60<>]+)/g`;
const CONFIG_DIRECT_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])(?:${CONFIG_DIRECT_ASSIGNMENT_SECRET_KEYS})=([^\s#"'\x60<>]+)/g`;
const CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])[a-z0-9][a-z0-9._-]{0,79}[-_](?:${CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*([^\s#"'\x60<>]+)/g`;
const CONFIG_NAMESPACED_ASSIGNMENT_REDACT_PATTERN = String.raw`/(^|[\s,{])[a-z0-9_.-]{1,80}\.(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*([^\s#"'\x60<>]+)/g`;
const STRUCTURED_JSON_SECRET_REDACT_PATTERN = String.raw`"(?:apiKey|api_key|apiToken|api_token|bearerToken|bearer_token|token|secret|password|passwd|${AWS_SECRET_ACCESS_KEY_FIELD_KEYS}|credential|authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|authToken|auth_token|clientSecret|client_secret|privateKey|private_key|secret_value|raw_secret|secret_input|key_material)"\s*:\s*"([^"]+)"`;
const STRUCTURED_JSON_PAYMENT_REDACT_PATTERN = String.raw`"(?:${PAYMENT_CREDENTIAL_JSON_KEYS})"\s*:\s*"([^"]+)"`;
const AMBIGUOUS_QUOTED_SECRET_FIELD_REDACT_PATTERN = String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|id[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret|private[-_]key|credential|authorization|secret[-_]value|raw[-_]secret|secret[-_]input|key[-_]material)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`;
const AMBIGUOUS_QUOTED_AUTH_FIELD_REDACT_PATTERN = String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`;
// Pure-base64 prefixes require a non-alphanumeric boundary and skip explicit data-URL payloads.
export const BASE64_SAFE_TOKEN_BOUNDARY = String.raw`(^|[^A-Za-z0-9])(?<!;base64,[A-Za-z0-9+/=]*)`;
export const IDENTIFIER_SAFE_TOKEN_BOUNDARY = String.raw`(^|[^A-Za-z0-9_])`;

function isAwsValueCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    char === "/" ||
    char === "+" ||
    char === "="
  );
}

const AWS_SECRET_ACCESS_KEY_VALUE_RE =
  /(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[0-9/+=])(?=[A-Za-z0-9/+=]{0,39}[G-Zg-z/+=])[A-Za-z0-9/+=]{40}/u;
const AWS_SECRET_ACCESS_KEY_RUN_RE = /[A-Za-z0-9/+=]{40}/u;

function couldMatchAwsSecretAccessKey(text: string): boolean {
  // Reject short word runs before the value rule retries its lookaheads at every character.
  return (
    text.length >= 40 &&
    AWS_SECRET_ACCESS_KEY_RUN_RE.test(text) &&
    AWS_SECRET_ACCESS_KEY_VALUE_RE.test(text)
  );
}

const AWS_VALUE_WHITESPACE_RE = /\s/;
const AWS_URL_SCHEME_CHARACTER_RE = /[A-Za-z0-9+.-]/;
const AWS_URL_SCHEME_START_RE = /[A-Za-z]/;

function* matchAwsSecretAccessKeys(text: string): Iterable<RedactMatch> {
  if (!couldMatchAwsSecretAccessKey(text)) {
    return;
  }
  type UrlContext = {
    start: number;
    end: number;
    authorityEnd: number;
    portStart: number;
    portValid: boolean;
    hasAt: boolean;
    queryOrFragment: boolean;
    closing: string | undefined;
    closingEscapeDepth: number;
  };
  const closingDelimiters: Readonly<Record<string, string>> = {
    '"': '"',
    "'": "'",
    "`": "`",
    "<": ">",
    "(": ")",
    "[": "]",
    "{": "}",
  };
  let runStart = -1;
  let schemeStart = -1;
  let url: UrlContext | undefined;
  let backslashes = 0;
  const runs: Array<{ start: number; end: number; origin: number; url: UrlContext | undefined }> =
    [];
  for (let index = 0; index <= text.length; index++) {
    const char = text[index] ?? "";
    const whitespace = index === text.length || AWS_VALUE_WHITESPACE_RE.test(char);
    const escapeDepth = backslashes;
    backslashes = char === "\\" ? backslashes + 1 : 0;
    if (char && isAwsValueCharacter(char)) {
      if (runStart === -1) {
        runStart = index;
      }
    } else if (runStart !== -1) {
      if (index - runStart === 40) {
        runs.push({ start: runStart, end: index, origin: runStart, url });
      } else if (index - runStart > 40 && char === "@" && text[index - 41] === "/") {
        runs.push({ start: index - 40, end: index, origin: runStart, url });
      }
      runStart = -1;
    }
    if (whitespace) {
      if (url) {
        url.end = Math.min(url.end, index);
      }
      for (const run of runs) {
        const context = run.url;
        const publicUrl =
          context &&
          !context.hasAt &&
          context.portValid &&
          (context.portStart === -1 ||
            (context.authorityEnd === -1 ? context.end : context.authorityEnd) >
              context.portStart + 1);
        const before = text[run.start - 1] ?? "";
        const after = text[run.end] ?? "";
        const slashCredential = run.start !== run.origin;
        // Preserve the existing malformed credential spanning a numeric port and path.
        // Its terminal @ qualifies that whole run, not userinfo in the URL's path.
        const portCredential =
          context &&
          context.portStart !== -1 &&
          run.origin === context.portStart + 1 &&
          context.authorityEnd > run.origin &&
          run.end > context.authorityEnd &&
          after === "@";
        if (
          (!slashCredential && (before === "_" || isAwsValueCharacter(before))) ||
          after === "_" ||
          text.slice(run.origin - 8, run.origin) === ";base64," ||
          (publicUrl && !portCredential && run.start >= context.start && run.end <= context.end)
        ) {
          continue;
        }
        const match = text.slice(run.start, run.end);
        if (AWS_SECRET_ACCESS_KEY_VALUE_RE.test(match)) {
          yield { match, groups: [match], input: text, offset: run.start };
        }
      }
      runs.length = 0;
      schemeStart = -1;
      url = undefined;
      continue;
    }
    if (url && index >= url.start) {
      // A quoted/marked value ends independently of punctuation inside raw userinfo.
      if (char === url.closing && escapeDepth === url.closingEscapeDepth) {
        url.end = Math.min(url.end, index);
        url = undefined;
      } else {
        if ("?#\"'<>`|()[]{}".includes(char)) {
          url.end = Math.min(url.end, index);
        }
        url.queryOrFragment ||= char === "?" || char === "#";
        if (url.authorityEnd === -1) {
          url.hasAt ||= char === "@";
          if ("/?#".includes(char)) {
            url.authorityEnd = index;
          } else if (index < url.end) {
            if (char === ":") {
              url.portValid &&= url.portStart === -1;
              url.portStart = index;
            } else if (url.portStart !== -1 && (char < "0" || char > "9")) {
              url.portValid = false;
            }
          }
        }
      }
    }
    if (AWS_URL_SCHEME_CHARACTER_RE.test(char)) {
      if (schemeStart === -1) {
        schemeStart = index;
      }
    } else {
      if (
        (!url || (index >= url.end && !url.queryOrFragment)) &&
        char === ":" &&
        text.startsWith("//", index + 1) &&
        schemeStart !== -1 &&
        AWS_URL_SCHEME_START_RE.test(text[schemeStart]!)
      ) {
        const opening = text[schemeStart - 1];
        let closingEscapeDepth = 0;
        for (let offset = schemeStart - 2; offset >= 0 && text[offset] === "\\"; offset--) {
          closingEscapeDepth++;
        }
        url = {
          start: index + 3,
          end: text.length,
          authorityEnd: -1,
          portStart: -1,
          portValid: true,
          hasAt: false,
          queryOrFragment: false,
          closing: opening ? closingDelimiters[opening] : undefined,
          closingEscapeDepth,
        };
      }
      schemeStart = -1;
    }
  }
}

export const AWS_SECRET_ACCESS_KEY_MATCHER = Object.freeze({
  source: "aws-secret-access-key",
  exec: matchAwsSecretAccessKeys,
  couldMatch: couldMatchAwsSecretAccessKey,
});

// Bare `pass:` reads as prose only when a plain word or number and one space precede it on a line that
// carries no assignment before it ("The tests now pass: older clients", "12 pass: 0 fail"). A spaced
// `key: value` phrase earlier on the line is how prose introduces lists ("Release notes: all suites
// pass: nothing else changed"), so it is not an assignment; an inline `user: bot pass: x` record is the
// accepted cost, while `user=bot pass: x` and `user:bot pass: x` stay records. Every other
// position is a record start and masks exactly like the generic assignment rule did: line or text start,
// YAML `- `, punctuation, tabs, or an inline `key=value` / `key:value` field of any spacing or length.
// Namespaced (`smtp.pass:`) and prefixed (`db-pass:`, `db_pass:`) keys belong to their own patterns but
// still make their line a record, as does any other credential key with a colon in any letter case
// (`password: x pass: y`, `Authorization: Bearer x pass: y`);
// `pass` inside another word (`bypass:`) is not a key. Whitespace around
// the colon may include line breaks, as in the generic rule, so YAML explicit keys and indented
// continuations stay covered. One forward pass classifies every key, so the cost is linear in the text
// regardless of line length or key count.
const BARE_PASS_KEY_PATTERN = String.raw`(?<![A-Za-z0-9])(pass|${CONFIG_COLON_ASSIGNMENT_SECRET_KEYS})\s*:\s*`;
const BARE_PASS_VALUE_PATTERN = String.raw`[^\s#"'\x60<>]+`;
const ASCII_WORD_CHAR_RE = /[A-Za-z0-9]/;
const INLINE_WHITESPACE_RE = /[ \t\r\n]/;

function* matchBarePassAssignments(text: string): Iterable<RedactMatch> {
  const keys = [...text.matchAll(new RegExp(BARE_PASS_KEY_PATTERN, "gi"))];
  if (keys.length === 0) {
    return;
  }
  const valueRe = new RegExp(BARE_PASS_VALUE_PATTERN, "y");
  let next = 0;
  let assignmentSeen = false;
  for (let index = 0; index < text.length; index++) {
    const key = keys[next];
    if (!key) {
      return;
    }
    if (index === key.index) {
      next++;
      const before = text[index - 1] ?? "";
      const owned = key[1] !== "pass" || before === "." || before === "-" || before === "_";
      const prose =
        !owned &&
        !assignmentSeen &&
        before === " " &&
        ASCII_WORD_CHAR_RE.test(text[index - 2] ?? "");
      if (!prose) {
        // A key, this rule's or a namespaced one's, makes the rest of its value's line a record, so a
        // second `pass:` masks too. Skip the key so a line break after its colon does not reset that.
        assignmentSeen = true;
        let end = index + key[0].length;
        if (!owned) {
          valueRe.lastIndex = end;
          const value = valueRe.exec(text)?.[0];
          if (value) {
            end += value.length;
            yield { match: text.slice(index, end), groups: [value], input: text, offset: index };
          }
        }
        // Keys inside the skipped span were consumed as value text.
        let following = keys[next];
        while (following && following.index < end) {
          next++;
          following = keys[next];
        }
        index = end - 1;
        continue;
      }
    }
    const char = text[index];
    if (char === "\n" || char === "\r") {
      assignmentSeen = false;
    } else if (char === "=") {
      assignmentSeen = true;
    } else if (char === ":" && !INLINE_WHITESPACE_RE.test(text[index + 1] ?? " ")) {
      assignmentSeen = true;
    }
  }
}

const BARE_PASS_ASSIGNMENT_MATCHER = Object.freeze({
  source: "bare-pass-assignment",
  exec: matchBarePassAssignments,
});
/*
 * Linear matchers for default rules whose regex cost is quadratic in long character runs,
 * or whose unbounded repeats overflow the backtrack stack on multi-megabyte values. Each
 * matcher yields exactly the matches its source regex yields, in the same order and with
 * the same capture shape, while reading every character region a bounded number of times.
 *
 * All matcher state lives inside one exec() call, so nested redaction calls never share it.
 */

const JS_WHITESPACE_CODES = new Set([
  9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279,
]);

function isJsWhitespaceAt(text: string, index: number): boolean {
  if (index >= text.length) {
    return false;
  }
  const code = text.charCodeAt(index);
  return JS_WHITESPACE_CODES.has(code) || (code >= 0x2000 && code <= 0x200a);
}

function isJsWhitespaceChar(char: string | undefined): boolean {
  return char !== undefined && isJsWhitespaceAt(char, 0);
}

function isAlnumChar(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWordChar(char: string | undefined): boolean {
  return char === "_" || isAlnumChar(char);
}

function isHexChar(char: string | undefined): boolean {
  if (char === undefined) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isDigitChar(char: string | undefined): boolean {
  return char !== undefined && char.charCodeAt(0) >= 48 && char.charCodeAt(0) <= 57;
}

function isBase64UrlChar(char: string | undefined): boolean {
  return isAlnumChar(char) || char === "+" || char === "/" || char === "=";
}

/** Case-insensitive prefix occurrence scan; each rule compiles its own stateful regex per call. */
function* scanPrefixOccurrences(text: string, prefix: string): Generator<number> {
  const re = new RegExp(prefix, "gi");
  re.lastIndex = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    yield match.index;
  }
}

/** The `;base64,` exemption under the shared case-insensitive compilation of these rules. */
function isDataUrlPrefix(text: string, runStart: number): boolean {
  return runStart >= 8 && text.slice(runStart - 8, runStart).toLowerCase() === ";base64,";
}

type Base64SafeTokenEnd = (text: string, start: number) => number | null;

/** End of the maximal run of `isMember` characters starting at `start`. */
function runEndOf(
  text: string,
  start: number,
  isMember: (char: string | undefined) => boolean,
): number {
  let end = start;
  while (end < text.length && isMember(text[end])) {
    end += 1;
  }
  return end;
}

/**
 * Shared matcher for the `BASE64_SAFE_TOKEN_BOUNDARY` vendor rules. The boundary group is
 * checked per candidate in O(1); the `(?<!;base64,[A-Za-z0-9+/=]*)` exemption walks each
 * base64 run once because candidates advance left to right and share runs, replacing the
 * unbounded lookbehind that rescanned the whole run from every candidate. The token-end
 * function is created per exec() call so concurrent redactions never share scanner state.
 */
function makeBase64SafeTokenMatcher(
  source: string,
  prefix: string,
  makeTokenEnd: () => Base64SafeTokenEnd,
) {
  function* exec(text: string): Iterable<RedactMatch> {
    const tokenEnd = makeTokenEnd();
    // Maximal [A-Za-z0-9+/=] run ending at the latest candidate's boundary position.
    let runStart = -1;
    let runEnd = -1;
    let searchFloor = 0;
    for (const candidate of scanPrefixOccurrences(text, prefix)) {
      if (candidate < searchFloor) {
        continue;
      }
      if (candidate > 0 && isAlnumChar(text[candidate - 1])) {
        continue;
      }
      if (candidate > 0) {
        let runAtCandidate: number;
        if (isBase64UrlChar(text[candidate - 1])) {
          if (candidate - 1 >= runStart && candidate - 1 < runEnd) {
            runAtCandidate = runStart;
          } else {
            let walk = candidate - 1;
            while (walk > 0 && isBase64UrlChar(text[walk - 1])) {
              walk -= 1;
            }
            runStart = walk;
            runEnd = runEndOf(text, candidate, isBase64UrlChar);
            runAtCandidate = walk;
          }
        } else {
          // A boundary character outside the base64 class leaves no run to exempt.
          runAtCandidate = candidate;
        }
        if (isDataUrlPrefix(text, runAtCandidate)) {
          continue;
        }
      }
      const end = tokenEnd(text, candidate);
      if (end === null) {
        continue;
      }
      const matchStart = candidate > 0 ? candidate - 1 : 0;
      yield {
        match: text.slice(matchStart, end),
        groups: [candidate > 0 ? text[candidate - 1]! : "", text.slice(candidate, end)],
        input: text,
        offset: matchStart,
      };
      searchFloor = end + 1;
    }
  }
  return Object.freeze({ source, exec });
}

const GAAAA_VALUE_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "=" || char === "-";
const ATBB_VALUE_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "=" || char === "." || char === "-";
const AT_VALUE_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "+" || char === "/" || char === "=" || char === "-";

function fixedTailTokenEnd(
  tailStart: number,
  tailLength: number,
  isMember: (char: string | undefined) => boolean,
): Base64SafeTokenEnd {
  return (text, start) => {
    const end = start + tailStart + tailLength;
    for (let index = start + tailStart; index < end; index++) {
      if (!isMember(text[index])) {
        return null;
      }
    }
    return end;
  };
}

/** `dapi` + 32 hex digits + an optional `-<digit>`; the optional tail is greedy like the regex. */
function dapiTokenEnd(text: string, start: number): number | null {
  const bodyEnd = start + 4 + 32;
  for (let index = start + 4; index < bodyEnd; index++) {
    if (!isHexChar(text[index])) {
      return null;
    }
  }
  if (text[bodyEnd] === "-" && isDigitChar(text[bodyEnd + 1])) {
    return bodyEnd + 2;
  }
  return bodyEnd;
}

/**
 * `ATCTT3xFfG`/`ATATT` value: one or more class characters, then `=`, then exactly eight
 * alphanumerics. Greedy backtracking lands on the rightmost `=` in the run whose next
 * eight characters are alphanumerics; each run is scanned once and candidates share it.
 */
function makeAtEqualsTokenMatcher(source: string, prefix: string) {
  const prefixLength = prefix.length;
  return makeBase64SafeTokenMatcher(source, prefix, () => {
    let runStart = -1;
    let runEnd = -1;
    let equals: number[] = [];
    return (text: string, start: number): number | null => {
      const valueStart = start + prefixLength;
      if (valueStart < runStart || valueStart >= runEnd) {
        runEnd = runEndOf(text, valueStart, AT_VALUE_CHAR);
        runStart = valueStart;
        equals = [];
        for (let index = valueStart; index < runEnd; index++) {
          if (
            text[index] === "=" &&
            index + 9 <= text.length &&
            isAlnumChar(text[index + 1]) &&
            isAlnumChar(text[index + 2]) &&
            isAlnumChar(text[index + 3]) &&
            isAlnumChar(text[index + 4]) &&
            isAlnumChar(text[index + 5]) &&
            isAlnumChar(text[index + 6]) &&
            isAlnumChar(text[index + 7]) &&
            isAlnumChar(text[index + 8])
          ) {
            equals.push(index);
          }
        }
      }
      // Greedy backtracking lands on the rightmost valid split, and later candidates in the
      // same run only raise the minimum, so the largest entry is always the answer.
      const minimum = valueStart + 1;
      const split = equals[equals.length - 1];
      return split !== undefined && split >= minimum ? split + 9 : null;
    };
  });
}

const GAAAA_TOKEN_MATCHER = makeBase64SafeTokenMatcher(
  "vendor-token gAAAA (linear)",
  "gAAAA",
  () => (text, start) => {
    const end = runEndOf(text, start + 5, GAAAA_VALUE_CHAR);
    return end - (start + 5) >= 20 ? end : null;
  },
);
const ATBB_TOKEN_MATCHER = makeBase64SafeTokenMatcher(
  "vendor-token ATBB (linear)",
  "ATBB",
  () => (text, start) => {
    const end = runEndOf(text, start + 4, ATBB_VALUE_CHAR);
    return end - (start + 4) >= 16 ? end : null;
  },
);
const AKIA_TOKEN_MATCHER = makeBase64SafeTokenMatcher("vendor-token AKIA (linear)", "AKIA", () =>
  fixedTailTokenEnd(4, 16, isAlnumChar),
);
const ASIA_TOKEN_MATCHER = makeBase64SafeTokenMatcher("vendor-token ASIA (linear)", "ASIA", () =>
  fixedTailTokenEnd(4, 16, isAlnumChar),
);
const DAPI_TOKEN_MATCHER = makeBase64SafeTokenMatcher(
  "vendor-token dapi (linear)",
  "dapi",
  () => dapiTokenEnd,
);
const ATCTT_TOKEN_MATCHER = makeAtEqualsTokenMatcher(
  "vendor-token ATCTT3xFfG (linear)",
  "ATCTT3xFfG",
);
const ATATT_TOKEN_MATCHER = makeAtEqualsTokenMatcher("vendor-token ATATT (linear)", "ATATT");

const JWT_REDACT_PATTERN = String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`;
const JWT_SEGMENT_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "-";

/** JWT rule: each `eyJ` candidate parses its three segments forward; class runs are shared. */
const JWT_MATCHER = Object.freeze({
  source: "jwt (linear)",
  *exec(text: string): Iterable<RedactMatch> {
    let runStart = -1;
    let runEnd = -1;
    const segmentEnd = (position: number): number => {
      if (position >= runStart && position < runEnd) {
        return runEnd;
      }
      const end = runEndOf(text, position, JWT_SEGMENT_CHAR);
      runStart = position;
      runEnd = end;
      return end;
    };
    let searchFloor = 0;
    for (const candidate of scanPrefixOccurrences(text, "eyj")) {
      if (candidate < searchFloor) {
        continue;
      }
      const firstEnd = segmentEnd(candidate + 3);
      if (firstEnd - (candidate + 3) < 10 || text[firstEnd] !== ".") {
        continue;
      }
      const secondEnd = segmentEnd(firstEnd + 1);
      if (secondEnd - (firstEnd + 1) < 10 || text[secondEnd] !== ".") {
        continue;
      }
      const thirdEnd = segmentEnd(secondEnd + 1);
      if (thirdEnd - (secondEnd + 1) < 10) {
        continue;
      }
      const token = text.slice(candidate, thirdEnd);
      yield { match: token, groups: [token], input: text, offset: candidate };
      searchFloor = thirdEnd;
    }
  },
});

const URL_USERINFO_REDACT_PATTERN = String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`;
const CONNECTION_STRING_REDACT_PATTERN = String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`;
const URL_USERINFO_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
const CONNECTION_STRING_SCHEMES = new Set([
  "postgres",
  "postgresql",
  "mysql",
  "mongodb",
  "mongodb+srv",
  "redis",
  "rediss",
  "amqp",
  "amqps",
]);

/**
 * Shared matcher for the URL-userinfo and connection-string password rules. Both regexes are
 * deterministic parses (each character class excludes its own terminators), so every `://`
 * candidate parses forward once; failed password scans are memoized because later candidates
 * share their tail regions.
 */
function makeUserInfoMatcher(
  source: string,
  schemes: ReadonlySet<string>,
  isPassTerminator: (char: string | undefined) => boolean,
) {
  function* exec(text: string): Iterable<RedactMatch> {
    let searchFloor = 0;
    let failedPassScanEnd = -1;
    let separator = text.indexOf("://");
    while (separator !== -1) {
      let schemeStart = separator;
      while (schemeStart > 0 && isWordChar(text[schemeStart - 1])) {
        schemeStart -= 1;
      }
      // `mongodb+srv` carries a non-word `+`; extend the word run through that one shape.
      let scheme = text.slice(schemeStart, separator).toLowerCase();
      let matchStart = schemeStart;
      if (
        !schemes.has(scheme) &&
        schemeStart >= 8 &&
        text.slice(schemeStart - 8, schemeStart).toLowerCase() === "mongodb+"
      ) {
        scheme = "mongodb+srv";
        matchStart = schemeStart - 8;
      }
      if (
        separator >= searchFloor &&
        schemes.has(scheme) &&
        (matchStart === 0 || !isWordChar(text[matchStart - 1]))
      ) {
        const userStart = separator + 3;
        let cursor = userStart;
        while (
          cursor < text.length &&
          text[cursor] !== ":" &&
          text[cursor] !== "/" &&
          text[cursor] !== "@" &&
          !isJsWhitespaceAt(text, cursor)
        ) {
          cursor += 1;
        }
        if (text[cursor] === ":") {
          const passStart = cursor + 1;
          if (passStart >= failedPassScanEnd) {
            const passEnd = runEndOf(text, passStart, (char) => !isPassTerminator(char));
            if (text[passEnd] === "@" && passEnd > passStart) {
              yield {
                match: text.slice(matchStart, passEnd + 1),
                groups: [text.slice(passStart, passEnd)],
                input: text,
                offset: matchStart,
              };
              searchFloor = passEnd + 1;
              separator = text.indexOf("://", passEnd + 1);
              continue;
            }
            failedPassScanEnd = passEnd;
          }
        }
      }
      separator = text.indexOf("://", separator + 1);
    }
  }
  return Object.freeze({ source, exec });
}

const URL_USERINFO_MATCHER = makeUserInfoMatcher(
  "url-userinfo (linear)",
  URL_USERINFO_SCHEMES,
  // `[^\/\s@]+` stops at a slash, whitespace, or the terminating `@`.
  (char) => char === "/" || char === "@" || isJsWhitespaceChar(char),
);
const CONNECTION_STRING_MATCHER = makeUserInfoMatcher(
  "connection-string (linear)",
  CONNECTION_STRING_SCHEMES,
  // `[^@\s]+` stops at whitespace or the terminating `@`; slashes stay inside the value.
  (char) => char === "@" || isJsWhitespaceChar(char),
);

const FORM_BODY_FIRST_PAIR_REDACT_PATTERN = String.raw`(^|[\s,;])(?:${FORM_BODY_FIRST_PAIR_KEYS})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`;
const FORM_FIRST_PAIR_KEYS_RE = new RegExp(`^(?:${FORM_BODY_FIRST_PAIR_KEYS})$`, "i");
const FORM_FIRST_PAIR_KEY_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "-" || char === "_";
const FORM_FIRST_PAIR_TAIL_CHAR = (char: string | undefined): boolean =>
  isAlnumChar(char) || char === "_" || char === "." || char === "-";

/** The lookahead `&[A-Za-z_][A-Za-z0-9_.-]*=` is a deterministic forward check. */
function isFormPairBoundary(text: string, ampersand: number): boolean {
  if (!isAlnumChar(text[ampersand + 1]) && text[ampersand + 1] !== "_") {
    return false;
  }
  const keyEnd = runEndOf(text, ampersand + 2, FORM_FIRST_PAIR_TAIL_CHAR);
  return text[keyEnd] === "=";
}

/**
 * Form first-pair rule: the value class excludes `&` and whitespace, so the greedy value
 * always ends at the first `&` or whitespace and the lookahead is checked there alone;
 * per-candidate value runs are shared so long runs are read once.
 */
const FORM_BODY_FIRST_PAIR_MATCHER = Object.freeze({
  source: "form-body-first-pair (linear)",
  *exec(text: string): Iterable<RedactMatch> {
    let runStart = -1;
    let runEnd = -1;
    const valueEnd = (start: number): number => {
      if (start >= runStart && start < runEnd) {
        return runEnd;
      }
      const end = runEndOf(text, start, (char) => char !== "&" && !isJsWhitespaceChar(char));
      runStart = start;
      runEnd = end;
      return end;
    };
    let searchFloor = 0;
    let separator = text.indexOf("=");
    while (separator !== -1) {
      let keyStart = separator;
      while (keyStart > 0 && FORM_FIRST_PAIR_KEY_CHAR(text[keyStart - 1])) {
        keyStart -= 1;
      }
      const key = text.slice(keyStart, separator);
      if (
        separator >= searchFloor &&
        key.length > 0 &&
        FORM_FIRST_PAIR_KEYS_RE.test(key) &&
        (keyStart === 0 ||
          text[keyStart - 1] === "," ||
          text[keyStart - 1] === ";" ||
          isJsWhitespaceAt(text, keyStart - 1))
      ) {
        const start = separator + 1;
        const end = valueEnd(start);
        if (
          end > start &&
          end < text.length &&
          text[end] === "&" &&
          isFormPairBoundary(text, end)
        ) {
          const matchStart = keyStart > 0 ? keyStart - 1 : 0;
          yield {
            match: text.slice(matchStart, end),
            groups: [keyStart > 0 ? text[keyStart - 1]! : "", text.slice(start, end)],
            input: text,
            offset: matchStart,
          };
          searchFloor = end;
          separator = text.indexOf("=", end);
          continue;
        }
      }
      separator = text.indexOf("=", separator + 1);
    }
  },
});

const STANDALONE_QUOTED_PREFIX_SOURCE = String.raw`(^|[\s,;({\["])(?:${STANDALONE_ASSIGNMENT_SECRET_KEYS})=(["'\x60])`;
const CONFIG_QUOTED_PREFIX_SOURCE = String.raw`(^|[\s,{])(?:(?:${CONFIG_QUOTED_ASSIGNMENT_SECRET_KEYS})(?:\s*:\s*|\s+=\s*|=\s*)|[a-z0-9][a-z0-9._-]{0,79}[-_](?:${CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*|[a-z0-9_.-]{1,80}\.(?:${CONFIG_ASSIGNMENT_SECRET_KEYS})\s*[:=]\s*)(["'\x60])`;

/**
 * Shared matcher for the two quoted-value rules. The tempered dot `((?:(?!\2)[^\r\n])+)`
 * forced a per-character lookahead and one backtrack stack entry per value character; the
 * value here is a linear scan to the first closing quote or line end, and failed scans are
 * memoized per quote character because later candidates share their tail regions.
 */
function makeQuotedAssignmentMatcher(source: string, prefixSource: string, flags: string) {
  function* exec(text: string): Iterable<RedactMatch> {
    const prefixRe = new RegExp(prefixSource, flags);
    const failedScans = new Map<string, { start: number; end: number }>();
    let searchFrom = 0;
    for (;;) {
      prefixRe.lastIndex = searchFrom;
      const prefix = prefixRe.exec(text);
      if (!prefix) {
        return;
      }
      const start = prefix.index;
      const quote = prefix[2]!;
      const valueStart = start + prefix[0].length;
      const memo = failedScans.get(quote);
      let closing = -1;
      // A failed scan proved its region holds no closing quote for this character; later
      // candidates inside that region fail without rescanning it.
      const covered = memo !== undefined && valueStart >= memo.start && valueStart < memo.end;
      if (!covered) {
        closing = valueStart;
        while (closing < text.length) {
          const char = text[closing];
          if (char === quote || char === "\r" || char === "\n") {
            break;
          }
          closing += 1;
        }
      }
      if (closing > valueStart && text[closing] === quote) {
        const end = closing + 1;
        yield {
          match: text.slice(start, end),
          groups: [prefix[1] ?? "", quote, text.slice(valueStart, closing)],
          input: text,
          offset: start,
        };
        searchFrom = end;
      } else {
        if (closing !== -1) {
          failedScans.set(quote, { start: valueStart, end: closing });
        }
        searchFrom = start + 1;
      }
    }
  }
  return Object.freeze({ source, exec });
}

const STANDALONE_QUOTED_MATCHER = makeQuotedAssignmentMatcher(
  "standalone-quoted-assignment (linear)",
  STANDALONE_QUOTED_PREFIX_SOURCE,
  "gi",
);
const CONFIG_QUOTED_MATCHER = makeQuotedAssignmentMatcher(
  "config-quoted-assignment (linear)",
  CONFIG_QUOTED_PREFIX_SOURCE,
  "g",
);

/** Default rule sources whose compilation routes to the linear matchers above. */
export const LINEAR_MATCHER_SOURCES: ReadonlyMap<string, ResolvedRedactPattern> = new Map<
  string,
  ResolvedRedactPattern
>([
  [String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(gAAAA[A-Za-z0-9_=-]{20,})`, GAAAA_TOKEN_MATCHER],
  [
    String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATCTT3xFfG[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8})`,
    ATCTT_TOKEN_MATCHER,
  ],
  [
    String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATATT[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8})`,
    ATATT_TOKEN_MATCHER,
  ],
  [String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATBB[A-Za-z0-9_=.-]{16,})`, ATBB_TOKEN_MATCHER],
  [String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(dapi[0-9a-f]{32}(?:-\d)?)`, DAPI_TOKEN_MATCHER],
  [String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(AKIA[A-Z0-9]{16})`, AKIA_TOKEN_MATCHER],
  [String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ASIA[A-Z0-9]{16})`, ASIA_TOKEN_MATCHER],
  [JWT_REDACT_PATTERN, JWT_MATCHER],
  [URL_USERINFO_REDACT_PATTERN, URL_USERINFO_MATCHER],
  [CONNECTION_STRING_REDACT_PATTERN, CONNECTION_STRING_MATCHER],
  [FORM_BODY_FIRST_PAIR_REDACT_PATTERN, FORM_BODY_FIRST_PAIR_MATCHER],
  [STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN, STANDALONE_QUOTED_MATCHER],
  [CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN, CONFIG_QUOTED_MATCHER],
]);

const TELEGRAM_BOT_TOKEN_REDACT_PATTERN = String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const TELEGRAM_TOKEN_REDACT_PATTERN = String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const CREDENTIAL_STYLE_HEADER_KEYS = "x-goog-api-key|api-key|apikey|x-api-token|x-access-token";
const GATEWAY_SECURITY_HEADER_KEYS =
  "X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token";
export const CREDENTIAL_HEADER_FIELD_RE = new RegExp(
  `^(?:${CREDENTIAL_STYLE_HEADER_KEYS}|${GATEWAY_SECURITY_HEADER_KEYS})$`,
  "i",
);
// Colons identify HTTP headers. Equals assignments may be form bodies, so stop only before an
// actual following `&key=` pair; otherwise opaque credential punctuation stays fully masked.
const LOG_HEADER_BOUNDARY_PATTERN = String.raw`(^|[^A-Za-z0-9_?&-]|\\{1,64}[rn])`;
const CREDENTIAL_STYLE_COLON_HEADER_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${CREDENTIAL_STYLE_HEADER_KEYS})${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*:${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}([^\s\\"',;]+)`;
const CREDENTIAL_STYLE_EQUALS_ASSIGNMENT_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${CREDENTIAL_STYLE_HEADER_KEYS})${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*=${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}([^\s\\"',;]+)`;
const GATEWAY_SECURITY_COLON_HEADER_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${GATEWAY_SECURITY_HEADER_KEYS})\s*:\s*([^\s"',;]+)`;
const GATEWAY_SECURITY_EQUALS_ASSIGNMENT_REDACT_PATTERN = String.raw`${LOG_HEADER_BOUNDARY_PATTERN}(?:${GATEWAY_SECURITY_HEADER_KEYS})\s*=\s*([^\s"',;]+)`;
export const FORM_AWARE_EQUALS_ASSIGNMENT_PATTERN_SOURCES = new Set([
  CREDENTIAL_STYLE_EQUALS_ASSIGNMENT_REDACT_PATTERN,
  GATEWAY_SECURITY_EQUALS_ASSIGNMENT_REDACT_PATTERN,
]);
const HTTP_AUTH_HEADER_REDACT_PATTERNS = [
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Proxy-Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}${HTTP_AUTH_SCHEME_PATTERN}${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Proxy-Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})[ \t]*(?=${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?!(?:Bearer|Basic|Bot)(?=${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}))${HTTP_AUTH_SCHEME_PATTERN}${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`,
  String.raw`${HTTP_AUTH_HEADER_BOUNDARY_PATTERN}Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_OPTIONAL_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?!(?:Bearer|Basic|Bot)(?=${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}))(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})[ \t]*(?=${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
  CREDENTIAL_STYLE_COLON_HEADER_REDACT_PATTERN,
  CREDENTIAL_STYLE_EQUALS_ASSIGNMENT_REDACT_PATTERN,
] as const;
const AUTHORIZATION_BEARER_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Bearer${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const AUTHORIZATION_BASIC_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Basic${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const AUTHORIZATION_BOT_REDACT_PATTERN = String.raw`Authorization${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}[ \t]*[:=]${HTTP_AUTH_LEGACY_VALUE_WHITESPACE_PATTERN}${HTTP_AUTH_SERIALIZED_QUOTE_PATTERN}Bot${HTTP_AUTH_REQUIRED_VALUE_WHITESPACE_PATTERN}(${HTTP_AUTH_OPAQUE_CREDENTIAL_PATTERN})`;
const STANDALONE_BEARER_REDACT_PATTERN = String.raw`\bBearer\s+([-A-Za-z0-9._~+/=]{18,})(?![-A-Za-z0-9._~+/=])`;
export const SHELL_REFERENCE_PRESERVING_PATTERN_SOURCES = new Set([
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
]);

const DEFAULT_REDACT_FIELD_PATTERNS: readonly RedactPattern[] = [
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STRUCTURED_JSON_SECRET_REDACT_PATTERN,
  STRUCTURED_JSON_PAYMENT_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_SECRET_FIELD_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_AUTH_FIELD_REDACT_PATTERN,
  String.raw`--(?:${CLI_SECRET_FLAG_KEYS})=([^\s"']+)`,
  String.raw`--(?:${CLI_SECRET_FLAG_KEYS})\s+(?!(?:or|and)\b(?=\s+--))(["']?)([^\s"']+)\1`,
  AUTHORIZATION_BEARER_REDACT_PATTERN,
  AUTHORIZATION_BASIC_REDACT_PATTERN,
  AUTHORIZATION_BOT_REDACT_PATTERN,
  ...HTTP_AUTH_HEADER_REDACT_PATTERNS,
  GATEWAY_SECURITY_COLON_HEADER_REDACT_PATTERN,
  GATEWAY_SECURITY_EQUALS_ASSIGNMENT_REDACT_PATTERN,
  STANDALONE_BEARER_REDACT_PATTERN,
  String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`,
  String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`,
  String.raw`(^|[\s,;])(?:${FORM_BODY_FIRST_PAIR_KEYS})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_ASSIGNMENT_REDACT_PATTERN,
  // Runs where the generic rule handled bare `pass:`, before the namespaced and prefixed rules.
  BARE_PASS_ASSIGNMENT_MATCHER,
  CONFIG_DIRECT_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_NAMESPACED_ASSIGNMENT_REDACT_PATTERN,
  PEM_REDACT_PATTERN_SOURCE,
  String.raw`(^|[\s,{])["']?(?:${AWS_SECRET_ACCESS_KEY_FIELD_KEYS})["']?\s*[:=]\s*(["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])\2`,
];

export const VENDOR_TOKEN_REDACT_PATTERNS: readonly string[] = [
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`(ghp_[A-Za-z0-9]{10,})`,
  String.raw`(github_pat_[A-Za-z0-9_]{10,})`,
  String.raw`(gho_[A-Za-z0-9]{10,})`,
  String.raw`(ghu_[A-Za-z0-9]{10,})`,
  String.raw`(ghs_[A-Za-z0-9]{10,})`,
  String.raw`(ghr_[A-Za-z0-9]{10,})`,
  String.raw`(glpat-[A-Za-z0-9._=\-]{20,})`,
  String.raw`(gloas-(?:[A-Fa-f0-9]{65,}|[A-Za-z0-9_-]{64}|[A-Fa-f0-9]{32,}))`,
  String.raw`(gldt-[A-Za-z0-9_-]{20,})`,
  String.raw`(glcbt-[A-Za-z0-9]{1,5}_[A-Za-z0-9_-]{20,})`,
  String.raw`(glptt-[A-Za-z0-9_-]{40,})`,
  String.raw`(glft-(?:[A-Za-z0-9_-]{20,}|[a-h0-9]+-[0-9]+_))`,
  String.raw`(glimt-[A-Za-z0-9_-]{25,})`,
  String.raw`(glagent-[A-Za-z0-9_-]{50,})`,
  String.raw`(glwt-[A-Za-z0-9_-]{20,})`,
  String.raw`(glsoat-[A-Za-z0-9_-]{20,})`,
  String.raw`(glffct-[A-Za-z0-9_-]{20,})`,
  String.raw`(glrt-[A-Za-z0-9._-]{20,})`,
  String.raw`(glrtr?-[A-Za-z0-9_-]{27,300}\.[0-9a-z]{2}\.[0-9a-z]{9})`,
  String.raw`(GR1348941[A-Za-z0-9_-]{20,})`,
  String.raw`(_gitlab_session=[A-Za-z0-9%._-]{20,})`,
  String.raw`(xox[baprs]-[A-Za-z0-9-]{10,})`,
  String.raw`(xapp-[A-Za-z0-9-]{10,})`,
  String.raw`(https:\/\/hooks\.slack\.com\/(?:services\/T[A-Z0-9]+\/B[A-Z0-9]+|workflows\/T[A-Z0-9]+\/A[A-Z0-9]+\/[0-9]{17,19})\/[A-Za-z0-9]{20,})`,
  String.raw`(https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,})`,
  String.raw`discord(?:.|\n|\r){0,40}?\b([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b`,
  String.raw`(gsk_[A-Za-z0-9_-]{10,})`,
  String.raw`(AIza[0-9A-Za-z\-_]{20,})`,
  String.raw`(ya29\.[0-9A-Za-z_\-./+=]{10,})`,
  String.raw`(1//0[0-9A-Za-z_\-./+=]{10,})`,
  String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
  String.raw`(pplx-[A-Za-z0-9_-]{10,})`,
  String.raw`(fal_[A-Za-z0-9_-]{10,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fc-[A-Za-z0-9]{10,})`,
  String.raw`(bb_live_[A-Za-z0-9_-]{10,})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(gAAAA[A-Za-z0-9_=-]{20,})`,
  String.raw`(sk_live_[A-Za-z0-9]{10,})`,
  String.raw`(sk_test_[A-Za-z0-9]{10,})`,
  String.raw`(rk_live_[A-Za-z0-9]{10,})`,
  String.raw`(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
  String.raw`(npm_[A-Za-z0-9]{10,})`,
  String.raw`(pypi-[A-Za-z0-9_-]{10,})`,
  String.raw`(dop_v1_[A-Za-z0-9]{10,})`,
  String.raw`(doo_v1_[A-Za-z0-9]{10,})`,
  String.raw`(dor_v1_[A-Za-z0-9]{10,})`,
  String.raw`(dp\.(?:ct|pt|sa|scim|audit)\.[A-Za-z0-9]{40,44})`,
  String.raw`(dp\.st\.[A-Za-z0-9]{40,44})`,
  String.raw`(dp\.st\.[a-z0-9_-]{2,35}\.[A-Za-z0-9]{40,44})`,
  String.raw`(dckr_(?:pat|oat)_[A-Za-z0-9_-]{27,32})`,
  String.raw`(bkua_[a-z0-9]{40})`,
  String.raw`(CCIPAT_[A-Za-z0-9]{22}_[A-Fa-f0-9]{40})`,
  String.raw`(sbp_[a-z0-9]{40})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(dapi[0-9a-f]{32}(?:-\d)?)`,
  String.raw`(dd[pw]_[A-Za-z0-9]{36})`,
  String.raw`(glsa_[A-Za-z0-9_]{41})`,
  String.raw`(glc_eyJ[A-Za-z0-9+/=]{60,160})`,
  String.raw`(nfp_[A-Za-z0-9_]{36})`,
  String.raw`(CFPAT-[A-Za-z0-9_\-]{40,})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATCTT3xFfG[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATATT[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ATBB[A-Za-z0-9_=.-]{16,})`,
  String.raw`(BBDC-[A-Za-z0-9+/@_-]{40,50})`,
  String.raw`(HRKU-AA[A-Za-z0-9_-]{20,})`,
  String.raw`(pat-(?:eu|na)1-[A-Za-z0-9]{8}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{12})`,
  String.raw`(apify_api_[A-Za-z0-9\-]{20,})`,
  String.raw`(FlyV1 fm\d+_[A-Za-z0-9+/=,_-]{100,})`,
  String.raw`(fio-u-[A-Za-z0-9_-]{40,})`,
  String.raw`(^|[^A-Za-z0-9_])(am_[A-Za-z0-9_-]{10,})`,
  String.raw`(^|[^A-Za-z0-9_])(sk_[A-Za-z0-9_]{10,})`,
  String.raw`(tvly-[A-Za-z0-9]{10,})`,
  String.raw`(exa_[A-Za-z0-9]{10,})`,
  String.raw`(syt_[A-Za-z0-9]{10,})`,
  String.raw`(retaindb_[A-Za-z0-9]{10,})`,
  String.raw`(hsk-[A-Za-z0-9]{10,})`,
  String.raw`(mem0_[A-Za-z0-9]{10,})`,
  String.raw`(brv_[A-Za-z0-9]{10,})`,
  String.raw`(xai-[A-Za-z0-9]{30,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fw-[A-Za-z0-9]{30,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fw_[A-Za-z0-9]{30,})`,
  String.raw`${IDENTIFIER_SAFE_TOKEN_BOUNDARY}(fpk_[A-Za-z0-9]{30,})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(AKIA[A-Z0-9]{16})`,
  String.raw`${BASE64_SAFE_TOKEN_BOUNDARY}(ASIA[A-Z0-9]{16})`,
  String.raw`(AKID[A-Za-z0-9]{10,})`,
  String.raw`(LTAI[A-Za-z0-9]{10,})`,
  String.raw`(hf_[A-Za-z0-9]{10,})`,
  String.raw`(api_org_[A-Za-z0-9]{20,})`,
  String.raw`(r8_[A-Za-z0-9]{10,})`,
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
];

export const DEFAULT_REDACT_PATTERNS: readonly RedactPattern[] = [
  ...DEFAULT_REDACT_FIELD_PATTERNS,
  ...VENDOR_TOKEN_REDACT_PATTERNS,
  AWS_SECRET_ACCESS_KEY_MATCHER,
];

export const TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS = new Set([
  ENV_ASSIGNMENT_REDACT_PATTERN,
  ESCAPED_ENV_ASSIGNMENT_REDACT_PATTERN,
  STRUCTURED_JSON_SECRET_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_SECRET_FIELD_REDACT_PATTERN,
  AMBIGUOUS_QUOTED_AUTH_FIELD_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_QUOTED_REDACT_PATTERN,
  STANDALONE_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_QUOTED_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_DIRECT_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_PREFIXED_PASSWORD_ASSIGNMENT_REDACT_PATTERN,
  CONFIG_NAMESPACED_ASSIGNMENT_REDACT_PATTERN,
]);

/** Programmatic counterparts of the ambiguous assignment rules: kept out of tool payloads, preserved in source. */
export const AMBIGUOUS_ASSIGNMENT_MATCHERS: ReadonlySet<RedactPattern> = new Set([
  BARE_PASS_ASSIGNMENT_MATCHER,
]);

// Tool output commonly contains source code. Keep key-name matching in logs, direct `.env` reads,
// and payment JSON; other model-visible text relies on registered and recognizable secret values.
export const TOOL_PAYLOAD_REDACT_PATTERNS: readonly RedactPattern[] =
  DEFAULT_REDACT_PATTERNS.filter((pattern) =>
    typeof pattern === "string"
      ? !TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS.has(pattern)
      : !AMBIGUOUS_ASSIGNMENT_MATCHERS.has(pattern),
  );
