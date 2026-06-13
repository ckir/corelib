export const REDACTED = "<REDACTED>";

/** Case-insensitive header/key names + regex matched recursively in bodies and query strings. */
export const SECRET_HEADER_DENYLIST = [
  "authorization", "cookie", "set-cookie",
  "apca-api-key-id", "apca-api-secret-key", "x-api-key", "x-amz-security-token",
];
const SECRET_KEY_RE = /key|secret|token|auth|session|password/i;
const EXPLICIT_BODY_KEYS = new Set(["keyid", "secretkey", "apikey"]);

export interface Fixture {
  request: { method: string; url: string; headers: Record<string, string> };
  response: { status: number; headers: Record<string, string>; body: unknown };
  recordedAt: string;
}

function isHeaderSecret(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HEADER_DENYLIST.includes(n) || SECRET_KEY_RE.test(n);
}

function scrubHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = isHeaderSecret(k) ? REDACTED : v;
  return out;
}

function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_KEY_RE.test(key) || EXPLICIT_BODY_KEYS.has(key.toLowerCase())) {
        u.searchParams.set(key, REDACTED);
      }
    }
    // URLSearchParams percent-encodes the <> in the sentinel; restore the literal marker
    // (targeted replace of the known-encoded sentinel only — safe for other query values).
    return u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  } catch {
    return url;
  }
}

function scrubBodyValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubBodyValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) || EXPLICIT_BODY_KEYS.has(k.toLowerCase())
        ? REDACTED
        : scrubBodyValue(val);
    }
    return out;
  }
  return v;
}

function scrubBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return JSON.stringify(scrubBodyValue(JSON.parse(body)));
    } catch {
      return body; // non-JSON string left as-is (header/query scrubbing still applied)
    }
  }
  return scrubBodyValue(body);
}

export function scrubFixture(f: Fixture): Fixture {
  return {
    request: { method: f.request.method, url: scrubUrl(f.request.url), headers: scrubHeaders(f.request.headers) },
    response: { status: f.response.status, headers: scrubHeaders(f.response.headers), body: scrubBody(f.response.body) },
    recordedAt: f.recordedAt,
  };
}

/** Returns human-readable reasons a fixture still leaks a secret (empty = clean). Used by the validator. */
export function findUnscrubbedSecrets(f: Fixture): string[] {
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(f.request.headers)) if (isHeaderSecret(k) && v !== REDACTED) reasons.push(`request header ${k}`);
  for (const [k, v] of Object.entries(f.response.headers)) if (isHeaderSecret(k) && v !== REDACTED) reasons.push(`response header ${k}`);
  try {
    const u = new URL(f.request.url);
    for (const key of u.searchParams.keys()) {
      if ((SECRET_KEY_RE.test(key) || EXPLICIT_BODY_KEYS.has(key.toLowerCase())) && u.searchParams.get(key) !== REDACTED) {
        reasons.push(`query ${key}`);
      }
    }
  } catch { /* ignore */ }
  const walk = (val: unknown, path: string) => {
    if (Array.isArray(val)) val.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (val && typeof val === "object") {
      for (const [k, vv] of Object.entries(val as Record<string, unknown>)) {
        if ((SECRET_KEY_RE.test(k) || EXPLICIT_BODY_KEYS.has(k.toLowerCase())) && vv !== REDACTED) reasons.push(`body ${path}.${k}`);
        else walk(vv, `${path}.${k}`);
      }
    }
  };
  const body = typeof f.response.body === "string" ? safeParse(f.response.body) : f.response.body;
  walk(body, "");
  return reasons;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
