// app.js: what the buttons do.
// Uses the two public values from config.js and holds no secrets.
// All the protection lives in the database's locks.

// One connection to your Supabase project.
const db = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// A second connection that is never signed in, used only by Lock check.
// It plays the part of a stranger who has just your public key.
const stranger = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, storageKey: 'lock-check' },
});

// ── The pieces of the page ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const signinView = $('signin-view');
const brainView = $('brain-view');
const signinForm = $('signin-form');
const emailInput = $('email');
const passwordInput = $('password');
const signinButton = $('signin-button');
const signinError = $('signin-error');
const signoutButton = $('signout-button');
const thoughtInput = $('thought');
const saveButton = $('save-button');
const saveStatus = $('save-status');
const recentList = $('recent-list');
const recentStatus = $('recent-status');
const lockButton = $('lock-button');
const lockResult = $('lock-result');

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

// ── Which screen to show ────────────────────────────────────────────────
let currentUserId = null;

function showView(session) {
  const userId = session?.user?.id ?? null;
  signinView.hidden = Boolean(userId);
  brainView.hidden = !userId;
  if (userId && userId !== currentUserId) {
    loadRecent();
  }
  if (!userId) {
    recentList.replaceChildren();
    recentStatus.textContent = '';
    saveStatus.textContent = '';
    lockResult.textContent = '';
  }
  currentUserId = userId;
}

// On load...
db.auth.getSession().then(({ data }) => showView(data.session));
// ...and whenever you sign in or out. (setTimeout lets Supabase finish its own work first.)
db.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => showView(session), 0);
});

// ── Sign in ─────────────────────────────────────────────────────────────
signinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  signinError.textContent = '';
  signinButton.disabled = true;
  try {
    const { error } = await db.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });
    if (error) {
      signinError.textContent = error.message;
    } else {
      passwordInput.value = '';
    }
  } catch (err) {
    signinError.textContent = err.message || 'Could not reach Supabase.';
  } finally {
    signinButton.disabled = false;
  }
});

// ── Save a thought ──────────────────────────────────────────────────────
async function saveThought() {
  const content = thoughtInput.value.trim();
  if (!content) return;

  saveButton.disabled = true;
  saveStatus.className = 'note';
  saveStatus.textContent = 'Saving…';

  try {
    // Only the text is sent. The database fills in who owns it (user_id).
    const { error } = await db.from('thoughts').insert({ content });

    if (error) {
      if (error.code === '23505') {
        saveStatus.textContent = 'Already in your brain';
      } else {
        saveStatus.className = 'note error';
        saveStatus.textContent = error.message;
      }
      return;
    }

    thoughtInput.value = '';
    saveStatus.textContent = 'Saved';
    loadRecent();
  } catch (err) {
    saveStatus.className = 'note error';
    saveStatus.textContent = err.message || 'Could not reach Supabase.';
  } finally {
    saveButton.disabled = false;
  }
}

saveButton.addEventListener('click', saveThought);
thoughtInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    saveThought();
  }
});

// ── Recent ──────────────────────────────────────────────────────────────
async function loadRecent() {
  const { data, error } = await db
    .from('thoughts')
    .select('id, content, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (!currentUserId) return; // signed out while loading

  if (error) {
    recentStatus.className = 'note error';
    recentStatus.textContent = error.message;
    return;
  }

  // textContent puts your words on the page as plain text, never as code.
  const items = data.map((thought) => {
    const item = document.createElement('li');
    const when = document.createElement('time');
    when.dateTime = thought.created_at;
    when.textContent = shortDate.format(new Date(thought.created_at));
    const text = document.createElement('p');
    text.textContent = thought.content;
    item.append(when, text);
    return item;
  });

  recentList.replaceChildren(...items);
  recentStatus.className = 'note';
  recentStatus.textContent = data.length ? '' : 'Nothing saved yet.';
}

// ── Lock check ──────────────────────────────────────────────────────────
lockButton.addEventListener('click', async () => {
  lockButton.disabled = true;
  lockResult.className = 'note';
  lockResult.textContent = 'Checking…';

  const { data, error } = await stranger.from('thoughts').select('id').limit(1);

  lockButton.disabled = false;
  if (error || !data || data.length === 0) {
    lockResult.textContent = 'Locked: someone with only the public key sees nothing.';
  } else {
    lockResult.className = 'note bad';
    lockResult.textContent = 'Not locked. Stop and tell your coach.';
  }
});

// ── Sign out ────────────────────────────────────────────────────────────
signoutButton.addEventListener('click', async () => {
  await db.auth.signOut();
  showView(null);
});