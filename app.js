// My Brain · app.js · Stage 3 · Understand
// config.js must load first: it provides SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// A second client with no session, used only by Lock check to act as a stranger.
const stranger = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: "lock-check" },
});

const MAX_THOUGHT_CHARS = 20000;
const SOURCE_LABELS = { note: "Note", app: "Note", voice: "Voice", link: "Link", video: "Video", pdf: "PDF" };
const $ = (id) => document.getElementById(id);

function setStatus(message) {
  $("status").textContent = message;
}

function shortDate(value) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

// ── Views follow sign-in state ─────────────────────────────────────────
let currentUserId = null;
client.auth.onAuthStateChange((_event, session) => {
  const userId = session?.user?.id ?? null;
  $("signin-view").hidden = Boolean(userId);
  $("brain-view").hidden = !userId;
  if (userId && userId !== currentUserId) {
    setTimeout(loadRecent, 0);
    setTimeout(catchUp, 0);
  }
  if (!userId) {
    $("recent").replaceChildren();
    setStatus("");
    $("lock-result").textContent = "";
    $("understanding").textContent = "";
    clearSearch();
  }
  currentUserId = userId;
});

// ── Sign in and sign out ───────────────────────────────────────────────
$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("signin-error").textContent = "";
  $("signin-button").disabled = true;
  const { error } = await client.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  $("signin-button").disabled = false;
  if (error) {
    $("signin-error").textContent = error.message;
  } else {
    $("password").value = "";
  }
});

$("signout-button").addEventListener("click", async () => {
  await client.auth.signOut();
});

// ── Tabs ───────────────────────────────────────────────────────────────
const TABS = ["write", "link", "video", "pdf", "search"];
function selectTab(name) {
  for (const tab of TABS) {
    const selected = tab === name;
    $(`tab-${tab}`).setAttribute("aria-selected", String(selected));
    $(`panel-${tab}`).hidden = !selected;
  }
  // While Search is open, Recent is hidden.
  $("recent-section").hidden = name === "search";
}
for (const tab of TABS) {
  $(`tab-${tab}`).addEventListener("click", () => selectTab(tab));
}

// ── Saving any thought ─────────────────────────────────────────────────
// The database fills in user_id, and its locks decide what may be saved.
async function saveThought(content, source, metadata) {
  const row = { content, source };
  if (metadata) row.metadata = metadata;
  const { data, error } = await client.from("thoughts").insert(row).select("id").single();
  if (error) {
    setStatus(error.code === "23505" ? "Already in your brain" : `Couldn't save: ${error.message}`);
    return { ok: false };
  }
  return { ok: true, id: data.id };
}

// Calls a server function and always comes back with { ok, ... } or { ok: false, error }.
async function callFunction(name, body) {
  try {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      let message = "";
      try {
        if (error.context && typeof error.context.json === "function") {
          const reply = await error.context.json();
          message = reply?.error || reply?.message || "";
        }
      } catch {
        // The reply wasn't JSON.
      }
      return { ok: false, error: message || "Something went wrong. Please try again." };
    }
    if (!data || data.ok !== true) {
      return { ok: false, error: data?.error || "Something went wrong. Please try again." };
    }
    return data;
  } catch {
    return { ok: false, error: "We couldn't reach your server function. Check your connection and try again." };
  }
}

// ── Understanding: keep the brain up to date in the background ─────────
// One catch-up at a time. A save during a catch-up makes it go around once more.
const PAUSED = "Understanding paused. It will try again after your next save.";
let catchUpRunning = false;
let catchUpWanted = false;

function setUnderstanding(message) {
  $("understanding").textContent = message;
}

async function catchUp() {
  if (!currentUserId) return;
  catchUpWanted = true;
  if (catchUpRunning) return;
  catchUpRunning = true;
  const userId = currentUserId;
  if (!$("understanding").textContent.startsWith("Understanding your brain…")) {
    setUnderstanding("Understanding your brain…");
  }
  try {
    while (catchUpWanted) {
      catchUpWanted = false;
      let previous = Infinity;
      while (true) {
        if (currentUserId !== userId) return;
        const result = await callFunction("understand", { action: "catch-up" });
        if (currentUserId !== userId) return;
        if (!result.ok) {
          catchUpWanted = false;
          setUnderstanding(PAUSED);
          return;
        }
        const remaining = Number(result.remaining) || 0;
        if (remaining <= 0) break;
        // Nothing new done and nothing fewer left: stop rather than ask forever.
        if (!result.fingerprints && remaining >= previous) {
          catchUpWanted = false;
          setUnderstanding(PAUSED);
          return;
        }
        previous = remaining;
        setUnderstanding(`Understanding your brain… ${remaining} to go`);
      }
    }
    setUnderstanding("Up to date");
  } finally {
    catchUpRunning = false;
    // Someone else signed in while this one was running: start theirs.
    if (currentUserId && currentUserId !== userId) setTimeout(catchUp, 0);
  }
}

// Every successful save or update: clear the panel, confirm, reload Recent, catch up.
function afterSave(message) {
  setStatus(message);
  loadRecent();
  catchUp();
}

// ── Write (typed or spoken) ────────────────────────────────────────────
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let ignoreResults = false;
let textBefore = "";
let spokenFinal = "";
let lastShown = null;
let usedVoice = false;

function joinText(before, spoken) {
  return [before.trimEnd(), spoken.trim()].filter(Boolean).join(" ");
}

function updateMicButton() {
  $("mic-button").textContent = listening ? "⏹ Listening… click to stop" : "🎙️ Speak";
  $("mic-button").setAttribute("aria-pressed", String(listening));
}

if (Recognition) {
  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (event) => {
    if (ignoreResults) return;
    let inProgress = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) spokenFinal += result[0].transcript + " ";
      else inProgress += result[0].transcript;
    }
    const spoken = spokenFinal + inProgress;
    if (spoken.trim()) usedVoice = true;
    lastShown = joinText(textBefore, spoken);
    $("note-text").value = lastShown;
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setStatus("The microphone isn't allowed. Allow it for this site in your browser, or type instead.");
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      setStatus(`Voice stopped (${event.error}). You can try again, or type instead.`);
    }
  };

  recognition.onend = () => {
    listening = false;
    updateMicButton();
    if (!ignoreResults && lastShown !== null && $("note-text").value === lastShown) {
      $("note-text").value = joinText(textBefore, spokenFinal);
    }
    ignoreResults = false;
  };
} else {
  $("mic-button").disabled = true;
  $("mic-note").textContent = "Voice isn't available in this browser. On a phone, use the microphone on your keyboard.";
  $("mic-note").hidden = false;
}

$("mic-button").addEventListener("click", () => {
  if (!recognition) return;
  if (listening) {
    recognition.stop();
    return;
  }
  textBefore = $("note-text").value;
  spokenFinal = "";
  lastShown = null;
  ignoreResults = false;
  try {
    recognition.start();
    listening = true;
    updateMicButton();
  } catch {
    setStatus("The microphone couldn't start. Please try again.");
  }
});

$("note-text").addEventListener("input", () => {
  if (!$("note-text").value.trim()) usedVoice = false;
});

$("note-save").addEventListener("click", async () => {
  if (listening) {
    ignoreResults = true;
    recognition.abort();
  }
  const text = $("note-text").value.trim();
  if (!text) {
    setStatus("Type or say something first.");
    return;
  }
  $("note-save").disabled = true;
  const wasVoice = usedVoice;
  const result = await saveThought(text, wasVoice ? "voice" : "note");
  $("note-save").disabled = false;
  if (!result.ok) return;
  $("note-text").value = "";
  usedVoice = false;
  afterSave(wasVoice ? "Saved your voice note." : "Saved your note.");
});

// ── Link ───────────────────────────────────────────────────────────────
$("link-save").addEventListener("click", async () => {
  const url = $("link-url").value.trim();
  if (!url) {
    setStatus("Paste a web address first.");
    return;
  }
  $("link-save").disabled = true;
  setStatus("Reading the page…");
  const result = await callFunction("capture-link", { url });
  $("link-save").disabled = false;
  if (!result.ok) {
    setStatus(result.error);
    return;
  }
  if (result.duplicate) {
    setStatus("Already in your brain");
    return;
  }
  $("link-url").value = "";
  afterSave(`Saved: ${result.title}`);
});

// ── Video ──────────────────────────────────────────────────────────────
let pendingVideo = null; // the reply for a video that still needs its transcript

function hideTranscriptBox() {
  pendingVideo = null;
  $("transcript-text").value = "";
  $("transcript-box").hidden = true;
}

$("video-save").addEventListener("click", async () => {
  const url = $("video-url").value.trim();
  if (!url) {
    setStatus("Paste a YouTube link first.");
    return;
  }
  hideTranscriptBox();
  $("video-save").disabled = true;
  setStatus("Fetching the video…");
  const result = await callFunction("capture-video", { url });
  $("video-save").disabled = false;
  if (!result.ok) {
    setStatus(result.error);
    return;
  }
  const needsTranscript = result.has_transcript === false && Boolean(result.id);
  if (result.duplicate) {
    setStatus("Already in your brain");
  } else {
    afterSave(`Saved: ${result.title}`);
  }
  if (needsTranscript) {
    pendingVideo = result;
    $("transcript-box").hidden = false;
  } else {
    $("video-url").value = "";
  }
});

$("transcript-save").addEventListener("click", async () => {
  if (!pendingVideo) return;
  const pasted = $("transcript-text").value.trim();
  if (!pasted) {
    setStatus("Paste the transcript first.");
    return;
  }
  const video = pendingVideo;
  $("transcript-save").disabled = true;
  const content = `${video.title}\n${video.url}\n\n${pasted.slice(0, MAX_THOUGHT_CHARS)}`;
  const metadata = {
    video_id: video.video_id,
    title: video.title,
    channel: video.channel ?? null,
    has_transcript: true,
  };
  const { data, error } = await client
    .from("thoughts")
    .update({ content, metadata })
    .eq("id", video.id)
    .select("id");
  if (error || !data || data.length === 0) {
    $("transcript-save").disabled = false;
    if (error?.code === "23505") setStatus("Already in your brain");
    else setStatus(error ? `Couldn't add the transcript: ${error.message}` : "Couldn't add the transcript. Please try again.");
    return;
  }
  const { error: sourceError } = await client
    .from("thought_sources")
    .insert({ thought_id: video.id, kind: "video_transcript", full_text: pasted });
  if (sourceError && sourceError.code !== "23505") {
    console.error("Saving the full transcript failed:", sourceError.message);
  }
  $("transcript-save").disabled = false;
  hideTranscriptBox();
  $("video-url").value = "";
  afterSave(`Transcript added: ${video.title}`);
});

// ── PDF (read in the browser; the file is never uploaded) ──────────────
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
let pdfResult = null; // { fileName, pages, text }

function resetPdf() {
  pdfResult = null;
  $("pdf-text").value = "";
  $("pdf-progress").value = 0;
  $("pdf-save").disabled = true;
}

function pageText(items) {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    text += item.str + (item.hasEOL ? "\n" : " ");
  }
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

$("pdf-file").addEventListener("change", async () => {
  resetPdf();
  const file = $("pdf-file").files[0];
  if (!file) return;
  if (!window.pdfjsLib) {
    setStatus("The PDF reader didn't load. Check your connection and refresh the page.");
    return;
  }
  setStatus("Reading the PDF…");
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      $("pdf-progress").value = Math.round((n / pdf.numPages) * 100);
    }
    const text = pages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      setStatus("We couldn't find any text in that PDF. It may be a scanned picture of pages.");
      return;
    }
    pdfResult = { fileName: file.name, pages: pdf.numPages, text };
    $("pdf-text").value = text;
    $("pdf-save").disabled = false;
    setStatus(`Read ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}. Look over the text, then click Save.`);
  } catch {
    setStatus("That file couldn't be read as a PDF.");
  }
});

$("pdf-save").addEventListener("click", async () => {
  if (!pdfResult) return;
  const { fileName, pages, text } = pdfResult;
  $("pdf-save").disabled = true;
  const content = `PDF: ${fileName}\n${text.slice(0, MAX_THOUGHT_CHARS)}`;
  const result = await saveThought(content, "pdf", { file_name: fileName, pages });
  if (!result.ok) {
    $("pdf-save").disabled = false;
    return;
  }
  if (text.length > MAX_THOUGHT_CHARS) {
    const { error } = await client
      .from("thought_sources")
      .insert({ thought_id: result.id, kind: "pdf", full_text: text });
    if (error) console.error("Saving the full PDF text failed:", error.message);
  }
  $("pdf-file").value = "";
  resetPdf();
  afterSave(`Saved: ${fileName}`);
});

// ── Cards (shared by Recent and Search) ────────────────────────────────
function metaRow(source, createdAt) {
  const meta = document.createElement("div");
  meta.className = "meta";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = SOURCE_LABELS[source] || source || "Note";
  const when = document.createElement("span");
  when.className = "muted";
  when.textContent = shortDate(createdAt);
  meta.append(tag, when);
  return meta;
}

function paragraph(className, text) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function messageItem(text, className) {
  const item = document.createElement("li");
  if (className) item.className = className;
  item.textContent = text;
  return item;
}

// ── Recent ─────────────────────────────────────────────────────────────
async function loadRecent() {
  const list = $("recent");
  const { data, error } = await client
    .from("thoughts")
    .select("id, content, source, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  list.replaceChildren();
  if (error) {
    list.append(messageItem(`Couldn't load your recent thoughts: ${error.message}`));
    return;
  }
  if (!data || data.length === 0) {
    list.append(messageItem("Nothing saved yet.", "muted"));
    return;
  }
  for (const thought of data) {
    const item = document.createElement("li");
    const content = thought.content || "";
    item.append(
      metaRow(thought.source, thought.created_at),
      paragraph("thought-text", content.length > 300 ? `${content.slice(0, 300)}…` : content),
    );
    list.append(item);
  }
}

// ── Search ─────────────────────────────────────────────────────────────
let searchTimer = null;
let latestSearch = 0;

function clearSearch() {
  clearTimeout(searchTimer);
  latestSearch++;
  $("search-text").value = "";
  $("search-state").textContent = "";
  $("search-note").hidden = true;
  $("search-results").replaceChildren();
}

function showResults(results) {
  const list = $("search-results");
  list.replaceChildren();
  for (const result of results) {
    const item = document.createElement("li");
    item.append(metaRow(result.source, result.created_at), paragraph("first-line", result.first_line || ""));
    if (result.passage) {
      item.append(paragraph("found-label", "Found inside:"), paragraph("thought-text", result.passage));
    } else {
      item.append(paragraph("thought-text", result.preview || ""));
    }
    if (Array.isArray(result.related) && result.related.length > 0) {
      item.append(paragraph("found-label", "Related:"));
      const related = document.createElement("ul");
      related.className = "related";
      for (const other of result.related) {
        const line = document.createElement("li");
        line.textContent = other.first_line || "";
        related.append(line);
      }
      item.append(related);
    }
    list.append(item);
  }
}

async function runSearch() {
  clearTimeout(searchTimer);
  const query = $("search-text").value.trim();
  const thisSearch = ++latestSearch;
  if (!query) {
    $("search-state").textContent = "";
    $("search-note").hidden = true;
    $("search-results").replaceChildren();
    return;
  }
  $("search-state").textContent = "Searching…";
  const result = await callFunction("understand", { action: "search", query });
  if (thisSearch !== latestSearch) return; // a newer search has started
  if (!result.ok) {
    $("search-state").textContent = result.error;
    return;
  }
  const results = Array.isArray(result.results) ? result.results : [];
  $("search-note").hidden = result.mode !== "words only";
  $("search-state").textContent = results.length === 0 ? "Nothing found yet." : "";
  showResults(results);
}

$("search-text").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 400);
});

$("search-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch();
  }
});

// ── Lock check: can a stranger with no session read any of the four tables? ──
$("lock-check").addEventListener("click", async () => {
  const result = $("lock-result");
  result.classList.remove("error");
  result.textContent = "Checking…";
  const checks = await Promise.all(
    ["thoughts", "thought_sources", "thought_passages", "thought_links"].map((table) =>
      stranger.from(table).select("*").limit(1),
    ),
  );
  const locked = checks.every(({ data, error }) => error || !data || data.length === 0);
  if (locked) {
    result.textContent = "Locked: someone with only the public key sees nothing.";
  } else {
    result.textContent = "Not locked. Stop and tell your coach.";
    result.classList.add("error");
  }
});
