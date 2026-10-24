// My Brain · Stage 5 · app.js
// Everything the page does. Text from thoughts, labels and keys always goes on
// the page with textContent, never innerHTML.

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (id) => document.getElementById(id);

const KINDS = ['do', 'idea', 'know', 'ask', 'keep', 'life'];
const KIND_NAMES = { do: 'Do', idea: 'Idea', know: 'Know', ask: 'Ask', keep: 'Keep', life: 'Life' };
const SOURCE_NAMES = { note: 'Note', app: 'Note', voice: 'Voice', link: 'Link', video: 'Video', pdf: 'PDF', claude: 'Claude' };
const MAX_CONTENT = 20000;
const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let signedInAs = null;
let filter = 'all';
let topic = null;
let recentSeq = 0;
let catchingUp = false;
let catchUpAgain = false;
let labeling = false;
let labelAgain = false;
let lookBackChecked = false;
let searchSeq = 0;
let searchTimer = null;
let pendingVideo = null;
let pdfDone = null;
let lockClient = null;

// ── Small helpers ───────────────────────────────────────────────────────
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setStatus(text) {
  $('status').textContent = text;
}

function shortDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortDateTime(value) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0];
}

function sourceName(source) {
  return SOURCE_NAMES[source] || source || 'Note';
}

function waitingText(count) {
  return `${count} ${count === 1 ? 'thought' : 'thoughts'} waiting for labels.`;
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomKey() {
  return 'brain_' + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Calls one of your Supabase functions. Returns its reply, or
// { ok: false, error } with the function's own error sentence.
async function callFunction(name, body) {
  try {
    const { data, error } = await db.functions.invoke(name, { body });
    if (error) {
      let message = error.message || 'Something went wrong.';
      try {
        const details = await error.context.json();
        if (details && details.error) message = details.error;
      } catch (_) {
        // keep the general message
      }
      return { ok: false, error: message };
    }
    if (data && data.ok === false) return { ok: false, error: data.error || 'Something went wrong.' };
    return data || {};
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Something went wrong.' };
  }
}

function autoOn() {
  try {
    return localStorage.getItem('auto-reflect') !== 'off';
  } catch (_) {
    return true;
  }
}

// ── Views and signing in ────────────────────────────────────────────────
function showView(user) {
  $('signin-view').hidden = !!user;
  $('brain-view').hidden = !user;
  if (!user) {
    signedInAs = null;
    $('key-address').value = '';
    $('key-box').hidden = true;
    return;
  }
  if (user.id === signedInAs) return;
  signedInAs = user.id;
  lookBackChecked = false;
  $('auto-reflect').checked = autoOn();
  updateFilters();
  loadRecent();
  loadAiUse();
  loadKeys();
  catchUp();
}

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('signin-button');
  button.disabled = true;
  $('signin-error').textContent = '';
  const { error } = await db.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value,
  });
  button.disabled = false;
  if (error) $('signin-error').textContent = error.message;
  else $('password').value = '';
});

$('signout').addEventListener('click', () => db.auth.signOut());

// ── Tabs ────────────────────────────────────────────────────────────────
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));

function selectTab(id) {
  for (const tab of tabs) {
    const on = tab.id === id;
    tab.setAttribute('aria-selected', String(on));
    $(tab.dataset.panel).hidden = !on;
  }
  $('browse').hidden = id === 'tab-search';
  if (id === 'tab-search') $('search-input').focus();
}

tabs.forEach((tab) => tab.addEventListener('click', () => selectTab(tab.id)));

// ── Saving ──────────────────────────────────────────────────────────────
async function saveThought(content, source, metadata) {
  const row = { content, source };
  if (metadata) row.metadata = metadata;
  const { data, error } = await db.from('thoughts').insert(row).select('id').single();
  if (error) {
    setStatus(error.code === '23505' ? 'Already in your brain' : error.message);
    return null;
  }
  return data.id;
}

function afterSave(message) {
  setStatus(message);
  loadRecent();
  catchUp();
}

// ── Write and voice ─────────────────────────────────────────────────────
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
let heardVoice = false;
let textBeforeVoice = '';

function showMicLabel() {
  $('mic').textContent = listening ? 'Listening… tap to stop' : 'Start voice';
}

if (!Recognition) {
  $('mic').disabled = true;
  $('mic-help').textContent = "Voice isn't available in this browser. On a phone, use the microphone on your keyboard.";
  $('mic-help').hidden = false;
} else {
  recognizer = new Recognition();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.onresult = (event) => {
    let heard = '';
    for (let i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
    heard = heard.trim();
    if (!heard) return;
    heardVoice = true;
    $('note').value = textBeforeVoice ? textBeforeVoice + ' ' + heard : heard;
  };
  recognizer.onend = () => {
    listening = false;
    showMicLabel();
  };
  recognizer.onerror = () => {
    listening = false;
    showMicLabel();
  };
}

$('mic').addEventListener('click', () => {
  if (!recognizer) return;
  if (listening) {
    recognizer.stop();
    return;
  }
  textBeforeVoice = $('note').value.trim();
  try {
    recognizer.start();
    listening = true;
  } catch (_) {
    listening = false;
  }
  showMicLabel();
});

$('save-note').addEventListener('click', async () => {
  if (recognizer && listening) recognizer.abort();
  const content = $('note').value.trim();
  if (!content) return;
  const button = $('save-note');
  button.disabled = true;
  const id = await saveThought(content, heardVoice ? 'voice' : 'note');
  button.disabled = false;
  if (id) {
    $('note').value = '';
    heardVoice = false;
    textBeforeVoice = '';
    afterSave('Saved.');
  }
});

// ── Link ────────────────────────────────────────────────────────────────
$('save-link').addEventListener('click', async () => {
  const url = $('link-url').value.trim();
  if (!url) return;
  const button = $('save-link');
  button.disabled = true;
  setStatus('Reading the page…');
  const reply = await callFunction('capture-link', { url });
  button.disabled = false;
  if (reply.ok === false) {
    setStatus(reply.error);
    return;
  }
  $('link-url').value = '';
  if (reply.duplicate) {
    setStatus('Already in your brain');
    return;
  }
  afterSave('Saved: ' + (reply.title || url));
});

// ── Video ───────────────────────────────────────────────────────────────
$('save-video').addEventListener('click', async () => {
  const url = $('video-url').value.trim();
  if (!url) return;
  const button = $('save-video');
  button.disabled = true;
  setStatus('Fetching the video…');
  const reply = await callFunction('capture-video', { url });
  button.disabled = false;
  if (reply.ok === false) {
    setStatus(reply.error);
    return;
  }
  $('video-url').value = '';
  if (reply.duplicate) setStatus('Already in your brain');
  else afterSave('Saved: ' + (reply.title || url));
  if (reply.has_transcript === false) {
    pendingVideo = reply;
    $('transcript').value = '';
    $('transcript-box').hidden = false;
  } else {
    pendingVideo = null;
    $('transcript-box').hidden = true;
  }
});

$('save-transcript').addEventListener('click', async () => {
  const pasted = $('transcript').value.trim();
  if (!pasted || !pendingVideo) return;
  const video = pendingVideo;
  const link = video.url || video.link || '';
  const button = $('save-transcript');
  button.disabled = true;
  const { error } = await db
    .from('thoughts')
    .update({
      content: `${video.title}\n${link}\n\n${pasted.slice(0, MAX_CONTENT)}`,
      metadata: { video_id: video.video_id, title: video.title, channel: video.channel, has_transcript: true },
    })
    .eq('id', video.id);
  if (error) {
    button.disabled = false;
    setStatus(error.code === '23505' ? 'Already in your brain' : error.message);
    return;
  }
  const { error: sourceError } = await db
    .from('thought_sources')
    .insert({ thought_id: video.id, kind: 'video_transcript', content: pasted });
  button.disabled = false;
  pendingVideo = null;
  $('transcript').value = '';
  $('transcript-box').hidden = true;
  afterSave('Transcript saved.');
  if (sourceError) setStatus("Transcript saved, but the full copy wasn't: " + sourceError.message);
});

// ── PDF ─────────────────────────────────────────────────────────────────
if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

$('pdf-file').addEventListener('change', async () => {
  const file = $('pdf-file').files[0];
  pdfDone = null;
  $('pdf-review').hidden = true;
  if (!file) return;
  const progress = $('pdf-progress');
  progress.max = 1;
  progress.value = 0;
  progress.hidden = false;
  setStatus('Reading the PDF…');
  try {
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    progress.max = pdf.numPages;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const textContent = await page.getTextContent();
      pages.push(textContent.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim());
      progress.value = n;
    }
    const text = pages.join('\n\n').trim();
    pdfDone = { fileName: file.name, pages: pdf.numPages, text };
    $('pdf-text').value = text;
    $('pdf-review').hidden = false;
    setStatus(text ? 'Check the text, then press Save.' : 'No text found in this PDF.');
  } catch (_) {
    setStatus("Couldn't read that PDF.");
  }
});

$('save-pdf').addEventListener('click', async () => {
  if (!pdfDone || !pdfDone.text) return;
  const { fileName, pages, text } = pdfDone;
  const button = $('save-pdf');
  button.disabled = true;
  const id = await saveThought(`PDF: ${fileName}\n${text.slice(0, MAX_CONTENT)}`, 'pdf', { file_name: fileName, pages });
  let sourceError = null;
  if (id && text.length > MAX_CONTENT) {
    const { error } = await db.from('thought_sources').insert({ thought_id: id, kind: 'pdf', content: text });
    sourceError = error;
  }
  button.disabled = false;
  if (!id) return;
  pdfDone = null;
  $('pdf-file').value = '';
  $('pdf-text').value = '';
  $('pdf-review').hidden = true;
  $('pdf-progress').hidden = true;
  afterSave('Saved: ' + fileName);
  if (sourceError) setStatus("Saved, but the full text wasn't: " + sourceError.message);
});

// ── Recent and filters ──────────────────────────────────────────────────
function cardLabel(row) {
  if (row.metadata && row.metadata.kind === 'look-back') return 'Look-back';
  if (KIND_NAMES[row.category]) return KIND_NAMES[row.category];
  return sourceName(row.source);
}

function topicButtons(tags, onPick) {
  const box = make('div', 'topics');
  for (const t of tags || []) {
    const button = make('button', 'topic', t);
    button.type = 'button';
    button.addEventListener('click', () => onPick(t));
    box.append(button);
  }
  return box;
}

function thoughtCard(row) {
  const card = make('li', 'card');
  const meta = make('div', 'meta');
  meta.append(make('span', 'tag', cardLabel(row)), make('span', null, shortDateTime(row.created_at)));
  card.append(meta);
  if (row.summary) card.append(make('p', 'gist', row.summary));
  const full = row.content || '';
  const short = full.length > 300 ? full.slice(0, 300) + '…' : full;
  const text = make('button', 'text', short);
  text.type = 'button';
  if (full.length > 300) {
    text.setAttribute('aria-expanded', 'false');
    text.addEventListener('click', () => {
      const open = text.getAttribute('aria-expanded') === 'true';
      text.textContent = open ? short : full;
      text.setAttribute('aria-expanded', String(!open));
    });
  }
  card.append(text);
  if (row.tags && row.tags.length) card.append(topicButtons(row.tags, chooseTopic));
  return card;
}

async function loadRecent() {
  const seq = ++recentSeq;
  let query = db
    .from('thoughts')
    .select('id, content, source, created_at, category, tags, summary, metadata')
    .order('created_at', { ascending: false })
    .limit(20);
  if (KINDS.includes(filter)) query = query.eq('category', filter);
  if (filter === 'look-backs') query = query.eq('metadata->>kind', 'look-back');
  if (topic) query = query.contains('tags', [topic]);
  const { data, error } = await query;
  if (seq !== recentSeq) return;
  const list = $('recent');
  list.replaceChildren();
  if (error) {
    list.append(make('li', 'quiet', error.message));
    return;
  }
  if (!data.length) {
    list.append(make('li', 'quiet', 'Nothing here yet.'));
    return;
  }
  for (const row of data) list.append(thoughtCard(row));
}

function updateFilters() {
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  });
  $('topic-filter').hidden = !topic;
  $('topic-filter').textContent = topic ? 'Topic: ' + topic : '';
  $('write-look-back').hidden = filter !== 'look-backs';
}

function chooseTopic(t) {
  topic = t;
  updateFilters();
  loadRecent();
}

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    updateFilters();
    loadRecent();
  });
});

$('topic-filter').addEventListener('click', () => {
  topic = null;
  updateFilters();
  loadRecent();
});

$('refresh').addEventListener('click', () => {
  loadRecent();
  catchUp();
});

// ── Understanding ───────────────────────────────────────────────────────
async function catchUp() {
  if (catchingUp) {
    catchUpAgain = true;
    return;
  }
  catchingUp = true;
  const line = $('understanding-line');
  let failed = false;
  try {
    do {
      catchUpAgain = false;
      line.textContent = 'Understanding your brain…';
      for (;;) {
        const reply = await callFunction('understand', { action: 'catch-up' });
        if (reply.ok === false) {
          failed = true;
          break;
        }
        const remaining = Number(reply.remaining || 0);
        if (remaining <= 0) break;
        line.textContent = `Understanding your brain… ${remaining} to go`;
      }
    } while (catchUpAgain && !failed);
  } finally {
    catchingUp = false;
  }
  if (failed) {
    line.textContent = 'Understanding paused. It will try again after your next save.';
    return;
  }
  line.textContent = 'Up to date';
  startLabeling();
}

// ── Labeling ────────────────────────────────────────────────────────────
async function showWaiting() {
  const { count, error } = await db
    .from('thoughts')
    .select('id', { count: 'exact', head: true })
    .is('processed_at', null);
  if (!error) $('labels-line').textContent = waitingText(count || 0);
}

async function startLabeling() {
  if (!autoOn()) {
    showWaiting();
    return;
  }
  if (labeling) {
    labelAgain = true;
    return;
  }
  labeling = true;
  const line = $('labels-line');
  let failed = false;
  try {
    do {
      labelAgain = false;
      line.textContent = 'Labeling…';
      for (;;) {
        if (!autoOn()) break;
        const reply = await callFunction('reflect', { action: 'label' });
        if (reply.ok === false) {
          failed = true;
          line.textContent = 'Labels paused: ' + reply.error;
          break;
        }
        const waiting = Number(reply.waiting || 0);
        const labeled = Number(reply.labeled || 0);
        loadRecent();
        loadAiUse();
        if (waiting <= 0) {
          line.textContent = 'Every thought has labels.';
          break;
        }
        if (labeled <= 0) {
          line.textContent = waitingText(waiting);
          break;
        }
        line.textContent = `Labeling… ${waiting} to go`;
      }
    } while (labelAgain && !failed && autoOn());
  } finally {
    labeling = false;
  }
  if (!autoOn()) {
    showWaiting();
    return;
  }
  if (!failed) maybeLookBack();
}

// ── Look-backs ──────────────────────────────────────────────────────────
async function maybeLookBack() {
  if (lookBackChecked || !autoOn()) return;
  lookBackChecked = true;
  const reply = await callFunction('reflect', { action: 'look-back', only_if_due: true });
  if (reply.ok === false) return;
  loadAiUse();
  if (reply.written) {
    setStatus('A new look-back is ready.');
    loadRecent();
  }
}

$('write-look-back').addEventListener('click', async () => {
  const button = $('write-look-back');
  button.disabled = true;
  setStatus('Writing your look-back…');
  const reply = await callFunction('reflect', { action: 'look-back', only_if_due: false });
  button.disabled = false;
  if (reply.ok === false) {
    setStatus(reply.error);
    return;
  }
  loadAiUse();
  if (reply.written) {
    setStatus('Your look-back is ready.');
    loadRecent();
  } else {
    setStatus(reply.reason || '');
  }
});

// ── AI use ──────────────────────────────────────────────────────────────
async function loadAiUse() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const { data, error } = await db.from('ai_receipts').select('cost_usd').gte('created_at', monthStart.toISOString());
  const line = $('ai-use-line');
  if (error) {
    line.textContent = error.message;
    return;
  }
  const calls = data.length;
  if (calls === 0) {
    line.textContent = 'No AI calls this month.';
    return;
  }
  const total = data.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
  const amount = total > 0 && total < 0.01 ? 'under $0.01' : 'about $' + total.toFixed(2);
  line.textContent = `This month: ${calls} ${calls === 1 ? 'call' : 'calls'}, ${amount}`;
}

$('auto-reflect').addEventListener('change', () => {
  try {
    localStorage.setItem('auto-reflect', $('auto-reflect').checked ? 'on' : 'off');
  } catch (_) {
    // this browser can't remember the setting
  }
  startLabeling();
});

// ── Search ──────────────────────────────────────────────────────────────
function searchCard(result) {
  const node = make('li', 'card');
  const meta = make('div', 'meta');
  const tag = make('span', 'tag', sourceName(result.source));
  const when = result.created_at || result.saved;
  meta.append(tag, make('span', null, when ? shortDateTime(when) : ''));
  node.append(meta);
  const gistSlot = make('div');
  node.append(gistSlot);
  node.append(make('p', 'found', result.first_line || firstLine(result.content || result.preview)));
  if (result.passage) {
    const found = make('div', 'found');
    found.append(make('strong', null, 'Found inside:'), make('span', null, result.passage));
    node.append(found);
  } else if (result.preview) {
    node.append(make('p', 'quiet', result.preview));
  }
  const related = Array.isArray(result.related) ? result.related : [];
  if (related.length) {
    const box = make('div', 'found');
    box.append(make('strong', null, 'Related:'));
    const items = make('ul');
    for (const r of related) {
      const line = typeof r === 'string' ? r : r.first_line || firstLine(r.content || r.preview);
      items.append(make('li', null, line));
    }
    box.append(items);
    node.append(box);
  }
  const topicSlot = make('div');
  node.append(topicSlot);
  return {
    node,
    addLabels(row) {
      if (KIND_NAMES[row.category]) tag.textContent = KIND_NAMES[row.category];
      if (row.summary) gistSlot.replaceChildren(make('p', 'gist', row.summary));
      if (row.tags && row.tags.length) {
        topicSlot.replaceChildren(topicButtons(row.tags, (t) => {
          selectTab('tab-write');
          chooseTopic(t);
        }));
      }
    },
  };
}

async function runSearch() {
  const query = $('search-input').value.trim();
  const seq = ++searchSeq;
  const list = $('search-results');
  const status = $('search-status');
  if (!query) {
    list.replaceChildren();
    status.textContent = '';
    $('search-note').hidden = true;
    return;
  }
  status.textContent = 'Searching…';
  const reply = await callFunction('understand', { action: 'search', query });
  if (seq !== searchSeq) return;
  list.replaceChildren();
  if (reply.ok === false) {
    status.textContent = reply.error;
    return;
  }
  const results = Array.isArray(reply.results) ? reply.results : [];
  $('search-note').hidden = reply.mode !== 'words only';
  if (!results.length) {
    status.textContent = 'Nothing found yet.';
    return;
  }
  status.textContent = '';
  const cards = new Map();
  for (const result of results) {
    const card = searchCard(result);
    cards.set(result.id, card);
    list.append(card.node);
  }
  const { data } = await db
    .from('thoughts')
    .select('id, category, tags, summary')
    .in('id', results.map((r) => r.id));
  if (seq !== searchSeq || !data) return;
  for (const row of data) {
    const card = cards.get(row.id);
    if (card) card.addLabels(row);
  }
}

$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 400);
});

$('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(searchTimer);
    runSearch();
  }
});

// ── Connections ─────────────────────────────────────────────────────────
function keyRow(key) {
  const row = make('li', 'card');
  row.append(make('strong', null, key.label));
  const used = key.last_used_at ? 'last used ' + shortDateTime(key.last_used_at) : 'never used';
  row.append(make('p', 'quiet', `made ${shortDate(key.created_at)} · ${used}`));
  const button = make('button', null, 'Disconnect');
  button.type = 'button';
  let armed = false;
  let timer = null;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Tap again to disconnect';
      timer = setTimeout(() => {
        armed = false;
        button.textContent = 'Disconnect';
      }, 4000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    const { error } = await db.from('connection_keys').delete().eq('id', key.id);
    if (error) setStatus(error.message);
    loadKeys();
  });
  const actions = make('div', 'row');
  actions.append(button);
  row.append(actions);
  return row;
}

async function loadKeys() {
  const { data, error } = await db
    .from('connection_keys')
    .select('id, label, created_at, last_used_at')
    .order('created_at', { ascending: false });
  const list = $('keys');
  list.replaceChildren();
  if (error) {
    list.append(make('li', 'quiet', error.message));
    return;
  }
  if (!data.length) {
    list.append(make('li', 'quiet', 'No keys yet.'));
    return;
  }
  for (const key of data) list.append(keyRow(key));
}

$('make-key').addEventListener('click', async () => {
  const button = $('make-key');
  const label = $('key-name').value.trim() || 'Claude';
  button.disabled = true;
  try {
    const key = randomKey();
    const keyHash = await sha256Hex(key);
    const { error } = await db.from('connection_keys').insert({ label, key_hash: keyHash });
    if (error) {
      setStatus(error.message);
      return;
    }
    $('key-name').value = '';
    $('key-address').value = SUPABASE_URL + '/functions/v1/brain-connector/' + key;
    $('key-box').hidden = false;
    loadKeys();
  } finally {
    button.disabled = false;
  }
});

$('copy-key').addEventListener('click', async () => {
  const field = $('key-address');
  const button = $('copy-key');
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 2000);
  } catch (_) {
    field.focus();
    field.select();
  }
});

$('key-done').addEventListener('click', () => {
  $('key-address').value = '';
  $('key-box').hidden = true;
});

// ── Lock check ──────────────────────────────────────────────────────────
$('lock-check').addEventListener('click', async () => {
  const button = $('lock-check');
  const result = $('lock-result');
  button.disabled = true;
  result.classList.remove('error');
  result.textContent = 'Checking…';
  if (!lockClient) {
    lockClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'lock-check' },
    });
  }
  const tables = ['thoughts', 'thought_sources', 'thought_passages', 'thought_links', 'connection_keys', 'ai_receipts'];
  let locked = true;
  for (const table of tables) {
    const { data, error } = await lockClient.from(table).select('*').limit(1);
    if (!error && data && data.length > 0) locked = false;
  }
  const door = await lockClient.rpc('door_count', { p_key: randomKey() });
  if (!door.error) locked = false;
  button.disabled = false;
  if (locked) {
    result.textContent = 'Locked: someone with only the public key sees nothing, and the door turns away a made-up key.';
  } else {
    result.textContent = 'Not locked. Stop and tell your coach.';
    result.classList.add('error');
  }
});

// ── Start ───────────────────────────────────────────────────────────────
showMicLabel();
updateFilters();
db.auth.onAuthStateChange((_event, session) => {
  // Let Supabase finish its own work before the app makes more calls.
  setTimeout(() => showView(session ? session.user : null), 0);
});