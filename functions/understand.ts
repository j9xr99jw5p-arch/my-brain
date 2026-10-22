// understand · Stage 3
// Gives each thought a meaning fingerprint, cuts long captures into passages,
// links related thoughts, and runs searches. It acts as the signed-in person
// and holds no secret key, so the database's locks apply to everything it does.
// Fingerprints come from the small model built into Supabase: nothing is sent
// to an outside AI company.

import { createClient } from "npm:@supabase/supabase-js@2";

// Supabase's edge runtime provides this global; there's nothing to import.
declare const Supabase: any;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_FINGERPRINTS = 12;   // per catch-up request
const MAX_MILLISECONDS = 8000; // per catch-up request
const MODEL_CHARS = 2000;      // the model reads about this much and ignores the rest
const SHORT_TEXT = 2000;       // texts this long or shorter get no passages
const PIECE_MAX = 1400;        // longest piece of a paragraph, and longest passage
const PASSAGE_TARGET = 1000;   // keep adding pieces while a passage is shorter than this
const CARRY_MAX = 200;         // longest sentence carried over from the previous passage

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fail(error: string, status: number): Response {
  return reply({ ok: false, error }, status);
}

// The project's public key: the "default" publishable key, else the anon key,
// else the apikey header the app sent.
function publicKey(req: Request): string {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) {
    try {
      const value = JSON.parse(keys)?.default;
      if (typeof value === "string" && value) return value;
    } catch (_) {
      // not valid JSON: try the next option
    }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
}

// One model session per request, made the first time it's needed and reused.
function makeFingerprinter() {
  let session: any = null;
  return async (text: string): Promise<number[]> => {
    if (!session) session = new Supabase.ai.Session("gte-small");
    const result = await session.run(text.slice(0, MODEL_CHARS), { mean_pool: true, normalize: true });
    return Array.from(result as ArrayLike<number>);
  };
}

// ── Splitting long text into passages ─────────────────────────────────
// The same text must always be cut the same way, because each request carries
// on counting from where the last one stopped.

function cutParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > PIECE_MAX) {
    const head = rest.slice(0, PIECE_MAX);
    const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    let cut: number;
    if (sentenceEnd >= 0) cut = sentenceEnd + 1;                  // keep the punctuation mark
    else if (head.lastIndexOf(" ") > 0) cut = head.lastIndexOf(" ");
    else cut = PIECE_MAX;
    const piece = rest.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function lastSentence(text: string): string {
  let start = 0;
  for (const mark of [". ", "? ", "! ", "\n"]) {
    const i = text.lastIndexOf(mark);
    if (i >= 0 && i + mark.length > start) start = i + mark.length;
  }
  let sentence = text.slice(start).trim();
  if (sentence.length > CARRY_MAX) {
    sentence = sentence.slice(-CARRY_MAX);
    const space = sentence.indexOf(" ");
    if (space >= 0) sentence = sentence.slice(space + 1);
  }
  return sentence;
}

function splitIntoPassages(fullText: string): string[] {
  const text = (fullText ?? "").replace(/\r\n?/g, "\n");
  if (text.length <= SHORT_TEXT) return [];

  // Paragraphs at blank lines; long paragraphs cut into pieces.
  const pieces: { text: string; startsParagraph: boolean }[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    cutParagraph(trimmed).forEach((piece, i) => pieces.push({ text: piece, startsParagraph: i === 0 }));
  }

  // Pieces gathered into passages of roughly a thousand characters.
  const groups: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) { current = piece.text; continue; }
    const joined = current + (piece.startsParagraph ? "\n\n" : " ") + piece.text;
    if (current.length < PASSAGE_TARGET && joined.length <= PIECE_MAX) current = joined;
    else { groups.push(current); current = piece.text; }
  }
  if (current) groups.push(current);

  // From the second passage on, start with the previous passage's last sentence.
  return groups.map((group, i) => {
    if (i === 0) return group;
    const carried = lastSentence(groups[i - 1]);
    return carried ? carried + " " + group : group;
  });
}

// ── catch-up: understand whatever isn't understood yet ────────────────

async function catchUp(
  supabase: any,
  userId: string,
  fingerprint: (text: string) => Promise<number[]>,
): Promise<Response> {
  const startedAt = Date.now();
  let made = 0;
  const budgetLeft = () => made < MAX_FINGERPRINTS && Date.now() - startedAt < MAX_MILLISECONDS;

  let currentId: string | null = null;
  try {
    while (budgetLeft()) {
      // 1. The oldest thought not yet understood.
      const { data: thought, error: findError } = await supabase
        .from("thoughts")
        .select("id, content, embedding")
        .eq("user_id", userId)
        .is("understood_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (findError) throw findError;
      if (!thought) break;
      currentId = thought.id;

      // 2. Its whole-thought fingerprint.
      if (!thought.embedding) {
        const embedding = await fingerprint(thought.content);
        made++;
        const { error } = await supabase.from("thoughts").update({ embedding }).eq("id", thought.id);
        if (error) throw error;
      }

      // 3. Its passages: from the thought itself, and from its full original if it has one.
      const { data: original, error: sourceError } = await supabase
        .from("thought_sources")
        .select("full_text")
        .eq("thought_id", thought.id)
        .limit(1)
        .maybeSingle();
      if (sourceError) throw sourceError;

      const lists = [
        { origin: "thought", texts: splitIntoPassages(thought.content) },
        { origin: "source", texts: splitIntoPassages(original?.full_text ?? "") },
      ];

      let finished = true;
      for (const list of lists) {
        if (list.texts.length === 0) continue;
        const { count, error: countError } = await supabase
          .from("thought_passages")
          .select("position", { count: "exact", head: true })
          .eq("thought_id", thought.id)
          .eq("origin", list.origin);
        if (countError) throw countError;

        for (let position = count ?? 0; position < list.texts.length; position++) {
          if (!budgetLeft()) { finished = false; break; }
          const embedding = await fingerprint(list.texts[position]);
          made++;
          const { error } = await supabase.from("thought_passages").insert({
            thought_id: thought.id,
            origin: list.origin,
            position,
            content: list.texts[position],
            embedding,
          });
          if (error) throw error;
        }
        if (!finished) break;
      }
      if (!finished) break; // the next request carries on from here

      // 4. Links to the closest thoughts in meaning, then mark it understood.
      const { data: nearest, error: nearError } = await supabase.rpc("nearest_thoughts", {
        for_thought: thought.id,
        how_many: 3,
        min_similarity: 0.82,
      });
      if (nearError) throw nearError;

      const links = (nearest ?? []).map((n: any) => {
        const mine = String(thought.id);
        const theirs = String(n.thought_id);
        return {
          thought_a: mine < theirs ? mine : theirs,
          thought_b: mine < theirs ? theirs : mine,
          similarity: Math.round(n.similarity * 1000) / 1000,
        };
      });
      if (links.length > 0) {
        const { error } = await supabase
          .from("thought_links")
          .upsert(links, { onConflict: "thought_a,thought_b", ignoreDuplicates: true });
        if (error) throw error;
      }

      const { error: doneError } = await supabase
        .from("thoughts")
        .update({ understood_at: new Date().toISOString() })
        .eq("id", thought.id);
      if (doneError) throw doneError;
      currentId = null;
    }
  } catch (err) {
    console.error("understand: catch-up stopped on thought", currentId, err);
    return fail("Couldn't understand one of your thoughts just now. It will be tried again after your next save.", 500);
  }

  const { count: remaining, error: remainingError } = await supabase
    .from("thoughts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("understood_at", null);
  if (remainingError) {
    console.error("understand: couldn't count what's left", remainingError);
    return fail("Couldn't check what's left to understand. Please try again.", 500);
  }

  return reply({ ok: true, fingerprints: made, remaining: remaining ?? 0 });
}

// ── search ────────────────────────────────────────────────────────────

function firstLine(content: string): string {
  return (content ?? "").trim().split("\n")[0].trim().slice(0, 120);
}

async function search(
  supabase: any,
  rawQuery: unknown,
  fingerprint: (text: string) => Promise<number[]>,
): Promise<Response> {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) return reply({ ok: true, mode: "words only", results: [] });

  let embedding: number[] | null = null;
  try {
    embedding = await fingerprint(query);
  } catch (err) {
    console.error("understand: search fingerprint failed, using words only", err);
  }

  const { data: rows, error } = await supabase.rpc("search_brain", {
    query_text: query,
    query_embedding: embedding,
    match_count: 20,
  });
  if (error) {
    console.error("understand: search_brain failed", error);
    return fail("Search isn't working right now. Please try again in a moment.", 500);
  }

  const results = rows ?? [];
  const ids: string[] = results.map((r: any) => String(r.thought_id));
  const relatedFor = new Map<string, { id: string; first_line: string }[]>();

  if (ids.length > 0) {
    try {
      const idList = ids.join(",");
      const { data: links, error: linkError } = await supabase
        .from("thought_links")
        .select("thought_a, thought_b, similarity")
        .or(`thought_a.in.(${idList}),thought_b.in.(${idList})`);
      if (linkError) throw linkError;

      // Each result keeps its two most similar links.
      const picks = new Map<string, string[]>();
      const needed = new Set<string>();
      for (const id of ids) {
        const others: string[] = (links ?? [])
          .filter((l: any) => l.thought_a === id || l.thought_b === id)
          .sort((x: any, y: any) => y.similarity - x.similarity)
          .slice(0, 2)
          .map((l: any) => (l.thought_a === id ? l.thought_b : l.thought_a));
        picks.set(id, others);
        others.forEach((o) => needed.add(o));
      }

      if (needed.size > 0) {
        const { data: others, error: otherError } = await supabase
          .from("thoughts")
          .select("id, content")
          .in("id", [...needed]);
        if (otherError) throw otherError;
        const lineById = new Map<string, string>(
          (others ?? []).map((t: any) => [String(t.id), firstLine(t.content)] as [string, string]),
        );
        for (const [id, otherIds] of picks) {
          relatedFor.set(
            id,
            otherIds.filter((o) => lineById.has(o)).map((o) => ({ id: o, first_line: lineById.get(o)! })),
          );
        }
      }
    } catch (err) {
      console.error("understand: couldn't load related thoughts", err);
    }
  }

  return reply({
    ok: true,
    mode: embedding ? "meaning and words" : "words only",
    results: results.map((r: any) => ({
      id: r.thought_id,
      source: r.source,
      created_at: r.created_at,
      first_line: firstLine(r.content),
      preview: (r.content ?? "").slice(0, 300),
      passage: r.passage ?? null,
      related: relatedFor.get(String(r.thought_id)) ?? [],
    })),
  });
}

// ── The request itself ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("Only POST requests are accepted.", 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", publicKey(req), {
      global: { headers: { Authorization: authHeader } },
    });

    if (!token) return fail("Please sign in again.", 401);
    const { data: userData } = await supabase.auth.getUser(token);
    const user = userData?.user;
    if (!user) return fail("Please sign in again.", 401);

    let body: any = null;
    try {
      body = await req.json();
    } catch (_) {
      body = null;
    }

    const fingerprint = makeFingerprinter();
    if (body?.action === "catch-up") return await catchUp(supabase, user.id, fingerprint);
    if (body?.action === "search") return await search(supabase, body.query, fingerprint);
    return fail("Unknown action.", 400);
  } catch (err) {
    console.error("understand: unexpected failure", err);
    return fail("Something went wrong on the server. Please try again.", 500);
  }
});
