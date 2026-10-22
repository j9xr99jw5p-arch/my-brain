// capture-link · Stage 2 · Capture
// Reads a web page for the signed-in person and saves its text to their brain.
// It acts as that person, so the database's two locks still decide what it can save.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_THOUGHT_CHARS = 20000;
const MIN_READABLE_CHARS = 300;
const GOOD_AMOUNT_OF_TEXT = 500;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function fail(status: number, error: string): Response {
  return reply(status, { ok: false, error });
}

// The project's public key: the publishable key if set, else the anon key, else the caller's apikey header.
function publicKey(req: Request): string {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      if (parsed && typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch {
      // Not valid JSON; fall through to the next option.
    }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
}

function codePoint(n: number, original: string): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return original;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => codePoint(parseInt(dec, 10), m))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

// Collapse runs of spaces and blank lines.
function tidy(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Remove everything that isn't reading matter.
function removeNonReading(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|template|noscript|iframe|svg|form|nav|aside|header|footer)\b[\s\S]*?<\/\1\s*>/gi,
      " ",
    );
}

function htmlToText(html: string): string {
  const text = html
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return tidy(decodeEntities(text));
}

function readableText(html: string): string {
  const cleaned = removeNonReading(html);
  for (const tag of ["article", "main"]) {
    const match = cleaned.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}\\s*>`, "i"));
    if (match) {
      const text = htmlToText(match[1]);
      if (text.length >= GOOD_AMOUNT_OF_TEXT) return text;
    }
  }
  const body = cleaned.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  return htmlToText(body ? body[1] : cleaned);
}

function oneLine(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function pageTitle(html: string, hostname: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\b(?:property|name)\s*=\s*["']og:title["']/i.test(tag)) {
      const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const value = content ? oneLine(content[1] ?? content[2] ?? "") : "";
      if (value) return value;
    }
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleTag ? oneLine(titleTag[1]) : "";
  return title || hostname;
}

// Read the page, giving up (null) once it passes 5 MB.
async function readCapped(res: Response): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim().replace(/["']/g, "") || "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "This function only accepts POST requests.");

  try {
    // Who's asking
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return fail(401, "Please sign in again.");
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", publicKey(req), {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) return fail(401, "Please sign in again.");

    // The address
    let body: { url?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const raw = typeof body.url === "string" ? body.url.trim() : "";
    let address: URL;
    try {
      address = new URL(raw);
    } catch {
      return fail(400, "That doesn't look like a web address.");
    }
    if (address.protocol !== "http:" && address.protocol !== "https:") {
      return fail(400, "That doesn't look like a web address.");
    }

    // Fetch the page
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let html: string;
    try {
      const res = await fetch(address.href, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
      });
      if (!res.ok) return fail(422, "That page wouldn't open for us. It may need a login.");
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("application/pdf")) {
        return fail(415, "That's a PDF. Download it, then use the PDF tab.");
      }
      if (type && !type.includes("html") && !type.startsWith("text/")) {
        return fail(415, "That link isn't a web page.");
      }
      if (Number(res.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES) {
        return fail(413, "That page is too big to read.");
      }
      const bytes = await readCapped(res);
      if (!bytes) return fail(413, "That page is too big to read.");
      html = decodeBytes(bytes, type);
    } catch (err) {
      if (controller.signal.aborted) return fail(504, "That site didn't answer within 15 seconds.");
      console.error("capture-link: fetching the page failed:", err instanceof Error ? err.message : err);
      return fail(422, "That page wouldn't open for us. It may need a login.");
    } finally {
      clearTimeout(timer);
    }

    // Readable text
    const site = address.hostname;
    const title = pageTitle(html, site);
    const text = readableText(html);
    if (text.length < MIN_READABLE_CHARS) {
      return fail(
        422,
        "We couldn't find readable text on that page. Copy the article's text into the Write tab instead.",
      );
    }

    // Save the thought, as the signed-in person
    const content = `${title}\n${address.href}\n\n${text.slice(0, MAX_THOUGHT_CHARS)}`;
    const { data: thought, error: insertError } = await supabase
      .from("thoughts")
      .insert({ content, source: "link", metadata: { title, url: address.href, site } })
      .select("id")
      .single();
    if (insertError) {
      if (insertError.code === "23505") return reply(200, { ok: true, duplicate: true, title });
      console.error("capture-link: saving the thought failed:", insertError.message);
      return fail(500, "We couldn't save that to your brain. Please try again.");
    }

    // Save the full original on the shelf
    const { error: sourceError } = await supabase
      .from("thought_sources")
      .insert({ thought_id: thought.id, kind: "web", full_text: text });
    if (sourceError) {
      console.error("capture-link: saving the full text failed:", sourceError.message);
    }

    return reply(200, { ok: true, title, site, chars: text.length });
  } catch (err) {
    console.error("capture-link: unexpected error:", err instanceof Error ? err.message : err);
    return fail(500, "Something went wrong on our side. Please try again.");
  }
});