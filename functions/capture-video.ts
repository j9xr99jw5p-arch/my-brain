// capture-video · Stage 2 · Capture
// Saves a YouTube video (title, channel, link and, when it can, the transcript)
// for the signed-in person. It acts as that person, so the database's two locks
// still decide what it can save.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_THOUGHT_CHARS = 20000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

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

// Pick the 11-character video id out of the link shapes YouTube uses.
function videoIdFrom(raw: string): string | null {
  let link: URL;
  try {
    link = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = link.hostname.toLowerCase();
  const parts = link.pathname.split("/").filter(Boolean);
  let id: string | null | undefined = null;
  if (host === "youtu.be") {
    id = parts[0];
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (parts[0] === "watch") id = link.searchParams.get("v");
    else if (["shorts", "embed", "live"].includes(parts[0])) id = parts[1];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

// Title and channel from YouTube's oEmbed address.
async function videoDetails(cleanLink: string, videoId: string): Promise<{ title: string; channel: string | null }> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(cleanLink)}&format=json`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const data = await res.json();
      const title = typeof data?.title === "string" ? data.title.trim() : "";
      const channel = typeof data?.author_name === "string" && data.author_name.trim()
        ? data.author_name.trim()
        : null;
      if (title) return { title, channel };
    } else {
      console.error("capture-video: YouTube's oEmbed replied with status", res.status);
    }
  } catch (err) {
    console.error("capture-video: YouTube's oEmbed failed:", err instanceof Error ? err.message : err);
  }
  return { title: `YouTube video ${videoId}`, channel: null };
}

function asText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((piece) => (piece && typeof piece.text === "string" ? piece.text : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

// The transcript, only when a SUPADATA_API_KEY secret is set. Empty string means none.
async function fetchTranscript(cleanLink: string): Promise<string> {
  const key = Deno.env.get("SUPADATA_API_KEY");
  if (!key) return "";
  try {
    const query = new URLSearchParams({ url: cleanLink, text: "true", mode: "native" });
    const res = await fetch(`https://api.supadata.ai/v1/transcript?${query}`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 200) {
      const data = await res.json();
      return asText(data?.content);
    }
    if (res.status === 202) {
      const data = await res.json();
      const jobId = typeof data?.jobId === "string" ? data.jobId : "";
      if (!jobId) return "";
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await fetch(`https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`, {
          headers: { "x-api-key": key },
          signal: AbortSignal.timeout(10000),
        });
        if (!poll.ok) {
          console.error("capture-video: transcript job check replied with status", poll.status);
          return "";
        }
        const job = await poll.json();
        if (job?.status === "completed") return asText(job.content);
        if (job?.status === "failed") return "";
      }
      console.error("capture-video: transcript job didn't finish within 20 seconds");
      return "";
    }
    console.error("capture-video: transcript service replied with status", res.status);
    return "";
  } catch (err) {
    console.error("capture-video: transcript lookup failed:", err instanceof Error ? err.message : err);
    return "";
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
    const user = userData.user;

    // The video
    let body: { url?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const raw = typeof body.url === "string" ? body.url.trim() : "";
    const videoId = videoIdFrom(raw);
    if (!videoId) return fail(400, "That doesn't look like a YouTube link.");
    const cleanLink = `https://www.youtube.com/watch?v=${videoId}`;

    // Already saved? Then save nothing new.
    const { data: existing, error: lookupError } = await supabase
      .from("thoughts")
      .select("id, metadata")
      .eq("user_id", user.id)
      .eq("metadata->>video_id", videoId)
      .limit(1)
      .maybeSingle();
    if (lookupError) {
      console.error("capture-video: looking for an earlier save failed:", lookupError.message);
    }
    if (existing) {
      const meta = existing.metadata ?? {};
      return reply(200, {
        ok: true,
        duplicate: true,
        id: existing.id,
        title: typeof meta.title === "string" && meta.title ? meta.title : `YouTube video ${videoId}`,
        url: cleanLink,
        video_id: videoId,
        channel: meta.channel ?? null,
        has_transcript: meta.has_transcript === true,
      });
    }

    // Title, channel and, when possible, the transcript
    const { title, channel } = await videoDetails(cleanLink, videoId);
    const transcript = await fetchTranscript(cleanLink);
    const hasTranscript = transcript.length > 0;

    // Save the thought, as the signed-in person
    let content = `${title}\n${cleanLink}`;
    if (hasTranscript) content += `\n\n${transcript.slice(0, MAX_THOUGHT_CHARS)}`;
    const { data: thought, error: insertError } = await supabase
      .from("thoughts")
      .insert({
        content,
        source: "video",
        metadata: { video_id: videoId, title, channel, has_transcript: hasTranscript },
      })
      .select("id")
      .single();
    if (insertError) {
      if (insertError.code === "23505") return reply(200, { ok: true, duplicate: true, title });
      console.error("capture-video: saving the thought failed:", insertError.message);
      return fail(500, "We couldn't save that to your brain. Please try again.");
    }

    // Save the full transcript on the shelf
    if (hasTranscript) {
      const { error: sourceError } = await supabase
        .from("thought_sources")
        .insert({ thought_id: thought.id, kind: "video_transcript", full_text: transcript });
      if (sourceError) {
        console.error("capture-video: saving the full transcript failed:", sourceError.message);
      }
    }

    return reply(200, {
      ok: true,
      id: thought.id,
      title,
      url: cleanLink,
      video_id: videoId,
      channel,
      has_transcript: hasTranscript,
    });
  } catch (err) {
    console.error("capture-video: unexpected error:", err instanceof Error ? err.message : err);
    return fail(500, "Something went wrong on our side. Please try again.");
  }
});