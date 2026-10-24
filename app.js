// My Brain · app.js · Stage 4 (Reach)
(() => {
  'use strict';

  const BASE_URL = SUPABASE_URL.replace(/\/+$/, '');
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  // ── Helpers ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const SOURCE_LABELS = {
    note: 'Note', app: 'Note', voice: 'Voice', link: 'Link',
    video: 'Video', pdf: 'PDF', claude: 'Claude'
  };
  const sourceLabel = (source) => SOURCE_LABELS[source] || 'Note';

  function shortDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function shortDateTime(iso) {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }
  function firstLine(text) {
    const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l !== '') || '';
    return line.slice(0, 120);
  }
  function clip(text, max) {
    const t = String(text || '');
    return t.length > max ? t.slice(0, max) + '…' : t;
  }
  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text || '';
    el.className = 'status' + (isError ? ' error' : '');
  }
  async function functionError(error, fallback) {
    try {
      if (error && error.context && typeof error.context.json === 'function') {
        const body = await error.context.json();
        if (body && (body.error || body.message)) return body.error || body.message;
      }
    } catch (e) { /* fall through */ }
    return fallback;
  }

  // ── Views and sign-in ───────────────────────────────────────────────────
  let currentUserId = null;

  client.auth.onAuthStateChange((event, session) => {
    const userId = session && session.user ? session.user.id : null;
    $('signin-view').hidden = !!userId;
    $('brain-view').hidden = !userId;
    if (userId && userId !== currentUserId) {
      currentUserId = userId;
      setTimeout(onSignedIn, 0);
    } else if (!userId && currentUserId) {
      currentUserId = null;
      onSignedOut();
    }
  });

  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('signin-button');
    $('signin-error').textContent = '';
    button.disabled = true;
    const { error } = await client.auth.signInWithPassword({
      email: $('email').value.trim(),
      password: $('password').value
    });
    button.disabled = false;
    if (error) {
      $('signin-error').textContent = error.message;
    } else {
      $('password').value = '';
    }
  });

  $('signout-button').addEventListener('click', () => {
    client.auth.signOut();
  });

  function onSignedIn() {
    loadRecent();
    loadKeys();
    catchUp();
  }

  function onSignedOut() {
    $('recent-list').replaceChildren();
    $('key-list').replaceChildren();
    $('search-results').replaceChildren();
    $('search-status').textContent = '';
    $('search-note').hidden = true;
    $('understanding').textContent = '';
    $('lock-result').textContent = '';
    $('key-address').value = '';
    $('key-box').hidden = true;
    setStatus('');
  }

  // ── Tabs ────────────────────────────────────────────────────────────────
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        const selected = t === tab;
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        $(t.dataset.panel).hidden = !selected;
      });
      $('recent-section').hidden = tab.id === 'tab-search';
      if (tab.id === 'tab-search') $('search-input').focus();
    });
  });

  // ── Saving a thought ────────────────────────────────────────────────────
  async function insertThought(row) {
    const { data, error } = await client.from('thoughts').insert(row).select('id').single();
    if (error) {
      if (error.code === '23505') return { duplicate: true };
      return { error };
    }
    return { id: data.id };
  }

  function afterSave(message) {
    setStatus(message);
    loadRecent();
    catchUp();
  }

  // ── Write ───────────────────────────────────────────────────────────────
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let listening = false;
  let usedVoice = false;
  let textBeforeListening = '';

  function setMicLabel() {
    $('mic-button').textContent = listening ? 'Listening… tap to stop' : 'Start listening';
  }

  if (!Speech) {
    $('mic-button').disabled = true;
    $('mic-note').textContent = "Voice isn't available in this browser. On a phone, use the microphone on your keyboard.";
    $('mic-note').hidden = false;
  }

  function stopListening() {
    if (recognizer && listening) recognizer.stop();
  }

  $('mic-button').addEventListener('click', () => {
    if (!Speech) return;
    if (listening) {
      stopListening();
      return;
    }
    const box = $('note-text');
    textBeforeListening = box.value.trim() === '' ? '' : box.value.replace(/\s*$/, ' ');
    recognizer = new Speech();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.onresult = (event) => {
      let finished = '';
      let inProgress = '';
      for (let i = 0; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finished += piece;
        else inProgress += piece;
      }
      if ((finished + inProgress).trim() !== '') usedVoice = true;
      box.value = textBeforeListening + finished + inProgress;
    };
    recognizer.onend = () => {
      listening = false;
      setMicLabel();
    };
    recognizer.onerror = () => {
      listening = false;
      setMicLabel();
    };
    try {
      recognizer.start();
      listening = true;
      setMicLabel();
    } catch (e) {
      listening = false;
      setMicLabel();
    }
  });

  $('note-save').addEventListener('click', async () => {
    stopListening();
    const text = $('note-text').value.trim();
    if (text === '') {
      setStatus('Write something first.', true);
      return;
    }
    const button = $('note-save');
    button.disabled = true;
    const result = await insertThought({ content: text, source: usedVoice ? 'voice' : 'note' });
    button.disabled = false;
    if (result.error) {
      setStatus(result.error.message, true);
      return;
    }
    $('note-text').value = '';
    usedVoice = false;
    afterSave(result.duplicate ? 'Already in your brain' : 'Saved to your brain.');
  });

  // ── Link ────────────────────────────────────────────────────────────────
  $('link-save').addEventListener('click', async () => {
    const url = $('link-url').value.trim();
    if (url === '') {
      setStatus('Paste a web address first.', true);
      return;
    }
    const button = $('link-save');
    button.disabled = true;
    setStatus('Reading the page…');
    const { data, error } = await client.functions.invoke('capture-link', { body: { url } });
    button.disabled = false;
    if (error) {
      setStatus(await functionError(error, "That page couldn't be saved."), true);
      return;
    }
    $('link-url').value = '';
    afterSave(data && data.duplicate ? 'Already in your brain' : 'Saved: ' + ((data && data.title) || url));
  });

  // ── Video ───────────────────────────────────────────────────────────────
  let pendingVideo = null;

  $('video-save').addEventListener('click', async () => {
    const url = $('video-url').value.trim();
    if (url === '') {
      setStatus('Paste a YouTube link first.', true);
      return;
    }
    const button = $('video-save');
    button.disabled = true;
    setStatus('Fetching the video…');
    const { data, error } = await client.functions.invoke('capture-video', { body: { url } });
    button.disabled = false;
    if (error) {
      setStatus(await functionError(error, "That video couldn't be saved."), true);
      return;
    }
    $('video-url').value = '';
    afterSave(data.duplicate ? 'Already in your brain' : 'Saved: ' + (data.title || url));
    if (data.has_transcript === false) {
      pendingVideo = {
        id: data.id,
        title: data.title || '',
        link: data.url || data.link || url,
        video_id: data.video_id,
        channel: data.channel
      };
      $('transcript-hint').textContent =
        'On YouTube, click …more under the video, then Show transcript. Select the transcript, copy it and paste it here.';
      $('transcript-text').value = '';
      $('transcript-area').hidden = false;
    } else {
      pendingVideo = null;
      $('transcript-area').hidden = true;
    }
  });

  $('transcript-save').addEventListener('click', async () => {
    if (!pendingVideo) return;
    const text = $('transcript-text').value.trim();
    if (text === '') {
      setStatus('Paste the transcript first.', true);
      return;
    }
    const button = $('transcript-save');
    button.disabled = true;
    const content = pendingVideo.title + '\n' + pendingVideo.link + '\n\n' + text.slice(0, 20000);
    const metadata = {
      video_id: pendingVideo.video_id,
      title: pendingVideo.title,
      channel: pendingVideo.channel,
      has_transcript: true
    };
    const { error } = await client.from('thoughts').update({ content, metadata }).eq('id', pendingVideo.id);
    if (error) {
      button.disabled = false;
      setStatus(error.code === '23505' ? 'Already in your brain' : error.message, error.code !== '23505');
      return;
    }
    const sourceResult = await client.from('thought_sources').insert({
      thought_id: pendingVideo.id,
      kind: 'video_transcript',
      full_text: text
    });
    button.disabled = false;
    if (sourceResult.error && sourceResult.error.code !== '23505') {
      setStatus(sourceResult.error.message, true);
      return;
    }
    pendingVideo = null;
    $('transcript-text').value = '';
    $('transcript-area').hidden = true;
    afterSave('Transcript saved.');
  });

  // ── PDF ─────────────────────────────────────────────────────────────────
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  let pdfData = null;

  $('pdf-file').addEventListener('change', async () => {
    const file = $('pdf-file').files[0];
    pdfData = null;
    $('pdf-save').disabled = true;
    $('pdf-text').value = '';
    $('pdf-progress').value = 0;
    if (!file) return;
    if (!window.pdfjsLib) {
      setStatus("The PDF reader didn't load. Reload the page and try again.", true);
      return;
    }
    setStatus('Reading the PDF…');
    try {
      const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let pageText = '';
        content.items.forEach((item) => {
          pageText += item.str + (item.hasEOL ? '\n' : ' ');
        });
        pages.push(pageText.trim());
        $('pdf-progress').value = i / doc.numPages;
      }
      const text = pages.join('\n\n').trim();
      $('pdf-text').value = text;
      if (text === '') {
        setStatus('No text found in this PDF. It may be a scanned picture.', true);
        return;
      }
      pdfData = { name: file.name, pages: doc.numPages, text };
      $('pdf-save').disabled = false;
      setStatus('Check the text, then press Save.');
    } catch (e) {
      console.error('PDF read failed');
      setStatus("That PDF couldn't be read.", true);
    }
  });

  $('pdf-save').addEventListener('click', async () => {
    if (!pdfData) return;
    const button = $('pdf-save');
    button.disabled = true;
    const result = await insertThought({
      content: 'PDF: ' + pdfData.name + '\n' + pdfData.text.slice(0, 20000),
      source: 'pdf',
      metadata: { file_name: pdfData.name, pages: pdfData.pages }
    });
    if (result.error) {
      button.disabled = false;
      setStatus(result.error.message, true);
      return;
    }
    if (result.id && pdfData.text.length > 20000) {
      const sourceResult = await client.from('thought_sources').insert({
        thought_id: result.id,
        kind: 'pdf',
        full_text: pdfData.text
      });
      if (sourceResult.error && sourceResult.error.code !== '23505') {
        button.disabled = false;
        setStatus(sourceResult.error.message, true);
        return;
      }
    }
    const name = pdfData.name;
    pdfData = null;
    $('pdf-file').value = '';
    $('pdf-text').value = '';
    $('pdf-progress').value = 0;
    afterSave(result.duplicate ? 'Already in your brain' : 'Saved: ' + name);
  });

  // ── Recent ──────────────────────────────────────────────────────────────
  async function loadRecent() {
    const { data, error } = await client
      .from('thoughts')
      .select('id, content, source, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      setStatus(error.message, true);
      return;
    }
    const list = $('recent-list');
    list.replaceChildren();
    data.forEach((t) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = sourceLabel(t.source);
      const when = document.createElement('span');
      when.textContent = shortDateTime(t.created_at);
      meta.append(tag, when);
      const body = document.createElement('div');
      body.textContent = clip(t.content, 300);
      li.append(meta, body);
      list.append(li);
    });
  }

  $('refresh-button').addEventListener('click', () => {
    loadRecent();
    catchUp();
  });

  // ── Understanding ───────────────────────────────────────────────────────
  let catchingUp = false;
  let goAgain = false;

  async function catchUp() {
    if (catchingUp) {
      goAgain = true;
      return;
    }
    catchingUp = true;
    const line = $('understanding');
    try {
      do {
        goAgain = false;
        while (currentUserId) {
          const { data, error } = await client.functions.invoke('understand', { body: { action: 'catch-up' } });
          if (error) {
            line.textContent = 'Understanding paused. It will try again after your next save.';
            goAgain = false;
            return;
          }
          const remaining = Number(data && data.remaining) || 0;
          if (remaining > 0) {
            line.textContent = 'Understanding your brain… ' + remaining + ' to go';
          } else {
            line.textContent = 'Up to date';
            break;
          }
        }
      } while (goAgain && currentUserId);
    } finally {
      catchingUp = false;
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────
  let searchTimer = null;
  let searchNumber = 0;

  async function runSearch() {
    clearTimeout(searchTimer);
    const query = $('search-input').value.trim();
    const mine = ++searchNumber;
    const results = $('search-results');
    if (query === '') {
      results.replaceChildren();
      $('search-status').textContent = '';
      $('search-note').hidden = true;
      return;
    }
    $('search-status').textContent = 'Searching…';
    const { data, error } = await client.functions.invoke('understand', { body: { action: 'search', query } });
    if (mine !== searchNumber) return;
    if (error) {
      $('search-status').textContent = await functionError(error, "Search didn't work. Try again in a minute.");
      return;
    }
    const found = (data && data.results) || [];
    $('search-note').hidden = !(data && data.mode === 'words only');
    results.replaceChildren();
    if (found.length === 0) {
      $('search-status').textContent = 'Nothing found yet.';
      return;
    }
    $('search-status').textContent = '';
    found.forEach((r) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = sourceLabel(r.source);
      const when = document.createElement('span');
      when.textContent = r.created_at ? shortDate(r.created_at) : '';
      meta.append(tag, when);
      const title = document.createElement('div');
      title.className = 'first-line';
      title.textContent = r.first_line || firstLine(r.content);
      li.append(meta, title);

      const detail = document.createElement('div');
      detail.className = 'sub';
      if (r.passage) {
        const label = document.createElement('span');
        label.className = 'sub-label';
        label.textContent = 'Found inside: ';
        const text = document.createElement('span');
        text.textContent = r.passage;
        detail.append(label, text);
        li.append(detail);
      } else {
        const preview = r.preview || clip(r.content, 300);
        if (preview) {
          detail.textContent = preview;
          li.append(detail);
        }
      }

      if (Array.isArray(r.related) && r.related.length > 0) {
        const rel = document.createElement('div');
        rel.className = 'sub';
        const label = document.createElement('span');
        label.className = 'sub-label';
        label.textContent = 'Related: ';
        const text = document.createElement('span');
        text.textContent = r.related.map((x) => x.first_line || firstLine(x.content)).join('; ');
        rel.append(label, text);
        li.append(rel);
      }
      results.append(li);
    });
  }

  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 400);
  });
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });

  // ── Connections ─────────────────────────────────────────────────────────
  async function loadKeys() {
    const { data, error } = await client
      .from('connection_keys')
      .select('id, label, created_at, last_used_at')
      .order('created_at', { ascending: false });
    if (error) {
      setStatus(error.message, true);
      return;
    }
    const list = $('key-list');
    list.replaceChildren();
    if (data.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No keys yet.';
      list.append(li);
      return;
    }
    data.forEach((k) => {
      const li = document.createElement('li');
      li.className = 'key-row';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'first-line';
      name.textContent = k.label;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'made ' + shortDate(k.created_at) + ' · ' +
        (k.last_used_at ? 'last used ' + shortDateTime(k.last_used_at) : 'never used');
      info.append(name, meta);

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Disconnect';
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
        const { error: delError } = await client.from('connection_keys').delete().eq('id', k.id);
        if (delError) {
          button.disabled = false;
          armed = false;
          button.textContent = 'Disconnect';
          setStatus(delError.message, true);
          return;
        }
        loadKeys();
      });
      li.append(info, button);
      list.append(li);
    });
  }

  function base64url(bytes) {
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return 'brain_' + base64url(bytes);
  }

  $('make-key').addEventListener('click', async () => {
    const button = $('make-key');
    const label = $('key-name').value.trim() || 'Claude';
    button.disabled = true;
    try {
      const key = randomKey();
      const keyHash = await sha256Hex(key);
      const { error } = await client.from('connection_keys').insert({ label, key_hash: keyHash });
      if (error) {
        setStatus(error.message, true);
        return;
      }
      $('key-name').value = '';
      $('key-address').value = BASE_URL + '/functions/v1/brain-connector/' + key;
      $('key-box').hidden = false;
      loadKeys();
    } catch (e) {
      setStatus("The key couldn't be made in this browser.", true);
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
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    } catch (e) {
      field.focus();
      field.select();
    }
  });

  $('key-done').addEventListener('click', () => {
    $('key-address').value = '';
    $('key-box').hidden = true;
  });

  // ── Lock check ──────────────────────────────────────────────────────────
  let stranger = null;

  $('lock-check').addEventListener('click', async () => {
    const result = $('lock-result');
    result.className = '';
    result.textContent = 'Checking…';
    if (!stranger) {
      stranger = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'lock-check' }
      });
    }
    const tables = ['thoughts', 'thought_sources', 'thought_passages', 'thought_links', 'connection_keys'];
    let locked = true;
    for (const table of tables) {
      const { data, error } = await stranger.from(table).select('*').limit(1);
      if (!error && Array.isArray(data) && data.length > 0) locked = false;
    }
    const madeUp = randomKey();
    const door = await stranger.rpc('door_count', { p_key: madeUp });
    if (!door.error) locked = false;

    if (locked) {
      result.className = 'ok';
      result.textContent = 'Locked: someone with only the public key sees nothing, and the door turns away a made-up key.';
    } else {
      result.className = 'error';
      result.textContent = 'Not locked. Stop and tell your coach.';
    }
  });
})();