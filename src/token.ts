import { createHmac, timingSafeEqual } from "node:crypto";

// A download token is a self-contained, URL-safe blob so the search side and
// the download side never need shared state. It carries the backend name and
// the adapter's opaque fetchRef, plus display metadata for queue/history.

export interface TokenPayload {
  backend: string;
  fetchRef: unknown;
  title: string;
  sizeBytes: number;
  extension?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function encodeToken(payload: TokenPayload, secret?: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  if (!secret) return body;
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function decodeToken(token: string, secret?: string): TokenPayload {
  const [body, sig] = token.split(".");
  if (secret) {
    if (!sig) throw new Error("token missing signature");
    const expected = b64url(createHmac("sha256", secret).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("token signature mismatch");
    }
  }
  return JSON.parse(unb64url(body).toString("utf8")) as TokenPayload;
}
