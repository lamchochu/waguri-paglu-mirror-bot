/**
 * Cloudflare Worker for Multi-User Telegram to Google Drive Mirror Bot
 * - Normal Roboto (native Telegram UI text) for prose, labels, and names
 * - Monospace (<code> / <pre>) for filenames, metrics, commands, and system telemetry
 * - Native <blockquote> cards, <pre><code> blocks, and colored InlineKeyboardButtons
 */

export class StateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.ready = false;
  }

  ensureSchema() {
    if (this.ready) return;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS leech_del (job_id TEXT PRIMARY KEY, payload TEXT NOT NULL, exp INTEGER NOT NULL)');
    this.ready = true;
  }

  async rescheduleAlarm() {
    const rows = [...this.sql.exec('SELECT MIN(exp) AS next_exp FROM leech_del')];
    const nextExp = rows[0]?.next_exp;
    if (nextExp && Number(nextExp) > 0) {
      await this.state.storage.setAlarm(Number(nextExp));
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  async purgeLeechRecord(rec) {
    if (!rec?.chatId || !this.env?.TELEGRAM_BOT_TOKEN) return;
    const tok = this.env.TELEGRAM_BOT_TOKEN;
    const ids = Array.isArray(rec.fileMsgIds) ? rec.fileMsgIds.filter(Boolean) : [];
    for (const mid of ids) {
      await fetch(`https://api.telegram.org/bot${tok}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: rec.chatId, message_id: mid })
      }).catch(() => {});
    }
    if (rec.noticeMsgId) {
      await fetch(`https://api.telegram.org/bot${tok}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: rec.chatId,
          message_id: rec.noticeMsgId,
          text: `<blockquote><b>⌛ Auto-Deleted (30 Minutes)</b></blockquote>\n\n<i>Leeched file(s) have been automatically deleted after 30 minutes. Please forward files immediately next time to keep them safe.</i>`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] }
        })
      }).catch(() => {});
    }
  }

  async alarm() {
    this.ensureSchema();
    const now = Date.now();
    const due = [...this.sql.exec('SELECT job_id, payload FROM leech_del WHERE exp <= ?', now)];
    for (const row of due) {
      try {
        const rec = JSON.parse(row.payload);
        await this.purgeLeechRecord(rec);
      } catch (_) {}
      this.sql.exec('DELETE FROM leech_del WHERE job_id = ?', row.job_id);
      this.sql.exec('DELETE FROM kv WHERE k = ?', `leech_del:${row.job_id}`);
    }
    await this.rescheduleAlarm();
  }

  async fetch(request) {
    this.ensureSchema();
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === '/leech-schedule') {
      if (request.method === 'POST') {
        const rec = await request.json();
        if (rec?.jobId && rec?.expiresAt) {
          this.sql.exec(
            'INSERT OR REPLACE INTO leech_del (job_id, payload, exp) VALUES (?, ?, ?)',
            String(rec.jobId),
            JSON.stringify(rec),
            Number(rec.expiresAt)
          );
          await this.rescheduleAlarm();
        }
        return Response.json({ ok: true });
      }
      if (request.method === 'DELETE') {
        const jobId = url.searchParams.get('job_id') || '';
        if (jobId) {
          this.sql.exec('DELETE FROM leech_del WHERE job_id = ?', jobId);
          await this.rescheduleAlarm();
        }
        return Response.json({ ok: true });
      }
    }
    if (request.method === 'GET') {
      const k = url.searchParams.get('k') || '';
      const rows = [...this.sql.exec('SELECT v, exp FROM kv WHERE k = ?', k)];
      if (!rows.length) return new Response(null, { status: 404 });
      const row = rows[0];
      if (row.exp && row.exp <= now) {
        this.sql.exec('DELETE FROM kv WHERE k = ?', k);
        return new Response(null, { status: 404 });
      }
      return Response.json({ v: row.v });
    }
    if (request.method === 'POST') {
      const { k, v, ttlSec } = await request.json();
      const exp = ttlSec ? now + Number(ttlSec) * 1000 : null;
      this.sql.exec('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)', k, v, exp);
      if (Math.random() < 0.02) {
        this.sql.exec('DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?', now);
      }
      return Response.json({ ok: true });
    }
    if (request.method === 'DELETE') {
      const k = url.searchParams.get('k') || '';
      this.sql.exec('DELETE FROM kv WHERE k = ?', k);
      return Response.json({ ok: true });
    }
    return new Response('Method Not Allowed', { status: 405 });
  }
}

function getStore(env) {
  if (!env.STATE_DO) return env.SETTINGS_KV;
  const stub = env.STATE_DO.get(env.STATE_DO.idFromName('global'));
  const persistentKey = (k) =>
    k.startsWith('user:') ||
    k.startsWith('history:') ||
    k.startsWith('folder:') ||
    k.startsWith('auth:') ||
    k.startsWith('gc_') ||
    k.startsWith('stats:') ||
    k.startsWith('user_index:');
  return {
    async get(k) {
      const res = await stub.fetch(`https://state.do/kv?k=${encodeURIComponent(k)}`);
      if (res.ok) {
        const data = await res.json();
        return data.v;
      }
      if (env.SETTINGS_KV && persistentKey(k)) {
        const legacy = await env.SETTINGS_KV.get(k);
        if (legacy !== null) {
          await stub.fetch('https://state.do/kv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ k, v: legacy, ttlSec: null })
          }).catch(() => {});
          return legacy;
        }
      }
      return null;
    },
    async put(k, v, opts) {
      const res = await stub.fetch('https://state.do/kv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k, v: String(v), ttlSec: opts?.expirationTtl || null })
      });
      if (!res.ok) {
        throw new Error(`StateDO put failed (${res.status})`);
      }
    },
    async delete(k) {
      await stub.fetch(`https://state.do/kv?k=${encodeURIComponent(k)}`, { method: 'DELETE' });
      if (env.SETTINGS_KV && persistentKey(k)) {
        await env.SETTINGS_KV.delete(k).catch(() => {});
      }
    }
  };
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RUNNER_LIMIT_BYTES = 112 * 1024 * 1024 * 1024;
const MAX_BATCH_URLS = 50;
const MAX_HISTORY_ITEMS = 15;
const OWNER_ID = '8699286601';
const TG_BOT_MAX_BYTES = 2000 * 1024 * 1024;
const GC_TEMP_FOLDER_NAME = 'GC_Temp_5Days';
const GC_PERM_FOLDER_NAME = 'gcusrfiles';
const GC_TEMP_TTL_MS = 5 * 24 * 60 * 60 * 1000;
const PERM_REQ_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const GC_TEMP_NOTICE_HTML =
  `⚠ <b>Temporary Group Storage (5 Days):</b> File(s) will be deleted after <b>5 days</b>. ` +
  `Use /login with your personal Google Drive for permanent storage, or contact the Owner.`;
const GOFILE_NOTICE_HTML =
  `⚠ <b>Temporary Storage (Gofile):</b> Files are deleted after <b>100 GB download quota</b> or <b>10 days of inactivity</b>. ` +
  `Re-mirror from the original source to renew, or /login with your personal Google Drive for permanent storage.`;

const YT_QUALITY_LABELS = {
  best: 'Best Video',
  '2160': '4K (2160p)',
  '1440': '2K (1440p)',
  '1080': '1080p HD',
  '720': '720p HD',
  '480': '480p SD',
  '360': '360p',
  mp3: 'Audio MP3',
  m4a: 'Audio M4A',
  opus: 'Audio Opus',
  flac: 'Audio FLAC'
};
const YT_AUDIO_QUALITIES = new Set(['mp3', 'm4a', 'opus', 'flac']);
const YT_CONTAINERS = ['mp4', 'mkv', 'auto'];
const MEDIA_DOMAINS = new Set([
  'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'instagram.com', 'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
  'twitter.com', 'x.com', 'reddit.com', 'v.redd.it',
  'twitch.tv', 'clips.twitch.tv', 'vimeo.com', 'dailymotion.com',
  'soundcloud.com', 'facebook.com', 'fb.watch', 'bilibili.com',
  'rumble.com', 'odysee.com', 'kick.com', 'streamable.com'
]);

function ytQualityLabel(q) {
  return YT_QUALITY_LABELS[q] || 'Best Video';
}

function ytContainerLabel(c) {
  if (c === 'mkv') return 'MKV';
  if (c === 'auto') return 'Auto';
  return 'MP4';
}

function isMediaSiteUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (MEDIA_DOMAINS.has(host)) return true;
    for (const d of MEDIA_DOMAINS) {
      if (host.endsWith('.' + d)) return true;
    }
  } catch (_) {}
  return false;
}

function isPlaylistUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.pathname.includes('/playlist') || u.pathname.includes('/sets/') || u.pathname.includes('/album/');
  } catch (_) {
    return false;
  }
}

async function fetchMediaOEmbed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let oembedUrl = '';
    if (host.includes('youtube.com') || host === 'youtu.be') {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
    } else if (host === 'vimeo.com') {
      oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(rawUrl)}`;
    } else if (host === 'soundcloud.com') {
      oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
    }
    if (!oembedUrl) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(oembedUrl, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.title ? { title: String(data.title), author: String(data.author_name || '') } : null;
  } catch (_) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      return await handleOAuthCallback(url, env);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/internal/')) {
      return await handleInternalRunner(request, url.pathname, env);
    }

    if (request.method !== 'POST') {
      return new Response('Mirror Bot Webhook Active.', { status: 200 });
    }

    try {
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return new Response('OK', { status: 200 });
    } catch (err) {
      console.error('Webhook error:', err);
      return new Response('OK', { status: 200 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runGcExpiryCleanup(env));
  }
};

// ============================================================================
// GOOGLE OAUTH2 & DRIVE API HELPERS
// ============================================================================

function getWorkerBaseUrl(env) {
  return (env.WORKER_URL || 'https://telegram-gdrive-bot.davexh.workers.dev').replace(/\/$/, '');
}

async function createOAuthUrl(chatId, userId, username, env) {
  const state = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await getStore(env).put(
    `oauth_state:${state}`,
    JSON.stringify({ chatId, userId, username, createdAt: Date.now() }),
    { expirationTtl: 1800 }
  );

  const redirectUri = `${getWorkerBaseUrl(env)}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return htmlResponse('Authorization Cancelled', `Google returned: ${escapeHtml(error)}. You can close this window.`);
  }
  if (!code || !state) {
    return htmlResponse('Invalid Request', 'Missing OAuth code or state parameter.');
  }

  const stateRaw = await getStore(env).get(`oauth_state:${state}`);
  if (!stateRaw) {
    return htmlResponse('Session Expired', 'This authorization link has expired. Run /login again in Telegram.');
  }
  await getStore(env).delete(`oauth_state:${state}`);
  const stateData = JSON.parse(stateRaw);

  const redirectUri = `${getWorkerBaseUrl(env)}/oauth/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    return htmlResponse('Authorization Failed', 'Could not exchange authorization code. Please try /login again.');
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;

  let email = 'Connected Account';
  const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (aboutRes.ok) {
    const aboutData = await aboutRes.json();
    email = aboutData?.user?.emailAddress || aboutData?.user?.displayName || email;
  }

  const existing = await getUserProfile(stateData.userId, env);
  const finalRefresh = refreshToken || existing?.refreshToken;

  const userProfile = {
    userId: stateData.userId,
    chatId: stateData.chatId,
    username: stateData.username || '',
    email,
    refreshToken: finalRefresh,
    accessToken,
    tokenExpiry: Date.now() + ((tokenData.expires_in || 3500) - 120) * 1000,
    folderId: existing?.folderId || 'root',
    folderName: existing?.folderName || 'My Drive',
    defaultDest: 'gdrive',
    buttonMode: existing?.buttonMode !== undefined ? existing.buttonMode : true,
    autoShare: !!existing?.autoShare,
    conflict: existing?.conflict || 'rename',
    ytQuality: existing?.ytQuality || 'best',
    ytContainer: existing?.ytContainer || 'mp4'
  };

  await saveUserProfile(stateData.userId, userProfile, env);

  await sendMessage(
    stateData.chatId,
    `<blockquote><b>Drive Connected</b>\n\n<code>${escapeHtml(email)}</code></blockquote>\n\n` +
      `Select your default upload directory below:`,
    env
  );
  await openFolderBrowser(stateData.chatId, stateData.userId, 'root', null, null, env);

  return htmlResponse(
    'Google Drive Linked',
    `Connected as <b>${escapeHtml(email)}</b>.<br><br>Return to Telegram to choose your target folder.`
  );
}

async function getValidTokenInfo(userId, env, forceRefresh = false) {
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) return null;

  if (!forceRefresh && profile.accessToken && profile.tokenExpiry && Date.now() < profile.tokenExpiry) {
    return { accessToken: profile.accessToken, tokenExpiry: profile.tokenExpiry };
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: profile.refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;

  profile.accessToken = data.access_token;
  profile.tokenExpiry = Date.now() + ((data.expires_in || 3500) - 120) * 1000;
  await saveUserProfile(userId, profile, env);
  return { accessToken: profile.accessToken, tokenExpiry: profile.tokenExpiry };
}

async function getValidAccessToken(userId, env, forceRefresh = false) {
  const info = await getValidTokenInfo(userId, env, forceRefresh);
  return info ? info.accessToken : null;
}

async function getDriveQuota(accessToken) {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota,user(emailAddress)', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const q = data.storageQuota || {};
  const limit = q.limit ? parseInt(q.limit, 10) : null;
  const usage = q.usage ? parseInt(q.usage, 10) : 0;
  const free = limit !== null ? Math.max(0, limit - usage) : Infinity;
  return { limit, usage, free, email: data?.user?.emailAddress };
}

async function getUserProfile(userId, env) {
  const raw = await getStore(env).get(`user:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

function hasDriveAuth(profile) {
  return !!(profile && profile.refreshToken);
}

function getEffectiveProfile(userId, stored) {
  const base = stored || {};
  const hasDrive = hasDriveAuth(base);
  return {
    userId,
    email: base.email || '',
    refreshToken: base.refreshToken || '',
    accessToken: base.accessToken || '',
    tokenExpiry: base.tokenExpiry || 0,
    folderId: base.folderId || 'root',
    folderName: base.folderName || 'My Drive',
    defaultDest: hasDrive
      ? (['gofile', 'telegram'].includes(base.defaultDest) ? base.defaultDest : 'gdrive')
      : (base.defaultDest === 'telegram' ? 'telegram' : 'gofile'),
    leechAsDoc: !!base.leechAsDoc,
    buttonMode: base.buttonMode !== false,
    autoShare: !!base.autoShare,
    conflict: base.conflict || 'rename',
    ytQuality: base.ytQuality || 'best',
    ytContainer: base.ytContainer || 'mp4'
  };
}

async function saveUserProfile(userId, profile, env) {
  await getStore(env).put(`user:${userId}`, JSON.stringify(profile));
}

function friendlyDriveError(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('storagequotaexceeded') || t.includes('storage quota') || t.includes('quota for this drive')) {
    return 'Google Drive storage is full. Free up space and try again.';
  }
  if (
    t.includes('uploadlimit') ||
    t.includes('upload limit') ||
    t.includes('userratelimitexceeded') ||
    t.includes('user rate limit exceeded') ||
    t.includes('maxuploadedbytes')
  ) {
    return "Google Drive's daily upload limit (~750 GB / 24h) was reached. Try again later.";
  }
  if (t.includes('downloadquotaexceeded') || t.includes('download quota') || t.includes('dailylimitexceeded')) {
    return "The source file's Drive download quota is exhausted. Try again in ~24h.";
  }
  if (t.includes('cannotcopyfile') || t.includes('copyrequireswriterpermission') || t.includes('cannotdownloadfile')) {
    return 'The file owner has disabled copying / downloading for this file.';
  }
  if (t.includes('filenotfound') || t.includes('notfound') || t.includes('file not found')) {
    return 'Drive file not found, or it is not shared with your Google account.';
  }
  if (t.includes('insufficientfilepermissions') || t.includes('insufficientpermissions')) {
    return 'Your Google account has no permission to access this file.';
  }
  if (t.includes('invalid credentials') || t.includes('unauthenticated') || t.includes('token expired')) {
    return 'Google Drive authorization failed. Run /login again.';
  }
  return null;
}

function extractDriveApiError(errData, fallback) {
  const err = errData?.error || {};
  const reasons = (err.errors || []).map(e => e.reason || '').join(' ');
  const msg = err.message || '';
  return friendlyDriveError(`${reasons} ${msg}`) || (msg ? `${fallback}: ${msg}` : fallback);
}

function qEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDriveExisting(accessToken, parentId, name) {
  const parent = parentId || 'root';
  const q = `'${parent}' in parents and name = '${qEscape(name)}' and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,webViewLink,size)',
    pageSize: '10',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.files || [];
}

function splitFileName(name, isDir = false) {
  if (isDir) return [name, ''];
  const compound = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'];
  const low = name.toLowerCase();
  for (const suf of compound) {
    if (low.endsWith(suf) && name.length > suf.length) {
      return [name.slice(0, -suf.length), name.slice(-suf.length)];
    }
  }
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 10) {
    return [name.slice(0, dot), name.slice(dot)];
  }
  return [name, ''];
}

async function findFreeDriveName(accessToken, parentId, name, isDir = false) {
  const [base, ext] = splitFileName(name, isDir);
  for (let n = 1; n < 50; n++) {
    const cand = `${base} (${n})${ext}`;
    const found = await findDriveExisting(accessToken, parentId, cand);
    if (!found.length) return cand;
  }
  return `${base} (${Math.floor(Date.now() / 1000)})${ext}`;
}

async function makeDrivePublic(accessToken, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    }
  );
  return res.ok;
}

// ============================================================================
// INTERACTIVE GOOGLE DRIVE FOLDER BROWSER (/setdldir)
// ============================================================================

async function openFolderBrowser(chatId, userId, folderId, editMsgId = null, returnTaskId = null, env, page = 0, threadId = null) {
  const accessToken = await getValidAccessToken(userId, env);
  if (!accessToken) {
    await sendMessage(chatId, `Please connect your Google Drive first using /login.`, env, null, null, threadId);
    return;
  }

  const targetId = folderId || 'root';
  let folderName = 'My Drive';
  let parentId = null;

  if (targetId !== 'root') {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetId)}?fields=id,name,parents`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (metaRes.ok) {
      const meta = await metaRes.json();
      folderName = meta.name || 'Folder';
      parentId = (meta.parents && meta.parents[0]) ? meta.parents[0] : 'root';
    }
  }

  const q = `'${targetId}' in parents and trashed = false`;
  const rawFiles = [];
  let pageToken = '';
  for (let round = 0; round < 5; round++) {
    const listParams = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      orderBy: 'folder,name',
      pageSize: '200'
    });
    if (pageToken) listParams.set('pageToken', pageToken);

    const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!listRes.ok) break;
    const listData = await listRes.json();
    if (Array.isArray(listData.files)) rawFiles.push(...listData.files);
    if (!listData.nextPageToken) break;
    pageToken = listData.nextPageToken;
  }

  const items = rawFiles.map(f => ({
    id: f.id,
    name: f.name,
    isFolder: f.mimeType === FOLDER_MIME,
    size: f.size ? parseInt(f.size, 10) : 0
  }));

  const browserState = {
    currentId: targetId,
    currentName: folderName,
    parentId,
    page: 0,
    returnTaskId: returnTaskId || null,
    threadId: threadId || null,
    items
  };
  await renderFolderBrowserPage(chatId, userId, browserState, page, editMsgId, env);
}

async function renderFolderBrowserPage(chatId, userId, browserState, page, editMsgId, env) {
  const items = browserState.items || [];
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  browserState.page = safePage;
  await getStore(env).put(`browser:${userId}`, JSON.stringify(browserState), { expirationTtl: 3600 });

  const pageItems = items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rows = [];

  for (let i = 0; i < pageItems.length; i++) {
    const idx = safePage * pageSize + i;
    const item = pageItems[i];
    const prefix = item.isFolder ? '▸ ' : '• ';
    const label = `${prefix}${truncate(item.name, 34)}`;
    rows.push([{ text: label, callback_data: item.isFolder ? `fb_open:${idx}` : `fb_file:${idx}` }]);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) navRow.push({ text: '‹ Prev', callback_data: `fb_page:${safePage - 1}`, style: 'primary' });
    navRow.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: 'fb_noop' });
    if (safePage < totalPages - 1) navRow.push({ text: 'Next ›', callback_data: `fb_page:${safePage + 1}`, style: 'primary' });
    rows.push(navRow);
  }

  if (browserState.currentId !== 'root') {
    rows.push([{ text: '↑ Parent Directory', callback_data: 'fb_up', style: 'primary' }]);
  }

  rows.push([
    { text: '✓ Select Folder', callback_data: 'fb_sel', style: 'success' },
    { text: '+ New Folder', callback_data: 'fb_mkdir', style: 'primary' }
  ]);

  if (browserState.returnTaskId) {
    rows.push([{ text: '↩ Back to Task', callback_data: `fb_back:${browserState.returnTaskId}`, style: 'primary' }]);
  } else {
    rows.push([{ text: 'Close', callback_data: 'fb_close', style: 'danger' }]);
  }

  const folderCount = items.filter(x => x.isFolder).length;
  const fileCount = items.length - folderCount;
  const headerText =
    `<blockquote><b>Directory Browser</b>\n\n` +
    `${escapeHtml(browserState.currentName)}</blockquote>\n\n` +
    `Folders  ·  <code>${folderCount}</code>    Files  ·  <code>${fileCount}</code>\n\n` +
    `<i>Tap a subfolder to open it or confirm this location.</i>`;

  const markup = { inline_keyboard: rows };
  if (editMsgId) {
    await editMessage(chatId, editMsgId, headerText, env, markup);
  } else {
    await sendMessage(chatId, headerText, env, markup, null, browserState.threadId || null);
  }
}

// ============================================================================
// TASK OPTIONS MENU
// ============================================================================

function conflictLabel(policy) {
  if (policy === 'overwrite') return 'Overwrite';
  if (policy === 'skip') return 'Skip';
  return 'Rename';
}

function buildTaskMenuMessage(task) {
  const isGofile = task.dest === 'gofile';
  const isLeech = task.dest === 'telegram';
  let extras = '';
  if (task.batch) {
    extras += `\n✓ <b>Batch:</b> <code>${task.items.length} links</code>`;
    const gfCount = task.items.filter(i => i.type === 'gofile').length;
    if (gfCount > 0) {
      extras += `\n✓ <b>Gofile:</b> <code>${gfCount} link(s)</code>`;
    }
  } else if (task.isYtdl) {
    extras += `\n✓ <b>Media:</b> <code>${escapeHtml(truncate(task.detectedName || 'Media Link', 56))}</code>`;
    if (task.mediaAuthor) {
      extras += `\n✓ <b>Channel:</b> ${escapeHtml(task.mediaAuthor)}`;
    }
  } else if (task.isTgMedia) {
    extras += `\n✓ <b>File:</b> <code>${escapeHtml(truncate(task.detectedName || 'Telegram Media', 56))}</code>`;
    if (task.fileSize > 0) {
      extras += `\n✓ <b>Size:</b> <code>${fmtBytes(task.fileSize)}</code>`;
    }
    extras += `\n✓ <b>Source:</b> Telegram MTProto (Kurigram)`;
  } else if (task.isDrive) {
    extras += `\n✓ <b>Source:</b> ${task.isFolder ? 'Google Drive Folder' : ((isGofile || isLeech) ? 'Google Drive' : 'Google Drive (Server-Side)')}`;
  } else if (task.isGofileSource) {
    extras += `\n✓ <b>Source:</b> Gofile ${task.isFolder ? 'Folder' : 'File'}`;
    if (task.detectedName) {
      extras += `\n✓ <b>Name:</b> <code>${escapeHtml(truncate(task.detectedName, 56))}</code>`;
    }
    if (task.fileSize > 0) {
      extras += `\n✓ <b>Size:</b> <code>${fmtBytes(task.fileSize)}</code>`;
    }
    if (task.isFolder && task.gofileChildrenCount > 0) {
      extras += `\n✓ <b>Items:</b> <code>${task.gofileChildrenCount}</code>`;
    }
  } else if (task.resolvedVia) {
    extras += `\n✓ <b>Extracted:</b> ${escapeHtml(task.resolvedVia)}`;
  }
  if (task.isYtdl) {
    const q = task.ytQuality || 'best';
    const isAud = YT_AUDIO_QUALITIES.has(q);
    extras += `\n✓ <b>Quality:</b> <code>${ytQualityLabel(q)}${isAud ? '' : ` · ${ytContainerLabel(task.ytContainer || 'mp4')}`}</code>`;
    if (task.ytSubs) extras += `\n✓ <b>Subtitles:</b> <code>${escapeHtml(task.ytSubLang || 'en')}</code>`;
    if (task.ytMeta === false) extras += `\n✓ <b>Metadata:</b> Off`;
    if (task.ytSponsorBlock) extras += `\n✓ <b>SponsorBlock:</b> Remove segments`;
    if (task.ytPlaylist === 'all') {
      extras += `\n✓ <b>Playlist:</b> All${task.ytPlaylistItems ? ` (<code>${escapeHtml(task.ytPlaylistItems)}</code>)` : ''}`;
    }
    if (task.ytTrim) extras += `\n✓ <b>Trim:</b> <code>${escapeHtml(task.ytTrim)}</code>`;
  }
  if (task.customName) {
    extras += `\n✓ <b>Rename:</b> <code>${escapeHtml(task.customName)}</code>`;
  }
  if (task.mode === 'extract') {
    extras += `\n✓ <b>Mode:</b> Extract`;
  } else if (task.mode === 'zip') {
    extras += `\n✓ <b>Mode:</b> Create ZIP`;
  }
  if (task.selectFilter) {
    extras += `\n✓ <b>Select:</b> <code>${escapeHtml(task.selectFilter)}</code>`;
  }
  if (task.archivePassword) {
    extras += `\n✓ <b>Password:</b> <code>Set (hidden)</code>`;
  }
  if (isLeech) {
    extras += `\n✓ <b>Upload As:</b> ${task.leechAsDoc ? 'Document (Original File)' : 'Media (Stream Video / Audio)'}`;
  }
  if (!isGofile && !isLeech) {
    if (task.share) {
      extras += `\n✓ <b>Share:</b> Anyone with link`;
    }
    const conf = task.conflict || 'rename';
    if (conf !== 'rename' || task.duplicateExists) {
      extras += `\n✓ <b>On Duplicate:</b> ${conflictLabel(conf)}`;
    }
    if (task.duplicateExists && !task.batch && task.mode === 'normal') {
      extras += `\n⚠ <b>Duplicate:</b> Already exists in folder`;
    }
  }

  const destLine = isLeech
    ? `✓ <b>Destination:</b> Telegram (Leech to Chat)`
    : isGofile
      ? `✓ <b>Destination:</b> Gofile (New Guest Account)`
      : task.isSharedGcTemp
        ? `✓ <b>Destination:</b> Shared Group Drive (5-Day Temp)`
        : `✓ <b>Custom Upload:</b> ${escapeHtml(task.folderName || 'My Drive')}`;
  const leechWarnLines = [
    (!task.batch && task.fileSize >= TG_BOT_MAX_BYTES)
      ? `📤 <b>Telegram Leech (&gt; 2 GB):</b> Automatically splits into <code>1.95 GB</code> 7z parts before uploading to Telegram.`
      : `📤 <b>Telegram Leech:</b> Uploads directly to this chat (files &gt; <code>2.00 GB</code> auto-split into <code>1.95 GB</code> parts).`,
    `⚠️ <b>Copyright Warning:</b> Do not leech copyrighted content — it could get the group and bot both flagged or banned.${task.chatType === 'private' ? ' Files auto-delete in <b>30 min</b> in DM.' : ''}`
  ];
  const leechNoticeHtml = leechWarnLines.join('\n\n');
  const warnBlock = isLeech
    ? `\n\n<blockquote>${leechNoticeHtml}</blockquote>`
    : isGofile
      ? `\n\n<blockquote>${GOFILE_NOTICE_HTML}</blockquote>`
      : task.isSharedGcTemp
        ? `\n\n<blockquote>${GC_TEMP_NOTICE_HTML}</blockquote>`
        : '';

  return (
    `📌 <b>Choose option for your task?</b>\n\n` +
    `${destLine}${extras}${warnBlock}\n\n` +
    `⏰ <b>Timeout:</b> <code>2m40s</code>`
  );
}

function buildTaskMenuKeyboard(task) {
  const tid = task.taskId;
  const isGofile = task.dest === 'gofile';
  const isLeech = task.dest === 'telegram';
  const extLabel = task.mode === 'extract' ? '✓ Extract' : 'Extract';
  const zipLabel = task.mode === 'zip' ? '✓ Create ZIP' : 'Create ZIP';
  const renLabel = task.batch && task.mode === 'zip'
    ? (task.customName ? '✓ ZIP Name' : 'ZIP Name')
    : (task.customName ? '✓ Rename' : 'Rename');
  const selLabel = task.selectFilter ? '✓ Select' : 'Select';
  const passLabel = task.archivePassword ? '✓ Password' : 'Password';
  const shareLabel = task.share ? '✓ Share Link' : 'Share Link';
  const confText = `Duplicate: ${conflictLabel(task.conflict || 'rename')}`;
  const folderShort = truncate(task.driveFolderName || task.folderName || 'My Drive', 14);
  const destBtnText = isLeech
    ? '📤 Dest: Telegram (Leech)'
    : isGofile
      ? '☁️ Dest: Gofile (Temp)'
      : task.isSharedGcTemp
        ? '☁️ Dest: GC Drive (5d)'
        : '☁️ Dest: Google Drive';

  const rows = [
    [{ text: isLeech ? '▶️ START LEECH' : '▶️ START MIRROR', callback_data: `tm_start:${tid}`, style: 'success' }]
  ];

  const canRename = !task.batch || task.mode === 'zip';
  if (isLeech || isGofile || task.isSharedGcTemp) {
    if (canRename) {
      rows.push([
        { text: renLabel, callback_data: `tm_ren:${tid}` },
        { text: destBtnText, callback_data: `tm_dest:${tid}`, style: 'primary' }
      ]);
    } else {
      rows.push([{ text: destBtnText, callback_data: `tm_dest:${tid}`, style: 'primary' }]);
    }
  } else {
    rows.push([{ text: destBtnText, callback_data: `tm_dest:${tid}`, style: 'primary' }]);
    if (canRename) {
      if (task.hasDrive) {
        rows.push([
          { text: renLabel, callback_data: `tm_ren:${tid}` },
          { text: `Upload: ${folderShort}`, callback_data: `tm_dir:${tid}` }
        ]);
      } else {
        rows.push([{ text: renLabel, callback_data: `tm_ren:${tid}` }]);
      }
    } else if (task.hasDrive) {
      rows.push([{ text: `Upload: ${folderShort}`, callback_data: `tm_dir:${tid}` }]);
    }
  }

  if (isLeech) {
    const typeBtn = {
      text: task.leechAsDoc ? '📄 Upload As: Document' : '🎬 Upload As: Media (Auto)',
      callback_data: `tm_asdoc:${tid}`,
      style: 'primary'
    };
    rows.push([typeBtn]);
  }

  if (task.isYtdl) {
    const q = task.ytQuality || 'best';
    const isAud = YT_AUDIO_QUALITIES.has(q);
    const qualRow = [{ text: `🎬 Quality: ${ytQualityLabel(q)}`, callback_data: `tm_ytqual:${tid}`, style: 'primary' }];
    if (!isAud) {
      qualRow.push({ text: `Format: ${ytContainerLabel(task.ytContainer || 'mp4')}`, callback_data: `tm_ytcont:${tid}` });
    }
    rows.push(qualRow);

    if (!isAud) {
      const subRow = [{ text: task.ytSubs ? '✓ Subtitles' : 'Subtitles', callback_data: `tm_ytsubs:${tid}` }];
      if (task.ytSubs) {
        subRow.push({ text: `Lang: ${task.ytSubLang || 'en'}`, callback_data: `tm_ytslang:${tid}` });
      } else {
        subRow.push({ text: task.ytTrim ? `✓ Trim: ${task.ytTrim}` : '✂️ Trim', callback_data: `tm_yttrim:${tid}` });
      }
      rows.push(subRow);
      if (task.ytSubs) {
        rows.push([{ text: task.ytTrim ? `✓ Trim: ${task.ytTrim}` : '✂️ Trim Range', callback_data: `tm_yttrim:${tid}` }]);
      }
    } else {
      rows.push([{ text: task.ytTrim ? `✓ Trim: ${task.ytTrim}` : '✂️ Trim Range', callback_data: `tm_yttrim:${tid}` }]);
    }

    rows.push([
      { text: task.ytMeta !== false ? '✓ Meta & Thumb' : 'Meta & Thumb', callback_data: `tm_ytmeta:${tid}` },
      { text: task.ytSponsorBlock ? '✓ SponsorBlock' : 'SponsorBlock', callback_data: `tm_ytsb:${tid}` }
    ]);

    const plRow = [
      { text: task.ytPlaylist === 'all' ? '✓ Playlist: All' : 'Playlist: Single', callback_data: `tm_ytpl:${tid}` }
    ];
    if (task.ytPlaylist === 'all') {
      plRow.push({ text: task.ytPlaylistItems ? `✓ Items: ${task.ytPlaylistItems}` : 'Playlist Range', callback_data: `tm_ytplitems:${tid}` });
    } else {
      plRow.push({ text: zipLabel, callback_data: `tm_zip:${tid}` });
    }
    rows.push(plRow);

    if (task.ytPlaylist === 'all') {
      const zipRow = [{ text: zipLabel, callback_data: `tm_zip:${tid}` }];
      if (task.mode === 'zip') zipRow.push({ text: passLabel, callback_data: `tm_pass:${tid}` });
      rows.push(zipRow);
    } else if (task.mode === 'zip') {
      rows.push([{ text: passLabel, callback_data: `tm_pass:${tid}` }]);
    }
  } else {
    rows.push([
      { text: extLabel, callback_data: `tm_ext:${tid}` },
      { text: zipLabel, callback_data: `tm_zip:${tid}` }
    ]);

    if (task.mode === 'extract') {
      rows.push([
        { text: selLabel, callback_data: `tm_sel:${tid}` },
        { text: passLabel, callback_data: `tm_pass:${tid}` }
      ]);
    } else if (task.mode === 'zip') {
      rows.push(
        task.batch
          ? [{ text: passLabel, callback_data: `tm_pass:${tid}` }]
          : [
              { text: passLabel, callback_data: `tm_pass:${tid}` },
              { text: 'File Info', callback_data: `tm_info:${tid}` }
            ]
      );
    } else if (!task.batch) {
      rows.push([{ text: 'File Info', callback_data: `tm_info:${tid}` }]);
    }
  }

  if (!isGofile && !isLeech) {
    if (task.isSharedGcTemp) {
      rows.push([{ text: confText, callback_data: `tm_confmenu:${tid}` }]);
    } else {
      rows.push([
        { text: shareLabel, callback_data: `tm_share:${tid}` },
        { text: confText, callback_data: `tm_confmenu:${tid}` }
      ]);
    }
  }

  rows.push([
    { text: '↩️ Back', callback_data: `tm_back:${tid}`, style: 'primary' },
    { text: '⛔ Cancel', callback_data: `tm_cancel:${tid}`, style: 'danger' }
  ]);

  rows.push([{ text: '🚫 Disable ButtonMode', callback_data: `tm_nobtn:${tid}`, style: 'danger' }]);

  return { inline_keyboard: rows };
}

function buildYtdlQualityMenu(task) {
  const tid = task.taskId;
  const cur = task.ytQuality || 'best';
  const btn = (val, label) => ({
    text: cur === val ? `✓ ${label}` : label,
    callback_data: `tm_ytqset:${tid}:${val}`,
    style: cur === val ? 'success' : undefined
  });
  const text =
    `<blockquote><b>Media Quality &amp; Format</b></blockquote>\n\n` +
    `Select video resolution or audio extraction preset.\n` +
    `<i>If an exact resolution is unavailable, the closest lower quality is used automatically.</i>`;
  const kb = {
    inline_keyboard: [
      [btn('best', 'Best Video'), btn('2160', '4K (2160p)'), btn('1440', '2K (1440p)')],
      [btn('1080', '1080p'), btn('720', '720p'), btn('480', '480p')],
      [btn('360', '360p'), btn('mp3', 'MP3 Audio'), btn('m4a', 'M4A Audio')],
      [btn('opus', 'Opus Audio'), btn('flac', 'FLAC Audio')],
      [{ text: '↩ Back', callback_data: `tm_back:${tid}`, style: 'primary' }]
    ]
  };
  return { text, kb };
}

function buildConflictMenu(task) {
  const tid = task.taskId;
  const cur = task.conflict || 'rename';
  const mark = (val, label) => (cur === val ? `✓ ${label}` : label);
  const text =
    `<blockquote><b>Duplicate Handling</b></blockquote>\n\n` +
    `Choose what happens if a file or folder with the same name already exists in <b>${escapeHtml(task.folderName || 'My Drive')}</b>:\n\n` +
    `• <b>Rename</b> — Keep both by adding <code>(1)</code>, <code>(2)</code>, …\n` +
    `• <b>Overwrite</b> — Replace the existing file / folder\n` +
    `• <b>Skip</b> — Leave existing intact and return its link`;
  const kb = {
    inline_keyboard: [
      [
        { text: mark('rename', 'Rename (Keep Both)'), callback_data: `tm_confset:${tid}:rename`, style: cur === 'rename' ? 'success' : undefined },
        { text: mark('overwrite', 'Overwrite'), callback_data: `tm_confset:${tid}:overwrite`, style: cur === 'overwrite' ? 'success' : undefined }
      ],
      [
        { text: mark('skip', 'Skip'), callback_data: `tm_confset:${tid}:skip`, style: cur === 'skip' ? 'success' : undefined },
        { text: '↩ Back', callback_data: `tm_back:${tid}`, style: 'primary' }
      ]
    ]
  };
  return { text, kb };
}

// ============================================================================
// OWNER, ADMIN & GROUP/CHANNEL AUTHORIZATION + 5-DAY GC STORAGE HELPERS
// ============================================================================

function getOwnerId(env) {
  return String(env.OWNER_ID || OWNER_ID);
}

function isOwner(userId, env) {
  return userId != null && String(userId) === getOwnerId(env);
}

function getRepoUrl(env) {
  if (env.GITHUB_OWNER && env.GITHUB_REPO) {
    return `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  }
  return '';
}

function getActionsUrl(env) {
  const repo = getRepoUrl(env);
  return repo ? `${repo}/actions` : '';
}

function parseCommand(text) {
  const m = String(text || '').trim().match(/^(\/[a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), bot: m[2] || '', args: (m[3] || '').trim() };
}

function promptKey(chatId, userId) {
  return `prompt:${chatId}:${userId}`;
}

async function getAdminsMap(env) {
  const raw = await getStore(env).get('auth:admins');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

async function saveAdminsMap(map, env) {
  await getStore(env).put('auth:admins', JSON.stringify(map || {}));
}

async function isAdmin(userId, env) {
  if (userId == null) return false;
  if (isOwner(userId, env)) return true;
  const admins = await getAdminsMap(env);
  return !!admins[String(userId)];
}

async function getUserRoleTag(userId, isChannel, env) {
  if (isChannel) return 'Channel';
  if (isOwner(userId, env)) return 'Owner';
  if (await isAdmin(userId, env)) return 'Admin';
  return 'User';
}

async function getPendingAdminsMap(env) {
  const raw = await getStore(env).get('auth:pending_admins');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

async function savePendingAdminsMap(map, env) {
  await getStore(env).put('auth:pending_admins', JSON.stringify(map || {}));
}

async function indexTelegramUser(user, env) {
  if (!user || user.is_bot || !user.id || !user.username) return;
  const unameLow = String(user.username).toLowerCase();
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
  const idxKey = `user_index:${unameLow}`;
  const curRaw = await getStore(env).get(idxKey);
  if (curRaw) {
    try {
      const cur = JSON.parse(curRaw);
      if (String(cur.userId) === String(user.id) && cur.username === user.username && cur.firstName === fullName) {
        return;
      }
    } catch (_) {}
  }
  await getStore(env).put(idxKey, JSON.stringify({
    userId: String(user.id),
    username: user.username,
    firstName: fullName,
    updatedAt: Date.now()
  }));
}

async function resolvePendingAdminOnSeen(user, env) {
  if (!user || user.is_bot || !user.id || !user.username) return false;
  const unameLow = String(user.username).toLowerCase();
  const pending = await getPendingAdminsMap(env);
  if (!pending[unameLow]) return false;

  const uid = String(user.id);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
  const admins = await getAdminsMap(env);
  admins[uid] = {
    userId: uid,
    username: user.username,
    firstName: fullName,
    addedAt: pending[unameLow].addedAt || Date.now(),
    addedBy: pending[unameLow].addedBy || getOwnerId(env)
  };
  await saveAdminsMap(admins, env);
  delete pending[unameLow];
  await savePendingAdminsMap(pending, env);
  await getStore(env).delete(`req:admin:${uid}`);
  return true;
}

async function addAdminByInput(rawInput, forwardFrom, env) {
  if (forwardFrom && !forwardFrom.is_bot && forwardFrom.id) {
    const uid = String(forwardFrom.id);
    const fullName = [forwardFrom.first_name, forwardFrom.last_name].filter(Boolean).join(' ') || `User ${uid}`;
    const admins = await getAdminsMap(env);
    admins[uid] = {
      userId: uid,
      username: forwardFrom.username || '',
      firstName: fullName,
      addedAt: Date.now(),
      addedBy: getOwnerId(env)
    };
    await saveAdminsMap(admins, env);
    await getStore(env).delete(`req:admin:${uid}`);
    if (forwardFrom.username) {
      const pending = await getPendingAdminsMap(env);
      if (pending[forwardFrom.username.toLowerCase()]) {
        delete pending[forwardFrom.username.toLowerCase()];
        await savePendingAdminsMap(pending, env);
      }
    }
    return { ok: true, mode: 'id', userId: uid, label: forwardFrom.username ? `@${forwardFrom.username}` : fullName };
  }

  const token = String(rawInput || '').trim().split(/\s+/)[0];
  if (!token) {
    return { ok: false, error: 'Send a <code>@username</code>, numeric User ID, or forward a message from the user.' };
  }

  if (/^\d{5,}$/.test(token)) {
    const admins = await getAdminsMap(env);
    admins[token] = admins[token] || {
      userId: token,
      username: '',
      firstName: `User ${token}`,
      addedAt: Date.now(),
      addedBy: getOwnerId(env)
    };
    await saveAdminsMap(admins, env);
    await getStore(env).delete(`req:admin:${token}`);
    return { ok: true, mode: 'id', userId: token, label: `ID ${token}` };
  }

  const cleanUname = token.replace(/^@/, '').trim();
  if (!/^[a-zA-Z0-9_]{4,32}$/.test(cleanUname)) {
    return { ok: false, error: 'Invalid input. Send a valid <code>@username</code>, numeric User ID, or forward a message from the user.' };
  }

  const unameLow = cleanUname.toLowerCase();
  const idxRaw = await getStore(env).get(`user_index:${unameLow}`);
  if (idxRaw) {
    try {
      const idx = JSON.parse(idxRaw);
      if (idx?.userId) {
        const admins = await getAdminsMap(env);
        admins[idx.userId] = {
          userId: idx.userId,
          username: idx.username || cleanUname,
          firstName: idx.firstName || cleanUname,
          addedAt: Date.now(),
          addedBy: getOwnerId(env)
        };
        await saveAdminsMap(admins, env);
        await getStore(env).delete(`req:admin:${idx.userId}`);
        return { ok: true, mode: 'id', userId: idx.userId, label: `@${idx.username || cleanUname}` };
      }
    } catch (_) {}
  }

  // Try Telegram getChat(@username) in case Bot API knows this user
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent('@' + cleanUname)}`);
    const data = await res.json();
    if (data?.ok && data.result?.type === 'private' && data.result.id) {
      const uid = String(data.result.id);
      const fullName = [data.result.first_name, data.result.last_name].filter(Boolean).join(' ') || cleanUname;
      const admins = await getAdminsMap(env);
      admins[uid] = {
        userId: uid,
        username: data.result.username || cleanUname,
        firstName: fullName,
        addedAt: Date.now(),
        addedBy: getOwnerId(env)
      };
      await saveAdminsMap(admins, env);
      await getStore(env).delete(`req:admin:${uid}`);
      return { ok: true, mode: 'id', userId: uid, label: `@${data.result.username || cleanUname}` };
    }
  } catch (_) {}

  // User hasn't interacted with the bot yet — pre-authorize username so they auto-promote on first message
  const pending = await getPendingAdminsMap(env);
  pending[unameLow] = {
    username: cleanUname,
    addedAt: Date.now(),
    addedBy: getOwnerId(env)
  };
  await savePendingAdminsMap(pending, env);
  return { ok: true, mode: 'pending', username: cleanUname, label: `@${cleanUname}` };
}

async function removeAdminByInput(rawInput, env) {
  const token = String(rawInput || '').trim().split(/\s+/)[0];
  if (!token) return false;
  if (/^\d{5,}$/.test(token)) {
    const admins = await getAdminsMap(env);
    if (admins[token]) {
      delete admins[token];
      await saveAdminsMap(admins, env);
      return true;
    }
    return false;
  }
  const cleanUname = token.replace(/^@/, '').toLowerCase();
  const pending = await getPendingAdminsMap(env);
  let removed = false;
  if (pending[cleanUname]) {
    delete pending[cleanUname];
    await savePendingAdminsMap(pending, env);
    removed = true;
  }
  const admins = await getAdminsMap(env);
  for (const [uid, a] of Object.entries(admins)) {
    if ((a.username || '').toLowerCase() === cleanUname) {
      delete admins[uid];
      removed = true;
    }
  }
  if (removed) await saveAdminsMap(admins, env);
  return removed;
}

async function getChatsMap(env) {
  const raw = await getStore(env).get('auth:chats');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

async function saveChatsMap(map, env) {
  await getStore(env).put('auth:chats', JSON.stringify(map || {}));
}

async function getUserStats(userId, env) {
  const uid = String(userId || '').trim();
  const empty = {
    userId: uid,
    username: '',
    firstName: '',
    dmStarted: false,
    firstSeenAt: 0,
    lastSeenAt: 0,
    lastDmAt: 0,
    tried: 0,
    succeeded: 0,
    notDirect: 0,
    cancelled: 0,
    failed: 0
  };
  if (!uid) return empty;
  const raw = await getStore(env).get(`stats:${uid}`);
  if (!raw) return empty;
  try {
    return { ...empty, ...JSON.parse(raw), userId: uid };
  } catch (_) {
    return empty;
  }
}

async function bumpUserStats(userId, increments = {}, meta = {}, env) {
  const uid = String(userId || '').trim();
  if (!uid || !env) return;
  const cur = await getUserStats(uid, env);
  const now = Date.now();
  if (!cur.firstSeenAt) cur.firstSeenAt = now;
  cur.lastSeenAt = now;
  if (meta.dmStarted) {
    cur.dmStarted = true;
    cur.lastDmAt = meta.lastDmAt || now;
  }
  if (meta.username) cur.username = String(meta.username).replace(/^@/, '');
  if (meta.firstName) cur.firstName = String(meta.firstName);

  for (const field of ['tried', 'succeeded', 'notDirect', 'cancelled', 'failed']) {
    const delta = Number(increments[field] || 0);
    if (delta > 0) {
      cur[field] = (Number(cur[field]) || 0) + delta;
    }
  }
  await getStore(env).put(`stats:${uid}`, JSON.stringify(cur));
}

async function fetchTelegramPrivateChat(chatRef, env) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(chatRef)}`);
    const data = await res.json();
    if (data?.ok && data.result?.id && (!data.result.type || data.result.type === 'private')) {
      return data.result;
    }
  } catch (_) {}
  return null;
}

async function buildUserStatusReport(rawInput, actorObj, env) {
  let userId = '';
  let username = '';
  let firstName = '';

  const admins = await getAdminsMap(env);
  const pending = await getPendingAdminsMap(env);

  if (actorObj && actorObj.id) {
    userId = String(actorObj.id);
    username = actorObj.username || '';
    firstName = [actorObj.first_name, actorObj.last_name].filter(Boolean).join(' ') || username || '';
  } else {
    const token = String(rawInput || '').trim().split(/\s+/)[0];
    if (!token) {
      return { ok: false, error: 'Send a valid <code>@username</code>, numeric User ID, or forward a message from the user.' };
    }
    if (/^\d{5,}$/.test(token)) {
      userId = token;
    } else {
      const cleanUname = token.replace(/^@/, '');
      if (!/^[a-zA-Z0-9_]{3,64}$/.test(cleanUname)) {
        return { ok: false, error: 'Invalid input. Send a valid <code>@username</code>, numeric User ID, or forward a message from the user.' };
      }
      username = cleanUname;
      const unameLow = cleanUname.toLowerCase();
      const idxRaw = await getStore(env).get(`user_index:${unameLow}`);
      if (idxRaw) {
        try {
          const idx = JSON.parse(idxRaw);
          if (idx?.userId) {
            userId = String(idx.userId);
            username = idx.username || username;
            firstName = idx.firstName || '';
          }
        } catch (_) {}
      }
      if (!userId) {
        for (const [uid, a] of Object.entries(admins)) {
          if ((a.username || '').toLowerCase() === unameLow) {
            userId = String(uid);
            username = a.username || username;
            firstName = a.firstName || '';
            break;
          }
        }
      }
      if (!userId) {
        const tgChat = await fetchTelegramPrivateChat(`@${cleanUname}`, env);
        if (tgChat) {
          userId = String(tgChat.id);
          username = tgChat.username || username;
          firstName = [tgChat.first_name, tgChat.last_name].filter(Boolean).join(' ') || '';
        }
      }
    }
  }

  if (userId && (!username || !firstName)) {
    const admRec = admins[userId];
    if (admRec) {
      username = username || admRec.username || '';
      firstName = firstName || admRec.firstName || '';
    }
  }

  const stats = userId ? await getUserStats(userId, env) : await getUserStats('', env);
  username = username || stats.username || '';
  firstName = firstName || stats.firstName || '';

  if (userId && !firstName && !username) {
    const tgChat = await fetchTelegramPrivateChat(userId, env);
    if (tgChat) {
      username = tgChat.username || '';
      firstName = [tgChat.first_name, tgChat.last_name].filter(Boolean).join(' ') || '';
    }
  }

  const unameLow = (username || '').toLowerCase();
  let adminStatus = '❌ Not an Admin';
  if (userId && isOwner(userId, env)) {
    adminStatus = '👑 Owner';
  } else if (userId && admins[userId]) {
    adminStatus = '✅ Admin';
  } else if (unameLow && pending[unameLow]) {
    adminStatus = '⏳ Pending Admin (auto-activates on first bot DM)';
  }

  let dmStartedText = '❌ No (has not started bot in DM)';
  if (stats.dmStarted) {
    const ago = stats.lastDmAt ? ` · Last active ${new Date(stats.lastDmAt).toISOString().slice(0, 10)}` : '';
    dmStartedText = `✅ Yes${escapeHtml(ago)}`;
  } else if (!userId) {
    dmStartedText = '❌ No (never interacted with bot)';
  }

  const profile = userId ? await getUserProfile(userId, env) : null;
  const gdriveText = hasDriveAuth(profile)
    ? `✅ Connected (${escapeHtml(profile.email || 'Linked')})`
    : '— Not linked';

  const displayTitle = username
    ? `@${username}${firstName && firstName.toLowerCase() !== username.toLowerCase() ? ` (${firstName})` : ''}`
    : (firstName || `User ${userId}`);
  const idLine = userId ? `<code>${escapeHtml(userId)}</code>` : '<i>Unknown (never interacted yet)</i>';

  const text =
    `<blockquote><b>User Status Report</b>\n\n` +
    `${escapeHtml(displayTitle)}</blockquote>\n\n` +
    `User ID  ·  ${idLine}\n` +
    `Admin Status  ·  ${adminStatus}\n` +
    `Bot Started (DM)  ·  ${dmStartedText}\n` +
    `Google Drive  ·  ${gdriveText}\n\n` +
    `<b>Mirror Statistics</b>\n\n` +
    `Tried to Mirror  ·  <code>${stats.tried}</code>\n` +
    `Succeeded  ·  <code>${stats.succeeded}</code>\n` +
    `Not Direct Link  ·  <code>${stats.notDirect}</code>\n` +
    `Cancelled  ·  <code>${stats.cancelled}</code>\n` +
    `Failed  ·  <code>${stats.failed}</code>`;

  return { ok: true, text };
}

async function sendOwnerStatusOverview(chatId, env, replyToMsgId = null, threadId = null) {
  const admins = await getAdminsMap(env);
  const pending = await getPendingAdminsMap(env);
  const adminCount = Object.keys(admins).length;
  const pendingCount = Object.keys(pending).length;

  const text =
    `<blockquote><b>Owner Status Center</b></blockquote>\n\n` +
    `Approved Admins  ·  <code>${adminCount}</code>\n` +
    `Pending Admins  ·  <code>${pendingCount}</code>\n\n` +
    `Send <code>/status @username</code> or <code>/status &lt;user_id&gt;</code> (or reply to a user's message with <code>/status</code>) to inspect Admin status, bot start state, and mirror statistics.`;

  const kb = {
    inline_keyboard: [
      [{ text: '🔍 Check User Status (@username / ID)', callback_data: 'st_user_prompt', style: 'primary' }],
      [{ text: '📋 View Active Tasks', callback_data: 'st_active_tasks' }]
    ]
  };
  await sendMessage(chatId, text, env, kb, replyToMsgId, threadId);
}

async function getApprovedChat(chatId, env) {
  const chats = await getChatsMap(env);
  return chats[String(chatId)] || null;
}

async function ensureOwnerDriveFolder(accessToken, storeKey, folderName, env) {
  const cachedRaw = await getStore(env).get(storeKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      if (cached?.folderId) {
        const chk = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached.folderId)}?fields=id,name,trashed`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (chk.ok) {
          const meta = await chk.json();
          if (meta?.id && !meta.trashed) {
            return { folderId: meta.id, folderName: meta.name || folderName };
          }
        }
      }
    } catch (_) {}
  }

  const found = await findDriveExisting(accessToken, 'root', folderName);
  const existingFolder = found.find(f => f.mimeType === FOLDER_MIME);
  if (existingFolder?.id) {
    const out = { folderId: existingFolder.id, folderName: existingFolder.name || folderName };
    await getStore(env).put(storeKey, JSON.stringify(out));
    return out;
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: FOLDER_MIME,
      parents: ['root']
    })
  });
  if (!createRes.ok) return null;
  const created = await createRes.json();
  if (!created?.id) return null;
  const out = { folderId: created.id, folderName: created.name || folderName };
  await getStore(env).put(storeKey, JSON.stringify(out));
  return out;
}

async function resolveMirrorContext(chatType, chatId, actorUserId, chatRecord, env) {
  const isPrivate = chatType === 'private';
  const isChannel = chatType === 'channel';
  const storedUser = (!isChannel && actorUserId) ? await getUserProfile(actorUserId, env) : null;

  if (isPrivate || hasDriveAuth(storedUser)) {
    const uid = actorUserId || getOwnerId(env);
    const profile = getEffectiveProfile(uid, storedUser);
    const hasDrive = hasDriveAuth(storedUser);
    const dest = profile.defaultDest === 'telegram'
      ? 'telegram'
      : (hasDrive ? (profile.defaultDest === 'gofile' ? 'gofile' : 'gdrive') : 'gofile');
    return {
      credUserId: String(uid),
      profile,
      hasDrive,
      dest,
      isSharedGcTemp: false,
      folderId: (dest === 'gofile' || dest === 'telegram') ? '' : (profile.folderId || 'root'),
      folderName: dest === 'telegram' ? 'Telegram (Leech)' : (dest === 'gofile' ? 'Gofile (Guest)' : (profile.folderName || 'My Drive')),
      driveFolderId: profile.folderId || 'root',
      driveFolderName: profile.folderName || 'My Drive',
      share: dest === 'telegram' ? false : !!profile.autoShare
    };
  }

  // Group/Channel user without personal /login (unless user chose Telegram Leech default)
  const credOwnerId = String(chatRecord?.credOwnerId || getOwnerId(env));
  const ownerToken = await getValidAccessToken(credOwnerId, env);
  const userEff = getEffectiveProfile(actorUserId || credOwnerId, storedUser);
  if (!isChannel && storedUser?.defaultDest === 'telegram') {
    let driveFolderId = '';
    let driveFolderName = '';
    if (ownerToken) {
      const tf = await ensureOwnerDriveFolder(ownerToken, 'gc_temp_folder', GC_TEMP_FOLDER_NAME, env);
      if (tf?.folderId) {
        driveFolderId = tf.folderId;
        driveFolderName = tf.folderName;
      }
    }
    return {
      credUserId: credOwnerId,
      profile: { ...userEff, defaultDest: 'telegram' },
      hasDrive: false,
      dest: 'telegram',
      isSharedGcTemp: false,
      folderId: '',
      folderName: 'Telegram (Leech)',
      driveFolderId,
      driveFolderName,
      share: false
    };
  }

  if (ownerToken) {
    const tempFolder = await ensureOwnerDriveFolder(ownerToken, 'gc_temp_folder', GC_TEMP_FOLDER_NAME, env);
    if (tempFolder?.folderId) {
      return {
        credUserId: credOwnerId,
        profile: { ...userEff, defaultDest: 'gdrive' },
        hasDrive: false,
        dest: 'gdrive',
        isSharedGcTemp: true,
        folderId: tempFolder.folderId,
        folderName: tempFolder.folderName,
        driveFolderId: tempFolder.folderId,
        driveFolderName: tempFolder.folderName,
        share: true
      };
    }
  }

  // Fallback to Gofile if Owner has not linked Google Drive yet
  const fallbackProfile = getEffectiveProfile(actorUserId || credOwnerId, storedUser);
  return {
    credUserId: String(actorUserId || credOwnerId),
    profile: fallbackProfile,
    hasDrive: false,
    dest: 'gofile',
    isSharedGcTemp: false,
    folderId: '',
    folderName: 'Gofile (Guest)',
    driveFolderId: 'root',
    driveFolderName: 'My Drive',
    share: false
  };
}

async function getGcExpIndex(env) {
  const raw = await getStore(env).get('gc_exp_index');
  if (!raw) return [];
  try {
    return JSON.parse(raw) || [];
  } catch (_) {
    return [];
  }
}

async function saveGcExpIndex(ids, env) {
  await getStore(env).put('gc_exp_index', JSON.stringify(ids || []));
}

async function registerGcTempExpiry(record, env) {
  if (!record?.jobId || !Array.isArray(record.files) || !record.files.length) return;
  await getStore(env).put(`gc_exp:${record.jobId}`, JSON.stringify(record));
  const idx = await getGcExpIndex(env);
  if (!idx.includes(record.jobId)) {
    idx.push(record.jobId);
    await saveGcExpIndex(idx, env);
  }
}

function stripPermReqFromRows(rows, permFolderUrl = '') {
  if (!Array.isArray(rows) || !rows.length) return null;
  const cleaned = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const nextRow = row
      .filter(btn => !(btn?.callback_data && String(btn.callback_data).startsWith('perm_req:')))
      .map(btn => {
        if (permFolderUrl && btn?.url && /Open Folder/i.test(btn.text || '')) {
          return { ...btn, url: permFolderUrl };
        }
        return btn;
      });
    if (nextRow.length) cleaned.push(nextRow);
  }
  return { inline_keyboard: cleaned };
}

async function updateGcMirrorPermMessage(rec, statusNoticeHtml, env, opts = {}) {
  if (!rec?.chatId || !rec?.msgId) return;
  const oldNoticeBlock = `<blockquote>${GC_TEMP_NOTICE_HTML}</blockquote>`;
  const newNoticeBlock = `<blockquote>${statusNoticeHtml}</blockquote>`;
  let htmlText = rec.mirrorHtml ? String(rec.mirrorHtml) : '';
  if (htmlText) {
    if (opts.approved) {
      htmlText = htmlText.replace(/GC Shared \(5-Day Temp\)/g, `${escapeHtml(GC_PERM_FOLDER_NAME)} (Permanent)`);
    }
    if (htmlText.includes(oldNoticeBlock)) {
      htmlText = htmlText.replace(oldNoticeBlock, newNoticeBlock);
    } else if (/<blockquote>[\s\S]*Temporary Group Storage[\s\S]*<\/blockquote>/i.test(htmlText)) {
      htmlText = htmlText.replace(/<blockquote>[\s\S]*Temporary Group Storage[\s\S]*<\/blockquote>/i, newNoticeBlock);
    } else if (/<blockquote>⏳ <b>Permanent Storage Requested<\/b>[\s\S]*<\/blockquote>/i.test(htmlText)) {
      htmlText = htmlText.replace(/<blockquote>⏳ <b>Permanent Storage Requested<\/b>[\s\S]*<\/blockquote>/i, newNoticeBlock);
    } else {
      htmlText += `\n\n${newNoticeBlock}`;
    }
  } else {
    const fileLines = (rec.files || []).slice(0, 6).map(f =>
      `• <a href="${escapeHtml(f.link || 'https://drive.google.com')}">${escapeHtml(truncate(f.name || 'File', 48))}</a>  <code>${fmtBytes(f.size || 0)}</code>`
    ).join('\n');
    const folderLabel = opts.approved ? `${GC_PERM_FOLDER_NAME} (Permanent)` : 'GC Shared (5-Day Temp)';
    htmlText =
      `<blockquote><b>Transfer Complete</b></blockquote>\n\n` +
      `${fileLines || `<code>${escapeHtml(rec.jobId || 'File')}</code>`}\n\n` +
      `Folder  ·  ${escapeHtml(folderLabel)}\n\n` +
      `${newNoticeBlock}`;
  }

  const kb = stripPermReqFromRows(rec.mirrorKbRows, opts.permFolderUrl || '');
  await editMessage(rec.chatId, rec.msgId, htmlText, env, kb).catch(() => {});
}

async function deleteDriveItemPermanently(accessToken, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  return res.ok || res.status === 404 || res.status === 410;
}

async function moveDriveItemToFolder(accessToken, fileId, targetFolderId) {
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,parents&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metaRes.ok) return false;
  const meta = await metaRes.json();
  const prevParents = Array.isArray(meta.parents) ? meta.parents.join(',') : '';
  const params = new URLSearchParams({
    addParents: targetFolderId,
    supportsAllDrives: 'true',
    fields: 'id,parents'
  });
  if (prevParents) params.set('removeParents', prevParents);
  const patchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  return patchRes.ok;
}

async function runGcExpiryCleanup(env) {
  const idx = await getGcExpIndex(env);
  if (!idx.length) return;
  const now = Date.now();
  const kept = [];
  const tokenCache = {};

  for (const jobId of idx) {
    const raw = await getStore(env).get(`gc_exp:${jobId}`);
    if (!raw) continue;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (_) {
      await getStore(env).delete(`gc_exp:${jobId}`);
      continue;
    }
    if (rec.permApproved) {
      await getStore(env).delete(`gc_exp:${jobId}`);
      continue;
    }
    if (!rec.expiresAt || now < rec.expiresAt) {
      kept.push(jobId);
      continue;
    }

    const credUid = String(rec.credUserId || getOwnerId(env));
    if (!tokenCache[credUid]) {
      tokenCache[credUid] = await getValidAccessToken(credUid, env);
    }
    const token = tokenCache[credUid];
    if (!token) {
      kept.push(jobId);
      continue;
    }

    let allCleaned = true;
    for (const f of rec.files || []) {
      if (f?.id) {
        const ok = await deleteDriveItemPermanently(token, f.id);
        if (!ok) allCleaned = false;
      }
    }

    if (allCleaned) {
      await getStore(env).delete(`gc_exp:${jobId}`);
    } else {
      kept.push(jobId);
    }
  }

  if (kept.length !== idx.length) {
    await saveGcExpIndex(kept, env);
  }
}

async function sendAdminRequestNotification(user, env) {
  const uid = String(user.id);
  const reqKey = `req:admin:${uid}`;
  const existing = await getStore(env).get(reqKey);
  if (existing) return { alreadyPending: true };

  const uname = user.username ? `@${user.username}` : 'No username';
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'User';
  const rec = {
    userId: uid,
    username: user.username || '',
    firstName: fullName,
    requestedAt: Date.now()
  };
  await getStore(env).put(reqKey, JSON.stringify(rec), { expirationTtl: 604800 });

  await sendMessage(
    getOwnerId(env),
    `<blockquote><b>Admin Access Request</b></blockquote>\n\n` +
      `Name  ·  ${escapeHtml(fullName)}\n` +
      `Username  ·  <code>${escapeHtml(uname)}</code>\n` +
      `User ID  ·  <code>${escapeHtml(uid)}</code>\n\n` +
      `<i>This user wants to use the bot in DMs.</i>`,
    env,
    {
      inline_keyboard: [[
        { text: '✅ Approve Admin', callback_data: `adm_req:approve:${uid}`, style: 'success' },
        { text: '❌ Deny', callback_data: `adm_req:deny:${uid}`, style: 'danger' }
      ]]
    }
  );
  return { alreadyPending: false };
}

async function requestChatApproval(chat, actor, env) {
  const cid = String(chat.id);
  const chats = await getChatsMap(env);
  if (chats[cid]) return { alreadyApproved: true };

  const reqKey = `req:chat:${cid}`;
  const existing = await getStore(env).get(reqKey);
  if (existing) return { alreadyPending: true };

  const title = chat.title || chat.username || cid;
  const chatType = chat.type || 'group';
  const uname = chat.username ? `@${chat.username}` : 'Private';
  const actorStr = actor
    ? `${escapeHtml([actor.first_name, actor.last_name].filter(Boolean).join(' ') || 'User')} (${actor.username ? '@' + escapeHtml(actor.username) + ' · ' : ''}<code>${actor.id}</code>)`
    : 'Unknown / Channel';

  const rec = {
    chatId: cid,
    title,
    type: chatType,
    username: chat.username || '',
    requestedByUserId: actor?.id ? String(actor.id) : '',
    requestedByName: actor?.username || actor?.first_name || 'User',
    requestedAt: Date.now()
  };
  await getStore(env).put(reqKey, JSON.stringify(rec), { expirationTtl: 604800 });

  await sendMessage(
    getOwnerId(env),
    `<blockquote><b>Group / Channel Approval Request</b></blockquote>\n\n` +
      `Title  ·  <b>${escapeHtml(title)}</b>\n` +
      `Type  ·  <code>${escapeHtml(chatType)}</code>    Handle  ·  <code>${escapeHtml(uname)}</code>\n` +
      `Chat ID  ·  <code>${escapeHtml(cid)}</code>\n` +
      `Requested By  ·  ${actorStr}\n\n` +
      `<i>Approve to allow members in this chat to use the bot?</i>`,
    env,
    {
      inline_keyboard: [[
        { text: '✅ Approve Chat', callback_data: `grp_req:approve:${cid}`, style: 'success' },
        { text: '❌ Deny & Leave', callback_data: `grp_req:deny:${cid}`, style: 'danger' }
      ]]
    }
  );
  return { alreadyPending: false };
}

async function handleMyChatMember(mcm, env) {
  if (!mcm || !mcm.chat || !mcm.new_chat_member) return;
  const chat = mcm.chat;
  const chatType = chat.type;
  if (chatType === 'private') return;

  const cid = String(chat.id);
  const newStatus = mcm.new_chat_member.status;
  const fromUser = mcm.from;

  if (newStatus === 'left' || newStatus === 'kicked') {
    const chats = await getChatsMap(env);
    if (chats[cid]) {
      delete chats[cid];
      await saveChatsMap(chats, env);
    }
    await getStore(env).delete(`req:chat:${cid}`);
    return;
  }

  if (newStatus === 'member' || newStatus === 'administrator') {
    const chats = await getChatsMap(env);
    if (chats[cid]) return;

    if (fromUser && isOwner(fromUser.id, env)) {
      chats[cid] = {
        chatId: cid,
        title: chat.title || cid,
        type: chatType,
        username: chat.username || '',
        approvedBy: getOwnerId(env),
        addedByUserId: String(fromUser.id),
        credOwnerId: getOwnerId(env),
        approvedAt: Date.now()
      };
      await saveChatsMap(chats, env);
      await getStore(env).delete(`req:chat:${cid}`);
      if (chatType !== 'channel') {
        await sendMessage(
          chat.id,
          `<blockquote><b>Bot Authorized</b></blockquote>\n\n` +
            `Approved by Owner. Members can now use <code>/m</code>, <code>/yt</code>, <code>/login</code>, and <code>/help</code>.`,
          env
        ).catch(() => {});
      }
      return;
    }

    await requestChatApproval(chat, fromUser, env);
  }
}

async function buildOwnerAdminPanel(tab = 'main', env) {
  const admins = await getAdminsMap(env);
  const pendingAdmins = await getPendingAdminsMap(env);
  const chats = await getChatsMap(env);
  const adminList = Object.values(admins);
  const pendingList = Object.values(pendingAdmins);
  const chatList = Object.values(chats);

  if (tab === 'admins') {
    let body = '';
    const rows = [[{ text: '➕ Add Admin (@username / ID)', callback_data: 'adm_add', style: 'primary' }]];
    if (!adminList.length && !pendingList.length) {
      body = '<i>No extra admins added yet.</i>';
    } else {
      for (const a of adminList) {
        const label = a.username ? `@${a.username}` : (a.firstName || a.userId);
        body += `• <b>${escapeHtml(label)}</b> — <code>${escapeHtml(a.userId)}</code>\n`;
        rows.push([{ text: `🗑 Remove ${truncate(label, 22)}`, callback_data: `adm_del:${a.userId}`, style: 'danger' }]);
      }
      for (const p of pendingList) {
        body += `• <b>@${escapeHtml(p.username)}</b> — <i>pending first DM</i>\n`;
        rows.push([{ text: `🗑 Remove @${truncate(p.username, 20)}`, callback_data: `adm_pdel:${p.username.toLowerCase()}`, style: 'danger' }]);
      }
    }
    rows.push([{ text: '↩ Back', callback_data: 'adm_panel:main', style: 'primary' }]);
    return {
      text: `<blockquote><b>Manage Admins (${adminList.length + pendingList.length})</b></blockquote>\n\n${body}\n\n<i>Tip: Quick commands </i><code>/auth @username</code><i>, </i><code>/auth &lt;id&gt;</code><i>, and </i><code>/unauth &lt;@user_or_id&gt;</code><i> also work.</i>`,
      kb: { inline_keyboard: rows }
    };
  }

  if (tab === 'chats') {
    let body = '';
    const rows = [];
    if (!chatList.length) {
      body = '<i>No groups or channels authorized yet.</i>';
    } else {
      for (const c of chatList) {
        const label = c.title || c.username || c.chatId;
        body += `• <b>${escapeHtml(label)}</b> (<code>${escapeHtml(c.type || 'group')}</code>) — <code>${escapeHtml(c.chatId)}</code>\n`;
        rows.push([{ text: `🔌 Revoke ${truncate(label, 22)}`, callback_data: `grp_del:${c.chatId}`, style: 'danger' }]);
      }
    }
    rows.push([{ text: '↩ Back', callback_data: 'adm_panel:main', style: 'primary' }]);
    return {
      text: `<blockquote><b>Authorized Groups & Channels (${chatList.length})</b></blockquote>\n\n${body}`,
      kb: { inline_keyboard: rows }
    };
  }

  return {
    text:
      `<blockquote><b>Owner Control Panel</b></blockquote>\n\n` +
      `Owner ID  ·  <code>${escapeHtml(getOwnerId(env))}</code>\n` +
      `Admins  ·  <code>${adminList.length}${pendingList.length ? ` (+${pendingList.length} pending)` : ''}</code>\n` +
      `Authorized Chats  ·  <code>${chatList.length}</code>\n\n` +
      `Quick Commands:\n` +
      `<code>/auth @username</code> or <code>/auth &lt;id&gt;</code> — Authorize admin/group\n` +
      `<code>/unauth @username</code> or <code>/unauth &lt;id&gt;</code> — Revoke admin/group`,
    kb: {
      inline_keyboard: [
        [
          { text: `👥 Admins (${adminList.length + pendingList.length})`, callback_data: 'adm_panel:admins', style: 'primary' },
          { text: `💬 Chats (${chatList.length})`, callback_data: 'adm_panel:chats', style: 'primary' }
        ],
        [{ text: 'Close', callback_data: 'adm_close', style: 'danger' }]
      ]
    }
  };
}

// ============================================================================
// TELEGRAM UPDATE DISPATCHER
// ============================================================================

async function handleTelegramUpdate(update, env) {
  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member, env);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const isChannelPost = !!update.channel_post;
  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId = msg.chat.id;
  const chatType = msg.chat.type || (isChannelPost ? 'channel' : 'private');
  const isPrivate = chatType === 'private';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const isChannel = chatType === 'channel' || isChannelPost;
  const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : (msg.message_thread_id || null);

  const hasActor = !!(msg.from && !msg.from.is_bot);
  if (hasActor) {
    await indexTelegramUser(msg.from, env);
    await resolvePendingAdminOnSeen(msg.from, env);
    if (isPrivate) {
      const fullName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
      await bumpUserStats(msg.from.id, {}, { dmStarted: true, lastDmAt: Date.now(), username: msg.from.username || '', firstName: fullName }, env);
    }
  }
  const userId = hasActor ? msg.from.id : (isChannel ? getOwnerId(env) : (msg.from?.id || getOwnerId(env)));
  const username = hasActor
    ? (msg.from.username || msg.from.first_name || 'User')
    : (msg.author_signature || msg.sender_chat?.title || msg.chat.title || 'Channel');

  const rawText = msg.text || msg.caption || '';
  const text = rawText.trim();
  const parsedCmd = parseCommand(text);
  const cmd = parsedCmd ? parsedCmd.cmd : '';
  const cmdArgs = parsedCmd ? parsedCmd.args : '';
  const directMedia = extractTelegramMedia(msg);

  // 1) DM Access Control: Owner & Admins only
  if (isPrivate) {
    const allowedDm = await isAdmin(userId, env);
    if (!allowedDm) {
      if (cmd === '/request' || cmd === '/request_admin') {
        const res = await sendAdminRequestNotification(msg.from, env);
        await sendMessage(
          chatId,
          res.alreadyPending
            ? `<i>Your admin request is already pending Owner approval.</i>`
            : `<blockquote><b>Request Sent</b>\n\nYour request for Admin access has been sent to the Owner. You will be notified once reviewed.</blockquote>`,
          env
        );
        return;
      }
      const reqKb = {
        inline_keyboard: [[{ text: '📩 Request Admin Access', callback_data: 'req_admin', style: 'primary' }]]
      };
      await sendMessage(
        chatId,
        `<blockquote><b>Private Bot — Access Restricted</b></blockquote>\n\n` +
          `This bot is restricted to the <b>Owner</b> and approved <b>Admins</b> in DMs.\n\n` +
          `Tap the button below to request Admin access from the Owner:`,
        env,
        reqKb,
        msg.message_id
      );
      return;
    }
  }

  // 2) Group & Channel Access Control
  let chatRecord = null;
  if (isGroup || isChannel) {
    if ((cmd === '/authorize' || cmd === '/approve') && hasActor && isOwner(msg.from.id, env)) {
      const chats = await getChatsMap(env);
      const cid = String(chatId);
      chats[cid] = {
        chatId: cid,
        title: msg.chat.title || cid,
        type: chatType,
        username: msg.chat.username || '',
        approvedBy: getOwnerId(env),
        addedByUserId: String(msg.from.id),
        credOwnerId: getOwnerId(env),
        approvedAt: Date.now()
      };
      await saveChatsMap(chats, env);
      await getStore(env).delete(`req:chat:${cid}`);
      await sendMessage(
        chatId,
        `<blockquote><b>Chat Authorized</b></blockquote>\n\n` +
          `All members here can now use <code>/m</code>, <code>/yt</code>, <code>/login</code>, and <code>/help</code>.`,
        env,
        null,
        msg.message_id,
        threadId
      );
      return;
    }

    chatRecord = await getApprovedChat(chatId, env);
    if (!chatRecord) {
      const explicitTrigger = isChannel || ['/start', '/help', '/m', '/mirror', '/yt', '/ytdl', '/login', '/request', '/reqgroup'].includes(cmd);
      if (explicitTrigger) {
        const res = await requestChatApproval(msg.chat, hasActor ? msg.from : null, env);
        if (isGroup) {
          await sendMessage(
            chatId,
            res.alreadyPending
              ? `<i>This group is awaiting Owner approval.</i>`
              : `<blockquote><b>Approval Requested</b>\n\nThis group is not authorized yet. An approval request has been sent to the Owner.</blockquote>`,
            env,
            null,
            msg.message_id,
            threadId
          );
        }
      }
      return;
    }
  }

  // 3) Active prompt input (Rename / Filter / Password / mkdir / Admin Add)
  const pKey = promptKey(chatId, userId);
  const promptRaw = await getStore(env).get(pKey);
  if (promptRaw && !directMedia && (text || msg.forward_from)) {
    if (cmd === '/cancel') {
      await getStore(env).delete(pKey);
      await sendMessage(chatId, `<i>Input cancelled.</i>`, env, null, msg.message_id, threadId);
      return;
    }
    const promptState = JSON.parse(promptRaw);
    await getStore(env).delete(pKey);
    await handleUserPromptInput(chatId, userId, text, promptState, msg.message_id, env, threadId, msg);
    return;
  }

  // 4) Direct media handling
  // In Groups: ignore plain chat media unless captioned with /m, /mirror, /l, or /leech
  if (directMedia) {
    const hasMirrorCmdCaption = cmd === '/m' || cmd === '/mirror';
    const hasLeechCmdCaption = cmd === '/l' || cmd === '/leech';
    if (isGroup && !hasMirrorCmdCaption && !hasLeechCmdCaption) {
      return;
    }
    const isSmallTxt =
      msg.document &&
      ((msg.document.file_name || '').toLowerCase().endsWith('.txt') ||
        (msg.document.mime_type || '').toLowerCase() === 'text/plain') &&
      (!msg.document.file_size || msg.document.file_size <= 512 * 1024) &&
      !hasMirrorCmdCaption && !hasLeechCmdCaption;
    if (isSmallTxt) {
      const handledTxt = await handleDocumentMessage(msg, env, { chatType, chatRecord, threadId, actorUserId: userId, displayUser: username });
      if (handledTxt) return;
    }
    await startTaskFromTelegramMedia(msg, directMedia, env, {
      chatType,
      chatRecord,
      threadId,
      actorUserId: userId,
      displayUser: username,
      forceLeech: hasLeechCmdCaption
    });
    return;
  }

  if (!text) return;

  // 5) Commands
  if (cmd === '/start') {
    await sendStartScreen(chatId, userId, username, env, { isGroup, isChannel, threadId, replyToMsgId: msg.message_id });
    return;
  }

  if (cmd === '/help') {
    await sendHelpScreen(chatId, userId, env, { isGroup, isChannel, threadId, replyToMsgId: msg.message_id });
    return;
  }

  if (cmd === '/admin' || cmd === '/admins') {
    if (!isOwner(userId, env)) {
      await sendMessage(chatId, `<i>Owner-only command.</i>`, env, null, msg.message_id, threadId);
      return;
    }
    const panel = await buildOwnerAdminPanel('main', env);
    await sendMessage(chatId, panel.text, env, panel.kb, msg.message_id, threadId);
    return;
  }

  if (cmd === '/auth' || cmd === '/unauth') {
    if (!isOwner(userId, env)) {
      await sendMessage(chatId, `<i>Owner-only command.</i>`, env, null, msg.message_id, threadId);
      return;
    }
    const targetId = cmdArgs.split(/\s+/)[0];
    if (!targetId) {
      await sendMessage(chatId, `Usage  ·  <code>${cmd} @username</code> or <code>${cmd} &lt;user_or_chat_id&gt;</code>`, env, null, msg.message_id, threadId);
      return;
    }
    if (/^-\d+$/.test(targetId)) {
      const chats = await getChatsMap(env);
      if (cmd === '/auth') {
        chats[targetId] = chats[targetId] || {
          chatId: targetId,
          title: `Chat ${targetId}`,
          type: targetId.startsWith('-100') ? 'supergroup' : 'group',
          username: '',
          approvedBy: getOwnerId(env),
          credOwnerId: getOwnerId(env),
          approvedAt: Date.now()
        };
        await saveChatsMap(chats, env);
        await getStore(env).delete(`req:chat:${targetId}`);
        await sendMessage(chatId, `✓ Chat <code>${escapeHtml(targetId)}</code> authorized.`, env, null, msg.message_id, threadId);
      } else {
        delete chats[targetId];
        await saveChatsMap(chats, env);
        await sendMessage(chatId, `✓ Chat <code>${escapeHtml(targetId)}</code> revoked.`, env, null, msg.message_id, threadId);
      }
    } else if (cmd === '/auth') {
      const res = await addAdminByInput(targetId, msg.reply_to_message?.from || null, env);
      if (!res.ok) {
        await sendMessage(chatId, res.error, env, null, msg.message_id, threadId);
        return;
      }
      if (res.mode === 'id') {
        await sendMessage(chatId, `✓ Admin <b>${escapeHtml(res.label)}</b> (<code>${escapeHtml(res.userId)}</code>) added.`, env, null, msg.message_id, threadId);
        await sendMessage(res.userId, `<blockquote><b>Admin Access Granted</b>\n\nYou are now an Admin. Send /start to use the bot.</blockquote>`, env).catch(() => {});
      } else {
        await sendMessage(
          chatId,
          `✓ Pre-approved Admin <b>${escapeHtml(res.label)}</b>.\n\n<i>They will automatically get Admin access as soon as they message the bot.</i>`,
          env,
          null,
          msg.message_id,
          threadId
        );
      }
    } else {
      const removed = await removeAdminByInput(targetId, env);
      await sendMessage(
        chatId,
        removed ? `✓ Admin <code>${escapeHtml(targetId)}</code> removed.` : `<i>No matching admin found for <code>${escapeHtml(targetId)}</code>.</i>`,
        env,
        null,
        msg.message_id,
        threadId
      );
    }
    return;
  }

  if (cmd === '/reqgroup') {
    if (!isPrivate) {
      if (isGroup && !chatRecord) {
        await requestChatApproval(msg.chat, hasActor ? msg.from : null, env);
        await sendMessage(chatId, `<i>Approval request sent to the Owner.</i>`, env, null, msg.message_id, threadId);
      }
      return;
    }
    if (!cmdArgs) {
      await getStore(env).put(pKey, JSON.stringify({ type: 'req_group' }), { expirationTtl: 600 });
      await sendMessage(
        chatId,
        `<blockquote><b>Request Group / Channel Access</b></blockquote>\n\n` +
          `Send the group/channel link (<code>https://t.me/...</code>), <code>@username</code>, or numeric chat ID (<code>-100...</code>), or /cancel:`,
        env,
        null,
        msg.message_id
      );
      return;
    }
    await handleGroupLinkRequest(chatId, userId, username, cmdArgs, env);
    return;
  }

  if (cmd === '/login') {
    if (isChannel) return;
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    const gcNote = isGroup ? `\n\n<i>Account linked for ${hasActor && msg.from.username ? '@' + escapeHtml(msg.from.username) : escapeHtml(username)}. Your files will upload to your own Drive instead of shared GC storage.</i>` : '';
    await sendMessage(
      chatId,
      `<blockquote><b>Google Drive Authentication</b></blockquote>\n\n` +
        `Authorize your Google Drive account so transfers upload directly to your storage.\n\n` +
        `<i>If Google displays an unverified app prompt, select Advanced → Proceed.</i>${gcNote}`,
      env,
      { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] },
      msg.message_id,
      threadId
    );
    return;
  }

  if (cmd === '/logout') {
    if (isChannel) return;
    await getStore(env).delete(`user:${userId}`);
    await sendMessage(
      chatId,
      `<blockquote><b>Disconnected</b>\n\nYour Google Drive credentials have been removed.${isGroup ? ' Group mirrors will now use the shared 5-day storage unless you /login again.' : ' You can still mirror to Gofile (temporary guest storage) anytime.'}</blockquote>`,
      env,
      null,
      msg.message_id,
      threadId
    );
    return;
  }

  if (cmd === '/setdldir' || cmd === '/setfolder') {
    if (isChannel) return;
    const profile = await getUserProfile(userId, env);
    if (!profile || !profile.refreshToken) {
      const authUrl = await createOAuthUrl(chatId, userId, username, env);
      await sendMessage(
        chatId,
        `Connect your Google Drive first before choosing a destination folder.`,
        env,
        { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] },
        msg.message_id,
        threadId
      );
      return;
    }
    await openFolderBrowser(chatId, userId, profile.folderId || 'root', null, null, env, 0, threadId);
    return;
  }

  if (cmd === '/settings') {
    if (isChannel) return;
    const stored = await getUserProfile(userId, env);
    const profile = getEffectiveProfile(userId, stored);
    if (!stored) {
      await saveUserProfile(userId, profile, env);
    }
    await sendSettingsMenu(chatId, userId, profile, null, env, threadId);
    return;
  }

  if (cmd === '/tasks' || cmd === '/status') {
    if (cmd === '/status' && isPrivate && isOwner(userId, env)) {
      const targetArg = cmdArgs.trim().split(/\s+/)[0] || '';
      const replyActor = msg.reply_to_message?.forward_from || msg.reply_to_message?.from || null;
      if (targetArg || (replyActor && !replyActor.is_bot)) {
        const rep = await buildUserStatusReport(targetArg, targetArg ? null : replyActor, env);
        await sendMessage(chatId, rep.ok ? rep.text : rep.error, env, null, msg.message_id, threadId);
      } else {
        await sendOwnerStatusOverview(chatId, env, msg.message_id, threadId);
      }
      return;
    }
    await sendActiveTasks(chatId, userId, env, isGroup || isChannel ? chatId : null, threadId);
    return;
  }

  if (cmd === '/history') {
    await sendHistory(chatId, userId, null, env, threadId);
    return;
  }

  if (cmd && cmd.startsWith('/cancel_')) {
    const jobId = cmd.replace('/cancel_', '').trim();
    await cancelActiveJob(chatId, userId, jobId, env, threadId);
    return;
  }

  const isYtCmd = cmd === '/yt' || cmd === '/ytdl';
  const isMCmd = cmd === '/m' || cmd === '/mirror';
  const isLCmd = cmd === '/l' || cmd === '/leech';

  // In Groups: ignore bare links that do not start with /m, /l, or /yt
  if (isGroup && !isYtCmd && !isMCmd && !isLCmd) {
    return;
  }

  let urls = extractUrls(text);

  if (!urls.length && (isMCmd || isYtCmd || isLCmd) && msg.reply_to_message) {
    const repliedMedia = extractTelegramMedia(msg.reply_to_message);
    if (repliedMedia && (isMCmd || isLCmd)) {
      await startTaskFromTelegramMedia(msg, repliedMedia, env, {
        chatType,
        chatRecord,
        threadId,
        actorUserId: userId,
        displayUser: username,
        forceLeech: isLCmd
      });
      return;
    }
    const repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    urls = extractUrls(repliedText);
  }

  if (!urls.length) {
    if (isYtCmd) {
      await sendMessage(chatId, `Usage  ·  <code>/yt https://youtube.com/watch?v=...</code>\n\n<i>Works with YouTube, Instagram, TikTok, X, Twitch, Vimeo, SoundCloud, and 1000+ media sites.</i>`, env, null, msg.message_id, threadId);
    } else if (isLCmd) {
      await sendMessage(chatId, `Usage  ·  <code>/leech https://example.com/file.mkv</code>  or  <code>/l https://example.com/file.mkv</code>\n\n<i>Leeches direct URLs, Drive links, Gofile, SourceForge, media sites, or reply </i><code>/leech</code><i> / </i><code>/l</code><i> to any message/file directly into Telegram (auto-splits files &gt; 2 GB).</i>`, env, null, msg.message_id, threadId);
    } else if (isMCmd) {
      await sendMessage(chatId, `Usage  ·  <code>/m https://example.com/file.mkv</code>\n\n<i>You can also forward/send any Telegram file (up to 4 GB), send a </i><code>https://t.me/...</code><i> post link, a </i><code>.txt</code><i> file of URLs, or </i><code>/yt &lt;url&gt;</code><i> / </i><code>/leech &lt;url&gt;</code><i>.</i>`, env, null, msg.message_id, threadId);
    }
    return;
  }

  await startTaskFromUrls(chatId, userId, username, msg.message_id, urls, env, {
    forceYtdl: isYtCmd,
    forceLeech: isLCmd,
    chatType,
    chatRecord,
    threadId
  });
}

async function handleGroupLinkRequest(dmChatId, userId, username, rawInput, env) {
  const input = rawInput.trim();
  let lookupKey = '';
  let isInviteLink = false;

  if (/^-?\d{5,}$/.test(input)) {
    lookupKey = input;
  } else if (/^@[a-zA-Z0-9_]{4,}$/.test(input)) {
    lookupKey = input;
  } else {
    const mPub = input.match(/t\.me\/([a-zA-Z0-9_]{4,})(?:\/\d+)?$/i);
    if (mPub && !['joinchat', 'c', 's'].includes(mPub[1].toLowerCase())) {
      lookupKey = `@${mPub[1]}`;
    } else if (/t\.me\/(?:\+|joinchat\/)/i.test(input)) {
      isInviteLink = true;
    } else {
      const mPrivC = input.match(/t\.me\/c\/(\d+)/i);
      if (mPrivC) {
        lookupKey = `-100${mPrivC[1]}`;
      }
    }
  }

  if (lookupKey) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(lookupKey)}`
      );
      const data = await res.json();
      if (data?.ok && data.result && data.result.type !== 'private') {
        const resReq = await requestChatApproval(data.result, { id: userId, username, first_name: username }, env);
        if (resReq.alreadyApproved) {
          await sendMessage(dmChatId, `<i>That group/channel is already authorized!</i>`, env);
        } else if (resReq.alreadyPending) {
          await sendMessage(dmChatId, `<i>An approval request for that group/channel is already pending.</i>`, env);
        } else {
          await sendMessage(
            dmChatId,
            `<blockquote><b>Group Request Sent</b>\n\nSent approval request for <b>${escapeHtml(data.result.title || lookupKey)}</b> to the Owner.</blockquote>`,
            env
          );
        }
        return;
      }
    } catch (_) {}
  }

  // Fallback for private invite links or chats the bot hasn't joined yet
  const reqId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  await getStore(env).put(
    `req:link:${reqId}`,
    JSON.stringify({ input, userId: String(userId), username, createdAt: Date.now() }),
    { expirationTtl: 604800 }
  );
  await sendMessage(
    getOwnerId(env),
    `<blockquote><b>Group / Channel Link Request</b></blockquote>\n\n` +
      `Requested By  ·  ${escapeHtml(username)} (<code>${escapeHtml(String(userId))}</code>)\n` +
      `Link / ID  ·  <code>${escapeHtml(input)}</code>\n\n` +
      (isInviteLink
        ? `<i>Note: Telegram bots cannot join invite links on their own. Add the bot to the group/channel (auto-approves if you add it), or approve if it's a chat ID.</i>`
        : `<i>The bot could not resolve this chat yet (it may need to be added to the group first).</i>`),
    env,
    /^-?\d{5,}$/.test(lookupKey)
      ? {
          inline_keyboard: [[
            { text: '✅ Pre-Approve ID', callback_data: `grp_req:preapprove:${lookupKey}`, style: 'success' },
            { text: '❌ Dismiss', callback_data: `grp_req:dismiss:${reqId}`, style: 'danger' }
          ]]
        }
      : {
          inline_keyboard: [[{ text: '❌ Dismiss', callback_data: `grp_req:dismiss:${reqId}`, style: 'danger' }]]
        }
  );
  await sendMessage(
    dmChatId,
    `<blockquote><b>Request Forwarded to Owner</b></blockquote>\n\n` +
      `Link  ·  <code>${escapeHtml(input)}</code>\n\n` +
      `<i>If this is a private group, make sure the bot is added to the group as well so the Owner can approve it.</i>`,
    env
  );
}

function extractTelegramMedia(msg) {
  if (!msg) return null;
  const media =
    msg.document ||
    msg.video ||
    msg.audio ||
    msg.animation ||
    msg.voice ||
    msg.video_note ||
    null;
  if (!media || !media.file_id) return null;

  let kind = 'document';
  let defaultExt = '.bin';
  if (msg.video) {
    kind = 'video';
    defaultExt = '.mp4';
  } else if (msg.audio) {
    kind = 'audio';
    defaultExt = '.mp3';
  } else if (msg.animation) {
    kind = 'animation';
    defaultExt = '.mp4';
  } else if (msg.voice) {
    kind = 'voice';
    defaultExt = '.ogg';
  } else if (msg.video_note) {
    kind = 'video_note';
    defaultExt = '.mp4';
  }

  const mime =
    media.mime_type ||
    (kind === 'video' || kind === 'animation' || kind === 'video_note'
      ? 'video/mp4'
      : kind === 'audio'
        ? 'audio/mpeg'
        : kind === 'voice'
          ? 'audio/ogg'
          : 'application/octet-stream');

  if (defaultExt === '.bin' && mime) {
    const lowMime = mime.toLowerCase();
    if (lowMime.includes('mp4')) defaultExt = '.mp4';
    else if (lowMime.includes('matroska') || lowMime.includes('mkv')) defaultExt = '.mkv';
    else if (lowMime.includes('webm')) defaultExt = '.webm';
    else if (lowMime.includes('zip')) defaultExt = '.zip';
    else if (lowMime.includes('rar')) defaultExt = '.rar';
    else if (lowMime.includes('7z')) defaultExt = '.7z';
    else if (lowMime.includes('pdf')) defaultExt = '.pdf';
    else if (lowMime.includes('mpeg') || lowMime.includes('mp3')) defaultExt = '.mp3';
  }

  let fileName = media.file_name || '';
  if (!fileName && msg.audio && msg.audio.title) {
    const perf = msg.audio.performer ? `${msg.audio.performer} - ` : '';
    fileName = `${perf}${msg.audio.title}${defaultExt}`;
  }
  if (!fileName) {
    fileName = `telegram_${kind}_${msg.message_id || Date.now()}${defaultExt}`;
  }
  fileName = fileName.replace(/[/\\?%*:|"<>]/g, '_').trim();

  return {
    type: 'tg_media',
    chatId: msg.chat.id,
    messageId: msg.message_id,
    fileId: media.file_id,
    name: fileName,
    size: media.file_size || 0,
    mimeType: mime,
    mediaKind: kind
  };
}

async function startTaskFromTelegramMedia(msg, tgMedia, env, ctx = {}) {
  const chatId = msg.chat.id;
  const chatType = ctx.chatType || msg.chat.type || 'private';
  const isChannel = chatType === 'channel';
  const threadId = ctx.threadId || msg.message_thread_id || null;
  const userId = ctx.actorUserId || msg.from?.id || getOwnerId(env);
  const username = ctx.displayUser || msg.from?.username || msg.from?.first_name || msg.author_signature || msg.chat?.title || 'User';
  const replyToMsgId = msg.message_id;

  const forceLeech = !!ctx.forceLeech;
  const mCtx = await resolveMirrorContext(chatType, chatId, isChannel ? null : userId, ctx.chatRecord, env);
  const profile = mCtx.profile;
  const defaultDest = forceLeech ? 'telegram' : mCtx.dest;
  const isSharedGcTemp = defaultDest === 'telegram' ? false : mCtx.isSharedGcTemp;
  if (!isChannel) {
    await bumpUserStats(userId, { tried: 1 }, { username }, env);
  }

  let duplicateExists = false;
  try {
    if (defaultDest === 'gdrive' && (mCtx.hasDrive || isSharedGcTemp) && tgMedia.name) {
      const accessToken = await getValidAccessToken(mCtx.credUserId, env);
      if (accessToken) {
        const existing = await findDriveExisting(accessToken, mCtx.folderId || 'root', tgMedia.name);
        duplicateExists = existing.length > 0;
      }
    }
  } catch (_) {}

  const userRole = await getUserRoleTag(userId, isChannel, env);
  const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const task = {
    taskId,
    userId: String(userId),
    userRole,
    credUserId: mCtx.credUserId,
    username,
    chatId,
    chatType,
    isChannel,
    isSharedGcTemp,
    threadId,
    replyToMsgId,
    menuMsgId: null,
    fileUrl: `tg://${tgMedia.chatId}/${tgMedia.messageId}`,
    items: [tgMedia],
    batch: false,
    isDrive: false,
    isFolder: false,
    isYtdl: false,
    isTgMedia: true,
    resolvedVia: 'Telegram MTProto (Kurigram)',
    detectedName: tgMedia.name,
    customName: '',
    fileSize: tgMedia.size || 0,
    contentType: tgMedia.mimeType || 'application/octet-stream',
    acceptRanges: true,
    dest: defaultDest,
    leechAsDoc: !!profile.leechAsDoc,
    hasDrive: mCtx.hasDrive,
    driveFolderId: mCtx.driveFolderId,
    driveFolderName: mCtx.driveFolderName,
    folderId: defaultDest === 'telegram' ? '' : mCtx.folderId,
    folderName: defaultDest === 'telegram' ? 'Telegram (Leech)' : mCtx.folderName,
    mode: 'normal',
    selectFilter: '',
    archivePassword: '',
    share: defaultDest === 'telegram' ? false : mCtx.share,
    conflict: profile.conflict || 'rename',
    duplicateExists,
    createdAt: Date.now()
  };

  if (profile.buttonMode === false) {
    const prep = await sendMessage(
      chatId,
      `<blockquote><b>Preparing Telegram Transfer</b>\n\n<code>${escapeHtml(tgMedia.name)}</code></blockquote>`,
      env,
      null,
      replyToMsgId,
      threadId
    );
    task.menuMsgId = prep?.result?.message_id;
    await getStore(env).put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
    await launchMirrorTask(task, env);
    return;
  }

  const sent = await sendMessage(chatId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task), replyToMsgId, threadId);
  task.menuMsgId = sent?.result?.message_id;
  await getStore(env).put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
}

async function handleDocumentMessage(msg, env, ctx = {}) {
  const doc = msg.document;
  const chatId = msg.chat.id;
  const userId = ctx.actorUserId || msg.from?.id || getOwnerId(env);
  const username = ctx.displayUser || msg.from?.username || msg.from?.first_name || msg.author_signature || msg.chat?.title || 'User';
  const fileName = (doc.file_name || '').toLowerCase();
  const mime = (doc.mime_type || '').toLowerCase();

  if (!fileName.endsWith('.txt') && mime !== 'text/plain') {
    return false;
  }

  if (doc.file_size && doc.file_size > 512 * 1024) {
    return false;
  }

  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(doc.file_id)}`);
  const fileJson = await fileRes.json();
  const filePath = fileJson?.result?.file_path;
  if (!filePath) {
    return false;
  }

  const rawRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!rawRes.ok) {
    return false;
  }

  const content = await rawRes.text();
  const cleanLines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .join('\n');
  const urls = extractUrls(cleanLines);

  if (!urls.length) {
    return false;
  }

  await startTaskFromUrls(chatId, userId, username, msg.message_id, urls, env, {
    chatType: ctx.chatType,
    chatRecord: ctx.chatRecord,
    threadId: ctx.threadId
  });
  return true;
}

async function startTaskFromUrls(chatId, userId, username, replyToMsgId, urls, env, opts = {}) {
  const forceYtdl = !!opts.forceYtdl;
  const forceLeech = !!opts.forceLeech;
  const editExistingMsgId = opts.editMsgId || null;
  const chatType = opts.chatType || 'private';
  const isChannel = chatType === 'channel';
  const threadId = opts.threadId || null;
  const mCtx = await resolveMirrorContext(chatType, chatId, isChannel ? null : userId, opts.chatRecord, env);
  const profile = mCtx.profile;
  const hasDrive = mCtx.hasDrive;
  const defaultDest = forceLeech ? 'telegram' : mCtx.dest;
  const isSharedGcTemp = defaultDest === 'telegram' ? false : mCtx.isSharedGcTemp;
  const taskFolderId = defaultDest === 'telegram' ? '' : mCtx.folderId;
  const taskFolderName = defaultDest === 'telegram' ? 'Telegram (Leech)' : mCtx.folderName;
  const taskShare = defaultDest === 'telegram' ? false : mCtx.share;

  const hasSourceForge = urls.some(u => isSourceForgeUrl(u));
  const hasGofile = urls.some(u => isGofileUrl(u));
  const isBatchInitial = urls.length > 1;
  const allMediaInitial = forceYtdl || urls.every(u => isMediaSiteUrl(u));
  let checkingMsgId = editExistingMsgId;
  if (!checkingMsgId) {
    const checkingMsg = await sendMessage(
      chatId,
      hasSourceForge
        ? `<blockquote><b>Generating download link...</b>\n\n<i>Fetching direct SourceForge mirror link...</i></blockquote>`
        : hasGofile
          ? `<blockquote><b>Inspecting Gofile...</b>\n\n<i>Reading file/folder metadata from the Gofile API...</i></blockquote>`
          : isBatchInitial
            ? `<blockquote><b>Preparing Batch</b>\n\n<i>Queued ${urls.length} links...</i></blockquote>`
            : allMediaInitial
              ? `<blockquote><b>Inspecting Media</b>\n\n<i>Fetching title and preparing yt-dlp options...</i></blockquote>`
              : `<blockquote><b>Inspecting Link</b>\n\n<i>Verifying stream headers and file size...</i></blockquote>`,
      env,
      null,
      replyToMsgId,
      threadId
    );
    checkingMsgId = checkingMsg?.result?.message_id;
  }

  const userRole = await getUserRoleTag(userId, isChannel, env);
  const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  let task;

  if (!isChannel) {
    await bumpUserStats(userId, { tried: 1 }, { username }, env);
  }

  try {
  if (hasSourceForge) {
    const expanded = await expandSourceForgeInputs(urls);
    if (expanded.error) {
      if (!isChannel) {
        await bumpUserStats(userId, { notDirect: 1 }, {}, env);
      }
      const errText =
        `<blockquote><b>SourceForge Link Error</b></blockquote>\n\n` +
        `Reason  ·  <code>${escapeHtml(expanded.error)}</code>`;
      if (checkingMsgId) {
        await editMessage(chatId, checkingMsgId, errText, env);
      } else {
        await sendMessage(chatId, errText, env, null, replyToMsgId, threadId);
      }
      return;
    }
    urls = expanded.urls;
  }

  const isBatch = urls.length > 1;
  if (!isBatch) {
    const rawUrl = urls[0];
    let ytdlUrl = (forceYtdl || isMediaSiteUrl(rawUrl)) ? rawUrl : '';
    let resolved = null;
    let accessToken = null;

    if (!ytdlUrl) {
      accessToken = hasDrive ? await getValidAccessToken(mCtx.credUserId, env) : null;
      resolved = await resolveAndInspectInput(rawUrl, accessToken, env);

      if (resolved.kind === 'ytdl') {
        ytdlUrl = resolved.finalUrl || rawUrl;
      } else if (resolved.kind === 'error') {
        if (!isChannel) {
          await bumpUserStats(userId, { notDirect: 1 }, {}, env);
        }
        const errText =
          `<blockquote><b>Invalid Stream Link</b></blockquote>\n\n` +
          `Reason  ·  <code>${escapeHtml(resolved.reason)}</code>\n\n` +
          `Action  ·  Provide a direct file URL, supported host page, or try media mode (<code>/yt</code>).`;
        const retryId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
        await getStore(env).put(
          `retry:${retryId}`,
          JSON.stringify({ url: rawUrl, userId: String(userId), replyToMsgId, chatType, isChannel, threadId }),
          { expirationTtl: 600 }
        );
        const retryKb = {
          inline_keyboard: [[{ text: '🎬 Try with yt-dlp', callback_data: `tm_try_yt:${retryId}`, style: 'primary' }]]
        };
        if (checkingMsgId) {
          await editMessage(chatId, checkingMsgId, errText, env, retryKb);
        } else {
          await sendMessage(chatId, errText, env, retryKb, replyToMsgId, threadId);
        }
        return;
      }
    }

    if (ytdlUrl) {
      const oembed = await fetchMediaOEmbed(ytdlUrl);
      const detectedTitle = oembed?.title || guessNameFromUrl(ytdlUrl) || 'Media';
      task = {
        taskId,
        userId: String(userId),
        userRole,
        credUserId: mCtx.credUserId,
        username,
        chatId,
        chatType,
        isChannel,
        isSharedGcTemp,
        threadId,
        replyToMsgId,
        menuMsgId: checkingMsgId,
        fileUrl: ytdlUrl,
        items: [{ type: 'ytdl', url: ytdlUrl, name: detectedTitle }],
        batch: false,
        isDrive: false,
        isFolder: false,
        isYtdl: true,
        mediaAuthor: oembed?.author || '',
        ytQuality: profile.ytQuality || 'best',
        ytContainer: profile.ytContainer || 'mp4',
        ytSubs: false,
        ytSubLang: 'en',
        ytMeta: true,
        ytSponsorBlock: false,
        ytPlaylist: isPlaylistUrl(ytdlUrl) ? 'all' : 'single',
        ytPlaylistItems: '',
        ytTrim: '',
        detectedName: detectedTitle,
        customName: '',
        fileSize: 0,
        contentType: 'video/mp4',
        acceptRanges: true,
        dest: defaultDest,
        leechAsDoc: !!profile.leechAsDoc,
        hasDrive,
        driveFolderId: mCtx.driveFolderId,
        driveFolderName: mCtx.driveFolderName,
        folderId: taskFolderId,
        folderName: taskFolderName,
        mode: 'normal',
        selectFilter: '',
        archivePassword: '',
        share: taskShare,
        conflict: profile.conflict || 'rename',
        duplicateExists: false,
        createdAt: Date.now()
      };
    } else {
      const verification = resolved.verification;
      const isDrive = resolved.kind === 'gdrive';
      const isTgMedia = resolved.kind === 'tg_media';
      const isSfFolder = resolved.kind === 'sf_folder';
      const isGofileSource = resolved.kind === 'gofile';
      const fileUrl = resolved.finalUrl;

      let duplicateExists = false;
      try {
        if (defaultDest === 'gdrive' && (hasDrive || isSharedGcTemp) && verification.fileName) {
          const dupToken = accessToken || await getValidAccessToken(mCtx.credUserId, env);
          if (dupToken) {
            const existing = await findDriveExisting(dupToken, taskFolderId || 'root', verification.fileName);
            duplicateExists = existing.length > 0;
          }
        }
      } catch (_) {}

      const item = isDrive
        ? {
            type: 'gdrive',
            id: resolved.driveInfo.id,
            resourceKey: resolved.driveInfo.resourceKey || '',
            name: verification.fileName,
            mimeType: verification.contentType,
            size: verification.sizeBytes || 0,
            isFolder: !!verification.isFolder
          }
        : isTgMedia
          ? resolved.tgInfo
          : isSfFolder
            ? resolved.sfInfo
            : isGofileSource
              ? resolved.gofileInfo
              : {
                  type: 'url',
                  url: fileUrl,
                  sourceUrl: resolved.sourceUrl || '',
                  resolvedVia: resolved.resolvedVia || '',
                  name: verification.fileName,
                  size: verification.sizeBytes || 0
                };

      task = {
        taskId,
        userId: String(userId),
        userRole,
        credUserId: mCtx.credUserId,
        username,
        chatId,
        chatType,
        isChannel,
        isSharedGcTemp,
        threadId,
        replyToMsgId,
        menuMsgId: checkingMsgId,
        fileUrl,
        items: [item],
        batch: false,
        isDrive,
        isFolder: !!verification.isFolder,
        isYtdl: false,
        isTgMedia,
        isGofileSource,
        gofileChildrenCount: isGofileSource ? (resolved.gofileInfo?.childrenCount || 0) : 0,
        resolvedVia: resolved.resolvedVia || '',
        detectedName: verification.fileName,
        customName: '',
        fileSize: verification.sizeBytes || 0,
        contentType: verification.contentType || 'application/octet-stream',
        acceptRanges: verification.acceptRanges || false,
        dest: defaultDest,
        leechAsDoc: !!profile.leechAsDoc,
        hasDrive,
        driveFolderId: mCtx.driveFolderId,
        driveFolderName: mCtx.driveFolderName,
        folderId: taskFolderId,
        folderName: taskFolderName,
        mode: 'normal',
        selectFilter: '',
        archivePassword: '',
        share: taskShare,
        conflict: profile.conflict || 'rename',
        duplicateExists,
        createdAt: Date.now()
      };
    }
  } else {
    const items = urls.map(u => {
      if (forceYtdl || isMediaSiteUrl(u)) {
        return { type: 'ytdl', url: u, name: guessNameFromUrl(u) };
      }
      const tg = parseTelegramPostUrl(u);
      if (tg) {
        return {
          type: 'tg_media',
          chatId: tg.chat,
          messageId: tg.messageId,
          fileId: '',
          url: u,
          name: `Telegram_${tg.isPrivate ? 'post' : tg.chat}_${tg.messageId}`
        };
      }
      const gd = parseDriveUrl(u);
      if (gd) {
        return { type: 'gdrive', id: gd.id, resourceKey: gd.resourceKey || '' };
      }
      const gf = parseGofileUrl(u);
      if (gf) {
        return { type: 'gofile', id: gf.id, url: u, name: guessNameFromUrl(u) };
      }
      return { type: 'url', url: u, name: guessNameFromUrl(u) };
    });

    const batchHasYtdl = items.some(i => i.type === 'ytdl');
    task = {
      taskId,
      userId: String(userId),
      userRole,
      credUserId: mCtx.credUserId,
      username,
      chatId,
      chatType,
      isChannel,
      isSharedGcTemp,
      threadId,
      replyToMsgId,
      menuMsgId: checkingMsgId,
      fileUrl: urls[0],
      items,
      batch: true,
      isDrive: items.every(i => i.type === 'gdrive'),
      isFolder: false,
      isYtdl: batchHasYtdl,
      isGofileSource: items.some(i => i.type === 'gofile'),
      gofileChildrenCount: 0,
      ytQuality: profile.ytQuality || 'best',
      ytContainer: profile.ytContainer || 'mp4',
      ytSubs: false,
      ytSubLang: 'en',
      ytMeta: true,
      ytSponsorBlock: false,
      ytPlaylist: 'single',
      ytPlaylistItems: '',
      ytTrim: '',
      detectedName: `Batch (${items.length} links)`,
      customName: '',
      fileSize: 0,
      contentType: 'application/octet-stream',
      acceptRanges: false,
      dest: defaultDest,
      leechAsDoc: !!profile.leechAsDoc,
      hasDrive,
      driveFolderId: mCtx.driveFolderId,
      driveFolderName: mCtx.driveFolderName,
      folderId: taskFolderId,
      folderName: taskFolderName,
      mode: 'normal',
      selectFilter: '',
      archivePassword: '',
      share: taskShare,
      conflict: profile.conflict || 'rename',
      duplicateExists: false,
      createdAt: Date.now()
    };
  }

  await getStore(env).put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

  if (profile.buttonMode === false) {
    await launchMirrorTask(task, env);
    return;
  }

  const menuText = buildTaskMenuMessage(task);
  const menuKb = buildTaskMenuKeyboard(task);

  if (checkingMsgId) {
    await editMessage(chatId, checkingMsgId, menuText, env, menuKb);
  } else {
    const sent = await sendMessage(chatId, menuText, env, menuKb, replyToMsgId, threadId);
    task.menuMsgId = sent?.result?.message_id;
    await getStore(env).put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
  }
  } catch (err) {
    if (!isChannel) {
      await bumpUserStats(userId, { notDirect: 1 }, {}, env);
    }
    const failText =
      `<blockquote><b>Link Inspection Failed</b></blockquote>\n\n` +
      `Reason  ·  <code>${escapeHtml(err?.message || String(err))}</code>`;
    if (checkingMsgId) {
      await editMessage(chatId, checkingMsgId, failText, env).catch(() => {});
    } else {
      await sendMessage(chatId, failText, env, null, replyToMsgId, threadId).catch(() => {});
    }
  }
}

// ============================================================================
// HANDLE INTERACTIVE PROMPTS
// ============================================================================

async function canControlRecord(rec, userId, env) {
  if (!rec) return false;
  if (String(rec.userId) === String(userId)) return true;
  if (isOwner(userId, env)) return true;
  if (rec.isChannel && await isAdmin(userId, env)) return true;
  return false;
}

async function handleUserPromptInput(chatId, userId, text, promptState, msgId, env, threadId = null, msgObj = null) {
  if (promptState.type === 'add_admin_id') {
    if (!isOwner(userId, env)) return;
    const res = await addAdminByInput(text, msgObj?.forward_from || null, env);
    if (!res.ok) {
      await sendMessage(chatId, res.error, env, null, msgId, threadId);
      return;
    }
    if (res.mode === 'id') {
      await sendMessage(chatId, `✓ Admin <b>${escapeHtml(res.label)}</b> (<code>${escapeHtml(res.userId)}</code>) added.`, env, null, msgId, threadId);
      await sendMessage(res.userId, `<blockquote><b>Admin Access Granted</b>\n\nYou are now an Admin. Send /start to use the bot.</blockquote>`, env).catch(() => {});
    } else {
      await sendMessage(
        chatId,
        `✓ Pre-approved Admin <b>${escapeHtml(res.label)}</b>.\n\n<i>They will automatically get Admin access as soon as they message the bot.</i>`,
        env,
        null,
        msgId,
        threadId
      );
    }
    return;
  }

  if (promptState.type === 'status_user') {
    if (!isOwner(userId, env)) return;
    const rep = await buildUserStatusReport(text, msgObj?.forward_from || null, env);
    await sendMessage(chatId, rep.ok ? rep.text : rep.error, env, null, msgId, threadId);
    return;
  }

  if (promptState.type === 'req_group') {
    await handleGroupLinkRequest(chatId, userId, String(userId), text, env);
    return;
  }

  if (promptState.type === 'rename') {
    const raw = await getStore(env).get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `<i>Task session expired.</i>`, env, null, msgId, threadId);
      return;
    }
    const task = JSON.parse(raw);
    task.customName = text.replace(/[/\\?%*:|"<>]/g, '_').trim();
    if (!task.batch && task.customName && task.dest !== 'gofile') {
      const accessToken = await getValidAccessToken(task.credUserId || userId, env);
      if (accessToken) {
        const existing = await findDriveExisting(accessToken, task.folderId || 'root', task.customName);
        task.duplicateExists = existing.length > 0;
      }
    }
    await getStore(env).put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(chatId, `Renamed  ·  <code>${escapeHtml(task.customName)}</code>`, env, null, msgId, threadId);
    return;
  }

  if (promptState.type === 'select_filter') {
    const raw = await getStore(env).get(`task:${promptState.taskId}`);
    if (!raw) return;
    const task = JSON.parse(raw);
    task.selectFilter = text.toLowerCase() === 'all' ? '' : text.trim();
    await getStore(env).put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(
      chatId,
      task.selectFilter
        ? `Extension Filter  ·  <code>${escapeHtml(task.selectFilter)}</code>`
        : `Filter Cleared  ·  All extracted files will be uploaded.`,
      env,
      null,
      msgId,
      threadId
    );
    return;
  }

  if (promptState.type === 'archive_password') {
    const raw = await getStore(env).get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `<i>Task session expired.</i>`, env, null, msgId, threadId);
      return;
    }
    const task = JSON.parse(raw);
    const clear = text.toLowerCase() === 'clear' || text.toLowerCase() === 'none';
    task.archivePassword = clear ? '' : text;
    await getStore(env).put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
    await deleteMessage(chatId, msgId, env);

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(
      chatId,
      clear ? `Archive Password  ·  Cleared` : `Archive Password  ·  <code>Set (hidden)</code>`,
      env,
      null,
      null,
      threadId
    );
    return;
  }

  if (promptState.type === 'yt_sublang' || promptState.type === 'yt_plitems' || promptState.type === 'yt_trim') {
    const raw = await getStore(env).get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `<i>Task session expired.</i>`, env, null, msgId, threadId);
      return;
    }
    const task = JSON.parse(raw);
    const val = text.trim();
    const clear = val.toLowerCase() === 'clear' || val.toLowerCase() === 'none';
    let notice = '';

    if (promptState.type === 'yt_sublang') {
      task.ytSubLang = clear ? 'en' : val.replace(/\s+/g, '');
      notice = `Subtitle Language  ·  <code>${escapeHtml(task.ytSubLang)}</code>`;
    } else if (promptState.type === 'yt_plitems') {
      task.ytPlaylistItems = clear ? '' : val.replace(/\s+/g, '');
      notice = task.ytPlaylistItems
        ? `Playlist Items  ·  <code>${escapeHtml(task.ytPlaylistItems)}</code>`
        : `Playlist Items  ·  All items`;
    } else if (promptState.type === 'yt_trim') {
      if (clear) {
        task.ytTrim = '';
        notice = `Trim Range  ·  Cleared`;
      } else if (!/^\d{1,2}(?::\d{1,2}){0,2}-\d{1,2}(?::\d{1,2}){0,2}$/.test(val)) {
        await sendMessage(chatId, `Invalid format. Use <code>MM:SS-MM:SS</code> or <code>HH:MM:SS-HH:MM:SS</code> (e.g. <code>00:30-02:15</code>).`, env, null, msgId, threadId);
        return;
      } else {
        task.ytTrim = val;
        notice = `Trim Range  ·  <code>${escapeHtml(task.ytTrim)}</code>`;
      }
    }

    await getStore(env).put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(chatId, notice, env, null, msgId, threadId);
    return;
  }

  if (promptState.type === 'mkdir') {
    const accessToken = await getValidAccessToken(userId, env);
    if (!accessToken) {
      await sendMessage(chatId, `Please run /login first.`, env, null, msgId, threadId);
      return;
    }
    const newFolderName = text.trim();
    const parentId = promptState.parentId || 'root';
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newFolderName,
        mimeType: FOLDER_MIME,
        parents: [parentId]
      })
    });

    if (!createRes.ok) {
      await sendMessage(chatId, `Error  ·  Could not create folder on Google Drive.`, env, null, msgId, threadId);
      return;
    }
    const created = await createRes.json();
    await openFolderBrowser(chatId, userId, created.id, promptState.browserMsgId || null, promptState.returnTaskId || null, env, 0, threadId);
  }
}

// ============================================================================
// CALLBACK QUERY HANDLER
// ============================================================================

async function handleCallbackQuery(cb, env) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const chatType = cb.message.chat.type || 'private';
  const threadId = cb.message.message_thread_id || null;
  const userId = cb.from.id;
  const data = cb.data || '';
  if (cb.from && !cb.from.is_bot) {
    await indexTelegramUser(cb.from, env);
    await resolvePendingAdminOnSeen(cb.from, env);
    if (chatType === 'private') {
      const fullName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ');
      await bumpUserStats(cb.from.id, {}, { dmStarted: true, lastDmAt: Date.now(), username: cb.from.username || '', firstName: fullName }, env);
    }
  }

  if (data === 'req_admin') {
    if (await isAdmin(userId, env)) {
      await answerCb(cb.id, 'You already have Admin access! Send /start.', true, env);
      return;
    }
    const res = await sendAdminRequestNotification(cb.from, env);
    if (res.alreadyPending) {
      await answerCb(cb.id, 'Request already sent. Waiting for Owner review.', true, env);
    } else {
      await answerCb(cb.id, 'Request sent to Owner!', false, env);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Request Sent</b>\n\nYour Admin access request has been sent to the Owner. You will be notified once reviewed.</blockquote>`,
        env
      );
    }
    return;
  }

  if (data.startsWith('adm_req:')) {
    if (!isOwner(userId, env)) {
      await answerCb(cb.id, 'Owner only.', true, env);
      return;
    }
    const [, act, targetUid] = data.split(':');
    const reqRaw = await getStore(env).get(`req:admin:${targetUid}`);
    const reqData = reqRaw ? JSON.parse(reqRaw) : { userId: targetUid, username: '', firstName: `User ${targetUid}` };
    await getStore(env).delete(`req:admin:${targetUid}`);

    if (act === 'approve') {
      const admins = await getAdminsMap(env);
      admins[String(targetUid)] = {
        userId: String(targetUid),
        username: reqData.username || '',
        firstName: reqData.firstName || `User ${targetUid}`,
        addedAt: Date.now(),
        addedBy: getOwnerId(env)
      };
      await saveAdminsMap(admins, env);
      await answerCb(cb.id, 'Admin approved!', false, env);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Admin Approved ✓</b>\n\n${escapeHtml(reqData.firstName || targetUid)} (<code>${escapeHtml(targetUid)}</code>) is now an Admin.</blockquote>`,
        env
      );
      await sendMessage(
        targetUid,
        `<blockquote><b>Admin Access Granted ✓</b>\n\nThe Owner approved your request! Send /start to begin mirroring.</blockquote>`,
        env
      ).catch(() => {});
    } else {
      await answerCb(cb.id, 'Request denied.', false, env);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Admin Request Denied</b>\n\nUser <code>${escapeHtml(targetUid)}</code> was declined.</blockquote>`,
        env
      );
      await sendMessage(
        targetUid,
        `<blockquote><b>Admin Request Declined</b>\n\nYour request for Admin access was declined by the Owner.</blockquote>`,
        env
      ).catch(() => {});
    }
    return;
  }

  if (data.startsWith('grp_req:')) {
    if (!isOwner(userId, env)) {
      await answerCb(cb.id, 'Owner only.', true, env);
      return;
    }
    const [, act, targetCid] = data.split(':');
    if (act === 'dismiss') {
      await getStore(env).delete(`req:link:${targetCid}`);
      await editMessage(chatId, msgId, `<blockquote><b>Group Link Request Dismissed</b></blockquote>`, env);
      await answerCb(cb.id, 'Dismissed', false, env);
      return;
    }
    if (act === 'preapprove') {
      const chats = await getChatsMap(env);
      chats[String(targetCid)] = {
        chatId: String(targetCid),
        title: `Chat ${targetCid}`,
        type: String(targetCid).startsWith('-100') ? 'supergroup' : 'group',
        username: '',
        approvedBy: getOwnerId(env),
        credOwnerId: getOwnerId(env),
        approvedAt: Date.now()
      };
      await saveChatsMap(chats, env);
      await answerCb(cb.id, 'Chat pre-approved!', false, env);
      await editMessage(chatId, msgId, `<blockquote><b>Chat Pre-Approved ✓</b>\n\nChat ID: <code>${escapeHtml(targetCid)}</code></blockquote>`, env);
      return;
    }

    const reqRaw = await getStore(env).get(`req:chat:${targetCid}`);
    const reqData = reqRaw ? JSON.parse(reqRaw) : { chatId: targetCid, title: targetCid, type: 'group', username: '' };
    await getStore(env).delete(`req:chat:${targetCid}`);

    if (act === 'approve') {
      const chats = await getChatsMap(env);
      chats[String(targetCid)] = {
        chatId: String(targetCid),
        title: reqData.title || targetCid,
        type: reqData.type || 'group',
        username: reqData.username || '',
        approvedBy: getOwnerId(env),
        addedByUserId: reqData.requestedByUserId || getOwnerId(env),
        credOwnerId: getOwnerId(env),
        approvedAt: Date.now()
      };
      await saveChatsMap(chats, env);
      await answerCb(cb.id, 'Chat approved!', false, env);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Chat Approved ✓</b>\n\n<b>${escapeHtml(reqData.title || targetCid)}</b> (<code>${escapeHtml(targetCid)}</code>)</blockquote>`,
        env
      );
      if (reqData.type !== 'channel') {
        await sendMessage(
          targetCid,
          `<blockquote><b>Bot Authorized ✓</b></blockquote>\n\n` +
            `Approved by Owner! All members here can now use <code>/m</code>, <code>/yt</code>, <code>/login</code>, and <code>/help</code>.`,
          env
        ).catch(() => {});
      }
      if (reqData.requestedByUserId && !isOwner(reqData.requestedByUserId, env)) {
        await sendMessage(
          reqData.requestedByUserId,
          `<blockquote><b>Group Approved ✓</b>\n\n<b>${escapeHtml(reqData.title || targetCid)}</b> has been authorized by the Owner.</blockquote>`,
          env
        ).catch(() => {});
      }
    } else {
      await answerCb(cb.id, 'Denied & leaving chat.', false, env);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/leaveChat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: targetCid })
      }).catch(() => {});
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Chat Denied</b>\n\nDenied and left <b>${escapeHtml(reqData.title || targetCid)}</b> (<code>${escapeHtml(targetCid)}</code>).</blockquote>`,
        env
      );
    }
    return;
  }

  if (data === 'adm_close' || data === 'adm_add' || data.startsWith('adm_panel:') || data.startsWith('adm_del:') || data.startsWith('adm_pdel:') || data.startsWith('grp_del:')) {
    if (!isOwner(userId, env)) {
      await answerCb(cb.id, 'Owner only.', true, env);
      return;
    }
    if (data === 'adm_close') {
      await deleteMessage(chatId, msgId, env);
      await answerCb(cb.id, 'Closed', false, env);
      return;
    }
    if (data === 'adm_add') {
      await getStore(env).put(promptKey(chatId, userId), JSON.stringify({ type: 'add_admin_id' }), { expirationTtl: 600 });
      await answerCb(cb.id, 'Send @username or ID', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Add Admin</b></blockquote>\n\n` +
          `Send the user's <code>@username</code>, numeric User ID (e.g. <code>123456789</code>), or forward a message from them — or /cancel:`,
        env,
        null,
        null,
        threadId
      );
      return;
    }
    if (data.startsWith('adm_panel:')) {
      const tab = data.split(':')[1];
      const panel = await buildOwnerAdminPanel(tab, env);
      await editMessage(chatId, msgId, panel.text, env, panel.kb);
      await answerCb(cb.id, '', false, env);
      return;
    }
    if (data.startsWith('adm_del:')) {
      const targetUid = data.split(':')[1];
      const admins = await getAdminsMap(env);
      delete admins[targetUid];
      await saveAdminsMap(admins, env);
      await answerCb(cb.id, 'Admin removed', false, env);
      const panel = await buildOwnerAdminPanel('admins', env);
      await editMessage(chatId, msgId, panel.text, env, panel.kb);
      return;
    }
    if (data.startsWith('adm_pdel:')) {
      const unameLow = data.split(':')[1];
      const pending = await getPendingAdminsMap(env);
      delete pending[unameLow];
      await savePendingAdminsMap(pending, env);
      await answerCb(cb.id, 'Pending admin removed', false, env);
      const panel = await buildOwnerAdminPanel('admins', env);
      await editMessage(chatId, msgId, panel.text, env, panel.kb);
      return;
    }
    if (data.startsWith('grp_del:')) {
      const targetCid = data.split(':')[1];
      const chats = await getChatsMap(env);
      delete chats[targetCid];
      await saveChatsMap(chats, env);
      await answerCb(cb.id, 'Chat revoked', false, env);
      const panel = await buildOwnerAdminPanel('chats', env);
      await editMessage(chatId, msgId, panel.text, env, panel.kb);
      return;
    }
  }

  if (data === 'st_user_prompt' || data === 'st_active_tasks') {
    if (!isOwner(userId, env)) {
      await answerCb(cb.id, 'Owner only.', true, env);
      return;
    }
    if (data === 'st_user_prompt') {
      await getStore(env).put(promptKey(chatId, userId), JSON.stringify({ type: 'status_user' }), { expirationTtl: 600 });
      await answerCb(cb.id, 'Send @username or ID', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Check User Status</b></blockquote>\n\n` +
          `Send the user's <code>@username</code>, numeric User ID, or forward a message from them — or /cancel:`,
        env,
        null,
        null,
        threadId
      );
      return;
    }
    await answerCb(cb.id, 'Loading active tasks...', false, env);
    await sendActiveTasks(chatId, userId, env, null, threadId);
    return;
  }

  if (data.startsWith('leech_del:')) {
    const jobId = data.split(':')[1];
    const raw = await getStore(env).get(`leech_del:${jobId}`);
    if (!raw) {
      await answerCb(cb.id, 'Already deleted or expired.', true, env);
      await editMessage(chatId, msgId, `<blockquote><b>🗑 File(s) Deleted ✓</b></blockquote>\n\n<i>These leeched file(s) have already been removed.</i>`, env, { inline_keyboard: [] });
      return;
    }
    const rec = JSON.parse(raw);
    const allowed =
      String(rec.userId) === String(userId) ||
      isOwner(userId, env) ||
      (chatType !== 'private' && await isAdmin(userId, env));
    if (!allowed) {
      await answerCb(cb.id, 'Only the requester or Admin/Owner can delete these files.', true, env);
      return;
    }

    const ids = Array.isArray(rec.fileMsgIds) ? rec.fileMsgIds.filter(Boolean) : [];
    for (const mid of ids) {
      await deleteMessage(rec.chatId || chatId, mid, env).catch(() => {});
    }
    await getStore(env).delete(`leech_del:${jobId}`);
    if (env.STATE_DO) {
      const stub = env.STATE_DO.get(env.STATE_DO.idFromName('global'));
      await stub.fetch(`https://state.do/leech-schedule?job_id=${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
    }
    await answerCb(cb.id, 'Deleted uploaded file(s)!', false, env);
    await editMessage(
      chatId,
      msgId,
      `<blockquote><b>🗑 File(s) Deleted ✓</b></blockquote>\n\n<i>All leeched file(s) from this task have been removed.</i>`,
      env,
      { inline_keyboard: [] }
    );
    return;
  }

  if (data.startsWith('perm_req:')) {
    const jobId = data.split(':')[1];
    if (chatType === 'channel' && !(await isAdmin(userId, env))) {
      await answerCb(cb.id, 'Only Admins/Owner can request this in a channel.', true, env);
      return;
    }
    const raw = await getStore(env).get(`gc_exp:${jobId}`);
    if (!raw) {
      const cleanedKb = stripPermReqFromRows(cb.message?.reply_markup?.inline_keyboard);
      if (cleanedKb) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: msgId, reply_markup: cleanedKb })
        }).catch(() => {});
      }
      await answerCb(cb.id, 'Already processed or expired.', true, env);
      return;
    }
    const rec = JSON.parse(raw);
    if (rec.permApproved || rec.permDenied || rec.permRequested) {
      if (!rec.msgId && msgId) rec.msgId = msgId;
      if (!rec.mirrorKbRows && Array.isArray(cb.message?.reply_markup?.inline_keyboard)) {
        rec.mirrorKbRows = cb.message.reply_markup.inline_keyboard;
      }
      const alreadyMsg = rec.permApproved
        ? 'Already moved to permanent storage!'
        : rec.permDenied
          ? 'Permanent storage request was already declined.'
          : 'Permanent storage request already sent to Owner.';
      const statusHtml = rec.permApproved
        ? `✅ <b>Moved to Permanent Storage (<code>${escapeHtml(GC_PERM_FOLDER_NAME)}</code>)</b> — 5-day auto-delete cancelled.`
        : rec.permDenied
          ? `❌ <b>Permanent Storage Declined</b> — File(s) remain in 5-day temporary storage and will auto-delete after 5 days.`
          : `⏳ <b>Permanent Storage Requested</b> by ${escapeHtml(rec.permRequesterName || 'User')} — awaiting Owner review.`;
      await updateGcMirrorPermMessage(rec, statusHtml, env, { approved: !!rec.permApproved });
      await answerCb(cb.id, alreadyMsg, true, env);
      return;
    }
    if (rec.totalSize > PERM_REQ_MAX_BYTES) {
      await answerCb(cb.id, 'Files larger than 50 GB cannot be moved to permanent storage.', true, env);
      return;
    }

    rec.permRequested = true;
    rec.permDenied = false;
    rec.permRequesterId = String(userId);
    rec.permRequesterName = cb.from.username ? `@${cb.from.username}` : (cb.from.first_name || 'User');
    if (!rec.chatId) rec.chatId = String(chatId);
    if (!rec.msgId && msgId) rec.msgId = msgId;
    if (!rec.mirrorKbRows && Array.isArray(cb.message?.reply_markup?.inline_keyboard)) {
      rec.mirrorKbRows = cb.message.reply_markup.inline_keyboard;
    }
    await getStore(env).put(`gc_exp:${jobId}`, JSON.stringify(rec));

    await updateGcMirrorPermMessage(
      rec,
      `⏳ <b>Permanent Storage Requested</b> by ${escapeHtml(rec.permRequesterName)} — awaiting Owner review.`,
      env
    );

    const fileLines = (rec.files || []).slice(0, 6).map(f =>
      `• <a href="${escapeHtml(f.link || 'https://drive.google.com')}">${escapeHtml(truncate(f.name || 'File', 42))}</a> (<code>${fmtBytes(f.size || 0)}</code>)`
    ).join('\n');
    const extraLine = (rec.files || []).length > 6 ? `\n<i>…and ${rec.files.length - 6} more</i>` : '';

    await sendMessage(
      getOwnerId(env),
      `<blockquote><b>Permanent Storage Request (gcusrfiles)</b></blockquote>\n\n` +
        `Chat  ·  <b>${escapeHtml(rec.chatTitle || String(rec.chatId))}</b> (<code>${escapeHtml(String(rec.chatId))}</code>)\n` +
        `Requested By  ·  ${escapeHtml(rec.permRequesterName)} (<code>${escapeHtml(String(userId))}</code>)\n` +
        `Total Size  ·  <code>${fmtBytes(rec.totalSize || 0)}</code>\n\n` +
        `${fileLines}${extraLine}\n\n` +
        `<i>Approve to move from ${escapeHtml(GC_TEMP_FOLDER_NAME)} → ${escapeHtml(GC_PERM_FOLDER_NAME)}?</i>`,
      env,
      {
        inline_keyboard: [[
          { text: `✅ Move to ${GC_PERM_FOLDER_NAME}`, callback_data: `perm_act:approve:${jobId}`, style: 'success' },
          { text: '❌ Deny', callback_data: `perm_act:deny:${jobId}`, style: 'danger' }
        ]]
      }
    );
    await answerCb(cb.id, 'Request sent to Owner!', false, env);
    return;
  }

  if (data.startsWith('perm_act:')) {
    if (!isOwner(userId, env)) {
      await answerCb(cb.id, 'Owner only.', true, env);
      return;
    }
    const [, act, jobId] = data.split(':');
    const raw = await getStore(env).get(`gc_exp:${jobId}`);
    if (!raw) {
      await answerCb(cb.id, 'Record expired or already handled.', true, env);
      await editMessage(chatId, msgId, `<blockquote><b>Request Expired</b>\n\nThis file record is no longer pending.</blockquote>`, env);
      return;
    }
    const rec = JSON.parse(raw);

    if (rec.permApproved || rec.permDenied) {
      await answerCb(cb.id, 'Already handled.', true, env);
      await editMessage(
        chatId,
        msgId,
        rec.permApproved
          ? `<blockquote><b>Already Approved</b>\n\nMoved to <code>${escapeHtml(GC_PERM_FOLDER_NAME)}</code>.</blockquote>`
          : `<blockquote><b>Already Declined</b>\n\nFiles remain in 5-day temporary storage.</blockquote>`,
        env
      );
      return;
    }

    if (act === 'deny') {
      rec.permRequested = false;
      rec.permDenied = true;
      await getStore(env).put(`gc_exp:${jobId}`, JSON.stringify(rec));
      await answerCb(cb.id, 'Declined', false, env);
      await editMessage(chatId, msgId, `<blockquote><b>Permanent Request Declined</b>\n\nFiles will remain in 5-day temporary storage.</blockquote>`, env);
      await updateGcMirrorPermMessage(
        rec,
        `❌ <b>Permanent Storage Declined</b> — File(s) will remain in 5-day temporary storage and auto-delete after <b>5 days</b>. Use /login with your personal Google Drive for permanent storage.`,
        env
      );
      return;
    }

    const credUid = String(rec.credUserId || getOwnerId(env));
    const accessToken = await getValidAccessToken(credUid, env);
    if (!accessToken) {
      await answerCb(cb.id, 'Owner Drive token expired. Run /login.', true, env);
      return;
    }
    const permFolder = await ensureOwnerDriveFolder(accessToken, 'gc_perm_folder', GC_PERM_FOLDER_NAME, env);
    if (!permFolder?.folderId) {
      await answerCb(cb.id, 'Could not find/create gcusrfiles folder.', true, env);
      return;
    }

    let movedCount = 0;
    for (const f of rec.files || []) {
      if (f?.id) {
        const ok = await moveDriveItemToFolder(accessToken, f.id, permFolder.folderId);
        if (ok) movedCount++;
      }
    }

    if (!movedCount) {
      await answerCb(cb.id, 'Could not move files (maybe already deleted).', true, env);
      return;
    }

    rec.permApproved = true;
    await getStore(env).delete(`gc_exp:${jobId}`);
    const idx = await getGcExpIndex(env);
    if (idx.includes(jobId)) {
      await saveGcExpIndex(idx.filter(id => id !== jobId), env);
    }

    await answerCb(cb.id, `Moved ${movedCount} item(s) to ${GC_PERM_FOLDER_NAME}!`, false, env);
    await editMessage(
      chatId,
      msgId,
      `<blockquote><b>Moved to Permanent Storage ✓</b></blockquote>\n\n` +
        `Folder  ·  <code>${escapeHtml(GC_PERM_FOLDER_NAME)}</code>\n` +
        `Items Moved  ·  <code>${movedCount}</code>`,
      env
    );
    await updateGcMirrorPermMessage(
      rec,
      `✅ <b>Moved to Permanent Storage (<code>${escapeHtml(GC_PERM_FOLDER_NAME)}</code>)</b> — 5-day auto-delete cancelled.`,
      env,
      { approved: true, permFolderUrl: permFolder.folderUrl || '' }
    );
    return;
  }

  if (data.startsWith('fb_')) {
    const bRaw = await getStore(env).get(`browser:${userId}`);
    if (!bRaw && data !== 'fb_close') {
      await answerCb(cb.id, 'Session expired. Run /setdldir again.', true, env);
      return;
    }
    const bState = bRaw ? JSON.parse(bRaw) : null;

    if (data === 'fb_close') {
      await deleteMessage(chatId, msgId, env);
      await answerCb(cb.id, 'Closed', false, env);
      return;
    }
    if (data === 'fb_noop') {
      await answerCb(cb.id, '', false, env);
      return;
    }
    if (data.startsWith('fb_open:')) {
      const idx = parseInt(data.split(':')[1], 10);
      const item = bState.items[idx];
      if (!item || !item.isFolder) {
        await answerCb(cb.id, 'Not a folder', false, env);
        return;
      }
      await answerCb(cb.id, `Opening ${item.name}`, false, env);
      await openFolderBrowser(chatId, userId, item.id, msgId, bState.returnTaskId, env, 0, bState.threadId || threadId);
      return;
    }
    if (data.startsWith('fb_file:')) {
      const idx = parseInt(data.split(':')[1], 10);
      const item = bState.items[idx];
      if (item) {
        await answerCb(cb.id, `${item.name} (${fmtBytes(item.size)})`, true, env);
      }
      return;
    }
    if (data.startsWith('fb_page:')) {
      const nextPage = parseInt(data.split(':')[1], 10);
      await answerCb(cb.id, `Page ${nextPage + 1}`, false, env);
      await renderFolderBrowserPage(chatId, userId, bState, nextPage, msgId, env);
      return;
    }
    if (data === 'fb_up') {
      await answerCb(cb.id, 'Parent folder', false, env);
      await openFolderBrowser(chatId, userId, bState.parentId || 'root', msgId, bState.returnTaskId, env, 0, bState.threadId || threadId);
      return;
    }
    if (data === 'fb_mkdir') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({
          type: 'mkdir',
          parentId: bState.currentId,
          browserMsgId: msgId,
          returnTaskId: bState.returnTaskId
        }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send new folder name', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>New Folder</b>\n\nParent  ·  <code>${escapeHtml(bState.currentName)}</code></blockquote>\n\n` +
          `Send the folder name now, or /cancel:`,
        env,
        null,
        null,
        bState.threadId || threadId
      );
      return;
    }
    if (data === 'fb_sel') {
      const profile = await getUserProfile(userId, env);
      if (profile) {
        profile.folderId = bState.currentId;
        profile.folderName = bState.currentName;
        await saveUserProfile(userId, profile, env);
      }

      if (bState.returnTaskId) {
        const tRaw = await getStore(env).get(`task:${bState.returnTaskId}`);
        if (tRaw) {
          const task = JSON.parse(tRaw);
          if (await canControlRecord(task, userId, env)) {
            task.dest = 'gdrive';
            task.hasDrive = true;
            task.driveFolderId = bState.currentId;
            task.driveFolderName = bState.currentName;
            task.folderId = bState.currentId;
            task.folderName = bState.currentName;
            if (!task.batch) {
              const accessToken = await getValidAccessToken(userId, env);
              if (accessToken) {
                const ex = await findDriveExisting(accessToken, task.folderId, task.customName || task.detectedName);
                task.duplicateExists = ex.length > 0;
              }
            }
            await getStore(env).put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
            await answerCb(cb.id, `Folder: ${bState.currentName}`, false, env);
            await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
            return;
          }
        }
      }

      await answerCb(cb.id, `Selected: ${bState.currentName}`, false, env);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Upload Directory Updated</b></blockquote>\n\n` +
          `Destination  ·  ${escapeHtml(bState.currentName)}\n\n` +
          `Change anytime  ·  /setdldir`,
        env
      );
      return;
    }
    if (data.startsWith('fb_back:')) {
      const tid = data.split(':')[1];
      const tRaw = await getStore(env).get(`task:${tid}`);
      if (tRaw) {
        const task = JSON.parse(tRaw);
        if (await canControlRecord(task, userId, env)) {
          await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
        }
      }
      await answerCb(cb.id, 'Returned to task', false, env);
      return;
    }
  }

  if (data.startsWith('tm_try_yt:')) {
    const retryId = data.split(':')[1];
    const rRaw = await getStore(env).get(`retry:${retryId}`);
    if (!rRaw) {
      await answerCb(cb.id, 'Link expired. Send the URL with /yt.', true, env);
      return;
    }
    const rData = JSON.parse(rRaw);
    if (!(await canControlRecord(rData, userId, env))) {
      await answerCb(cb.id, 'You can only retry your own link.', true, env);
      return;
    }
    await getStore(env).delete(`retry:${retryId}`);
    await answerCb(cb.id, 'Switching to yt-dlp mode...', false, env);
    const uname = cb.from.username || cb.from.first_name || 'User';
    const chatRecord = chatType !== 'private' ? await getApprovedChat(chatId, env) : null;
    await startTaskFromUrls(chatId, userId, uname, rData.replyToMsgId || msgId, [rData.url], env, {
      forceYtdl: true,
      editMsgId: msgId,
      chatType: rData.chatType || chatType,
      chatRecord,
      threadId: rData.threadId || threadId
    });
    return;
  }

  if (data.startsWith('tm_')) {
    const parts = data.split(':');
    const action = parts[0];
    const tid = parts[1];
    const arg = parts[2];

    const tRaw = await getStore(env).get(`task:${tid}`);
    if (!tRaw) {
      await answerCb(cb.id, 'Task session expired.', true, env);
      return;
    }
    const task = JSON.parse(tRaw);
    if (!(await canControlRecord(task, userId, env))) {
      await answerCb(cb.id, 'You can only modify your own task.', true, env);
      return;
    }
    task.menuMsgId = msgId;

    if (action === 'tm_cancel') {
      await getStore(env).delete(`task:${tid}`);
      if (!task.isChannel) {
        await bumpUserStats(task.userId || userId, { cancelled: 1 }, {}, env);
      }
      await editMessage(chatId, msgId, `<blockquote><b>Task Cancelled</b></blockquote>`, env);
      await answerCb(cb.id, 'Cancelled', false, env);
      return;
    }

    if (action === 'tm_back') {
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, 'Updated', false, env);
      return;
    }

    if (action === 'tm_ytqual') {
      const { text, kb } = buildYtdlQualityMenu(task);
      await editMessage(chatId, msgId, text, env, kb);
      await answerCb(cb.id, 'Select quality', false, env);
      return;
    }

    if (action === 'tm_ytqset' && YT_QUALITY_LABELS[arg]) {
      task.ytQuality = arg;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Quality: ${ytQualityLabel(arg)}`, false, env);
      return;
    }

    if (action === 'tm_ytcont') {
      const curIdx = YT_CONTAINERS.indexOf(task.ytContainer || 'mp4');
      task.ytContainer = YT_CONTAINERS[(curIdx + 1) % YT_CONTAINERS.length];
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Container: ${ytContainerLabel(task.ytContainer)}`, false, env);
      return;
    }

    if (action === 'tm_ytsubs') {
      task.ytSubs = !task.ytSubs;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Subtitles: ${task.ytSubs ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ytslang') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({ type: 'yt_sublang', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send subtitle language', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Subtitle Language</b>\n\nCurrent  ·  <code>${escapeHtml(task.ytSubLang || 'en')}</code></blockquote>\n\n` +
          `Send language code(s) (e.g. <code>en</code>, <code>en,hi</code>, <code>all</code>), or /cancel:`,
        env,
        null,
        null,
        task.threadId || threadId
      );
      return;
    }

    if (action === 'tm_ytmeta') {
      task.ytMeta = task.ytMeta === false;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Metadata & Thumb: ${task.ytMeta ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ytsb') {
      task.ytSponsorBlock = !task.ytSponsorBlock;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `SponsorBlock: ${task.ytSponsorBlock ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ytpl') {
      task.ytPlaylist = task.ytPlaylist === 'all' ? 'single' : 'all';
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Playlist: ${task.ytPlaylist === 'all' ? 'All Items' : 'Single Video'}`, false, env);
      return;
    }

    if (action === 'tm_ytplitems') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({ type: 'yt_plitems', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send playlist range', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Playlist Items</b></blockquote>\n\n` +
          `Send item indices/ranges (e.g. <code>1-5</code> or <code>1,3,7-10</code>), <code>clear</code> for all, or /cancel:`,
        env,
        null,
        null,
        task.threadId || threadId
      );
      return;
    }

    if (action === 'tm_yttrim') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({ type: 'yt_trim', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send trim range', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Trim / Clip Section</b></blockquote>\n\n` +
          `Send start and end timestamps (e.g. <code>00:30-02:15</code> or <code>1:05:00-1:10:00</code>), <code>clear</code> to remove, or /cancel:`,
        env,
        null,
        null,
        task.threadId || threadId
      );
      return;
    }

    if (action === 'tm_ext') {
      task.mode = task.mode === 'extract' ? 'normal' : 'extract';
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Extract: ${task.mode === 'extract' ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_zip') {
      task.mode = task.mode === 'zip' ? 'normal' : 'zip';
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Create ZIP: ${task.mode === 'zip' ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_share') {
      if (task.isSharedGcTemp) {
        await answerCb(cb.id, 'Shared GC links are always public.', false, env);
        return;
      }
      task.share = !task.share;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Share Link: ${task.share ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_confmenu') {
      const { text, kb } = buildConflictMenu(task);
      await editMessage(chatId, msgId, text, env, kb);
      await answerCb(cb.id, 'Duplicate Handling', false, env);
      return;
    }

    if (action === 'tm_confset' && ['rename', 'overwrite', 'skip'].includes(arg)) {
      task.conflict = arg;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Duplicate: ${conflictLabel(arg)}`, false, env);
      return;
    }

    if (action === 'tm_ren') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({ type: 'rename', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send new file name', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Rename File</b>\n\n<code>${escapeHtml(task.customName || task.detectedName)}</code></blockquote>\n\n` +
          `Send the new filename (including extension), or /cancel:`,
        env,
        null,
        null,
        task.threadId || threadId
      );
      return;
    }

    if (action === 'tm_sel') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({ type: 'select_filter', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send extension filter', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Archive Extension Filter</b></blockquote>\n\n` +
          `Send comma-separated extensions to keep when extracting (e.g. <code>.mkv, .mp4, .srt</code>) or send <code>all</code>:`,
        env,
        null,
        null,
        task.threadId || threadId
      );
      return;
    }

    if (action === 'tm_pass') {
      await getStore(env).put(
        promptKey(chatId, userId),
        JSON.stringify({ type: 'archive_password', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send archive password', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Archive Password</b></blockquote>\n\n` +
          `Send the password to ${task.mode === 'zip' ? 'encrypt the ZIP' : 'extract the archive'}, send <code>clear</code> to remove, or /cancel.\n\n` +
          `<i>Your password message will be deleted immediately after saving.</i>`,
        env,
        null,
        null,
        task.threadId || threadId
      );
      return;
    }

    if (action === 'tm_asdoc') {
      task.leechAsDoc = !task.leechAsDoc;
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Upload As: ${task.leechAsDoc ? 'Document' : 'Media (Auto)'}`, false, env);
      return;
    }

    if (action === 'tm_dest') {
      const profile = await getUserProfile(userId, env);
      const canUseSharedGc = !!(task.chatType && task.chatType !== 'private' && task.driveFolderId && !hasDriveAuth(profile));
      if (!hasDriveAuth(profile) && !canUseSharedGc) {
        if (task.dest === 'gofile') {
          task.dest = 'telegram';
          task.isSharedGcTemp = false;
          task.folderId = '';
          task.folderName = 'Telegram (Leech)';
        } else {
          task.dest = 'gofile';
          task.isSharedGcTemp = false;
          task.folderId = '';
          task.folderName = 'Gofile (Guest)';
        }
        task.duplicateExists = false;
        await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
        await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
        await answerCb(cb.id, `Destination: ${task.dest === 'telegram' ? 'Telegram (Leech)' : 'Gofile (Temp)'}`, false, env);
        return;
      }

      if (canUseSharedGc) {
        if (task.dest === 'gdrive') {
          task.dest = 'gofile';
          task.isSharedGcTemp = false;
          task.folderId = '';
          task.folderName = 'Gofile (Guest)';
          task.duplicateExists = false;
        } else if (task.dest === 'gofile') {
          task.dest = 'telegram';
          task.isSharedGcTemp = false;
          task.folderId = '';
          task.folderName = 'Telegram (Leech)';
          task.duplicateExists = false;
        } else {
          task.dest = 'gdrive';
          task.isSharedGcTemp = true;
          task.folderId = task.driveFolderId;
          task.folderName = task.driveFolderName || GC_TEMP_FOLDER_NAME;
          task.share = true;
        }
      } else {
        task.hasDrive = true;
        task.isSharedGcTemp = false;
        task.credUserId = String(userId);
        if (task.dest === 'gdrive') {
          task.dest = 'gofile';
          task.driveFolderId = task.folderId || profile.folderId || 'root';
          task.driveFolderName = task.folderName || profile.folderName || 'My Drive';
          task.folderId = '';
          task.folderName = 'Gofile (Guest)';
          task.duplicateExists = false;
        } else if (task.dest === 'gofile') {
          task.dest = 'telegram';
          task.folderId = '';
          task.folderName = 'Telegram (Leech)';
          task.duplicateExists = false;
        } else {
          task.dest = 'gdrive';
          task.folderId = task.driveFolderId || profile.folderId || 'root';
          task.folderName = task.driveFolderName || profile.folderName || 'My Drive';
          if (!task.batch) {
            const accessToken = await getValidAccessToken(userId, env);
            if (accessToken) {
              const ex = await findDriveExisting(accessToken, task.folderId, task.customName || task.detectedName);
              task.duplicateExists = ex.length > 0;
            }
          }
        }
      }
      await getStore(env).put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Destination: ${task.dest === 'telegram' ? 'Telegram (Leech)' : (task.dest === 'gofile' ? 'Gofile (Temp)' : (task.isSharedGcTemp ? 'GC Drive (5d)' : 'Google Drive'))}`, false, env);
      return;
    }

    if (action === 'tm_dir') {
      const profile = await getUserProfile(userId, env);
      if (!hasDriveAuth(profile)) {
        const uname = cb.from.username || cb.from.first_name || 'User';
        const authUrl = await createOAuthUrl(chatId, userId, uname, env);
        await answerCb(cb.id, 'Connect Google Drive first', false, env);
        await sendMessage(
          chatId,
          `Connect your Google Drive account to choose a Drive folder.`,
          env,
          { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] },
          null,
          task.threadId || threadId
        );
        return;
      }
      await answerCb(cb.id, 'Opening Folder Browser', false, env);
      await openFolderBrowser(chatId, userId, task.driveFolderId || task.folderId || 'root', msgId, tid, env, 0, task.threadId || threadId);
      return;
    }

    if (action === 'tm_info') {
      const rangeLine = task.isDrive
        ? `Transfer  ·  Server-Side / Drive API`
        : task.isTgMedia
          ? `Transfer  ·  Telegram MTProto (Kurigram)`
          : `Range I/O  ·  ${task.acceptRanges ? 'Supported (16x parallel)' : 'Single Stream'}`;
      const viaLine = task.resolvedVia ? `\n\nResolved  ·  ${escapeHtml(task.resolvedVia)}` : '';
      const dupLine = task.duplicateExists ? `\n\nDuplicate  ·  Exists in target folder` : '';
      const infoMsg =
        `<blockquote><b>Stream Metadata</b>\n\n` +
        `<code>${escapeHtml(task.detectedName)}</code></blockquote>\n\n` +
        `Size  ·  <code>${task.fileSize > 0 ? fmtBytes(task.fileSize) : 'Unknown'}</code>` +
        `${task.fileSize > 0 ? `  (<code>${task.fileSize.toLocaleString()} B</code>)` : ''}\n\n` +
        `MIME  ·  <code>${escapeHtml(task.contentType)}</code>\n\n` +
        `${rangeLine}${viaLine}${dupLine}`;
      await editMessage(chatId, msgId, infoMsg, env, {
        inline_keyboard: [[{ text: '↩ Back to Options', callback_data: `tm_back:${tid}`, style: 'primary' }]]
      });
      await answerCb(cb.id, 'Stream Metadata', false, env);
      return;
    }

    if (action === 'tm_nobtn') {
      const stored = await getUserProfile(userId, env);
      const profile = getEffectiveProfile(userId, stored);
      profile.buttonMode = false;
      await saveUserProfile(userId, profile, env);
      await answerCb(cb.id, 'ButtonMode disabled. Starting...', false, env);
      await launchMirrorTask(task, env);
      return;
    }

    if (action === 'tm_start') {
      await answerCb(cb.id, 'Starting...', false, env);
      await launchMirrorTask(task, env);
      return;
    }
  }

  if (data.startsWith('st_')) {
    const [action, jobId] = data.split(':');
    const jr = await getStore(env).get(`job:${jobId}`);
    const job = jr ? JSON.parse(jr) : null;

    if (action === 'st_ref') {
      await answerCb(cb.id, 'Live telemetry updates every 2.5s automatically.', false, env);
      return;
    }

    if (job && !(await canControlRecord(job, userId, env))) {
      await answerCb(cb.id, 'You can only control your own task.', true, env);
      return;
    }

    if (action === 'st_close') {
      await deleteMessage(chatId, msgId, env);
      if (job) {
        job.messageId = '';
        await getStore(env).put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
      }
      await answerCb(cb.id, 'Closed — use /tasks to reopen', false, env);
      return;
    }
    if (action === 'st_cancel') {
      await answerCb(cb.id, 'Stopping task...', false, env);
      await cancelActiveJob(chatId, userId, jobId, env, threadId);
      return;
    }
  }

  if (data.startsWith('tg_dec:')) {
    const [, jobId, choice] = data.split(':');
    if (choice !== 'lt2gb' && choice !== 'skip') {
      await answerCb(cb.id, 'Unknown option.', true, env);
      return;
    }
    const jr = await getStore(env).get(`job:${jobId}`);
    if (!jr) {
      await answerCb(cb.id, 'Task already finished or expired.', true, env);
      return;
    }
    const job = JSON.parse(jr);
    if (!(await canControlRecord(job, userId, env))) {
      await answerCb(cb.id, 'You can only control your own task.', true, env);
      return;
    }
    job.tgDecision = choice;
    await getStore(env).put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
    await answerCb(
      cb.id,
      choice === 'lt2gb' ? 'Uploading < 2 GB files to Telegram...' : 'Skipping Telegram upload...',
      false,
      env
    );
    await editMessage(
      chatId,
      msgId,
      choice === 'lt2gb'
        ? `<blockquote><b>Telegram Media Upload</b>\n\nConfirmed: uploading files under 2 GB to this chat and skipping oversized files.</blockquote>`
        : `<blockquote><b>Telegram Media Upload Skipped</b>\n\nSkipped Telegram media upload. Continuing standard mirror upload...</blockquote>`,
      env
    );
    return;
  }

  if (data === 'hist_clear') {
    await getStore(env).delete(`history:${userId}`);
    await answerCb(cb.id, 'History cleared', false, env);
    await sendHistory(chatId, userId, msgId, env, threadId);
    return;
  }

  if (data.startsWith('cfg_')) {
    const stored = await getUserProfile(userId, env);
    const profile = getEffectiveProfile(userId, stored);
    if (data === 'cfg_toggle_dest') {
      if (hasDriveAuth(stored)) {
        const order = ['gdrive', 'gofile', 'telegram'];
        const curIdx = order.indexOf(profile.defaultDest);
        profile.defaultDest = order[(curIdx + 1) % order.length];
      } else {
        profile.defaultDest = profile.defaultDest === 'telegram' ? 'gofile' : 'telegram';
      }
      await saveUserProfile(userId, profile, env);
      const label = profile.defaultDest === 'telegram'
        ? 'Telegram (Leech)'
        : (profile.defaultDest === 'gofile' ? 'Gofile (Temp)' : 'Google Drive');
      await answerCb(cb.id, `Default Dest: ${label}`, false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_toggle_asdoc') {
      profile.leechAsDoc = !profile.leechAsDoc;
      await saveUserProfile(userId, profile, env);
      await answerCb(cb.id, `Leech As: ${profile.leechAsDoc ? 'Document' : 'Media (Auto)'}`, false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_toggle_btn') {
      profile.buttonMode = !profile.buttonMode;
      await saveUserProfile(userId, profile, env);
      await answerCb(cb.id, `ButtonMode: ${profile.buttonMode ? 'ON' : 'OFF'}`, false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_toggle_share') {
      profile.autoShare = !profile.autoShare;
      await saveUserProfile(userId, profile, env);
      await answerCb(cb.id, `Auto Share: ${profile.autoShare ? 'ON' : 'OFF'}`, false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_conf_menu') {
      const cur = profile.conflict || 'rename';
      const mark = (v, l) => (cur === v ? `✓ ${l}` : l);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Default Duplicate Policy</b></blockquote>\n\n` +
          `Choose what happens when a file with the same name already exists in your Drive folder:`,
        env,
        {
          inline_keyboard: [
            [
              { text: mark('rename', 'Rename (Keep Both)'), callback_data: 'cfg_conf:rename', style: cur === 'rename' ? 'success' : undefined },
              { text: mark('overwrite', 'Overwrite'), callback_data: 'cfg_conf:overwrite', style: cur === 'overwrite' ? 'success' : undefined }
            ],
            [
              { text: mark('skip', 'Skip'), callback_data: 'cfg_conf:skip', style: cur === 'skip' ? 'success' : undefined },
              { text: '↩ Back', callback_data: 'cfg_back', style: 'primary' }
            ]
          ]
        }
      );
      await answerCb(cb.id, 'Duplicate Policy', false, env);
      return;
    }
    if (data.startsWith('cfg_conf:')) {
      const val = data.split(':')[1];
      if (['rename', 'overwrite', 'skip'].includes(val)) {
        profile.conflict = val;
        await saveUserProfile(userId, profile, env);
        await answerCb(cb.id, `Duplicate: ${conflictLabel(val)}`, false, env);
      }
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_back') {
      await answerCb(cb.id, 'Preferences', false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_yt_menu') {
      const q = profile.ytQuality || 'best';
      const c = profile.ytContainer || 'mp4';
      const qBtn = (val, label) => ({
        text: q === val ? `✓ ${label}` : label,
        callback_data: `cfg_ytq:${val}`,
        style: q === val ? 'success' : undefined
      });
      const cBtn = (val, label) => ({
        text: c === val ? `✓ ${label}` : label,
        callback_data: `cfg_ytc:${val}`,
        style: c === val ? 'primary' : undefined
      });
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Default Media (yt-dlp) Settings</b></blockquote>\n\n` +
          `Quality  ·  <code>${ytQualityLabel(q)}</code>\n` +
          `Container  ·  <code>${ytContainerLabel(c)}</code>`,
        env,
        {
          inline_keyboard: [
            [qBtn('best', 'Best'), qBtn('2160', '4K'), qBtn('1440', '2K')],
            [qBtn('1080', '1080p'), qBtn('720', '720p'), qBtn('480', '480p')],
            [qBtn('mp3', 'MP3'), qBtn('m4a', 'M4A'), qBtn('opus', 'Opus')],
            [cBtn('mp4', 'MP4'), cBtn('mkv', 'MKV'), cBtn('auto', 'Auto')],
            [{ text: '↩ Back', callback_data: 'cfg_back', style: 'primary' }]
          ]
        }
      );
      await answerCb(cb.id, 'Media Defaults', false, env);
      return;
    }
    if (data.startsWith('cfg_ytq:')) {
      const val = data.split(':')[1];
      if (YT_QUALITY_LABELS[val]) {
        profile.ytQuality = val;
        await saveUserProfile(userId, profile, env);
        await answerCb(cb.id, `Default Quality: ${ytQualityLabel(val)}`, false, env);
      }
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data.startsWith('cfg_ytc:')) {
      const val = data.split(':')[1];
      if (YT_CONTAINERS.includes(val)) {
        profile.ytContainer = val;
        await saveUserProfile(userId, profile, env);
        await answerCb(cb.id, `Default Container: ${ytContainerLabel(val)}`, false, env);
      }
      await sendSettingsMenu(chatId, userId, profile, msgId, env, threadId);
      return;
    }
    if (data === 'cfg_dir') {
      if (!hasDriveAuth(stored)) {
        const uname = cb.from.username || cb.from.first_name || 'User';
        const authUrl = await createOAuthUrl(chatId, userId, uname, env);
        await answerCb(cb.id, 'Connect Google Drive first', false, env);
        await sendMessage(
          chatId,
          `Connect your Google Drive account first to browse Drive folders.`,
          env,
          { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] },
          null,
          threadId
        );
        return;
      }
      await answerCb(cb.id, 'Opening directory browser', false, env);
      await openFolderBrowser(chatId, userId, profile.folderId || 'root', msgId, null, env, 0, threadId);
      return;
    }
  }
}

// ============================================================================
// PRE-FLIGHT SPACE VERIFICATION, DIRECT DRIVE COPY & WORKFLOW LAUNCH
// ============================================================================

async function launchMirrorTask(task, env) {
  const { chatId, userId, taskId, menuMsgId } = task;
  const credUserId = String(task.credUserId || userId);
  const dest = task.dest === 'gofile' ? 'gofile' : (task.dest === 'telegram' ? 'telegram' : 'gdrive');
  const isGofile = dest === 'gofile';
  const isLeech = dest === 'telegram';
  const accessToken = !isGofile ? await getValidAccessToken(credUserId, env) : null;

  if (!isGofile && !isLeech && !accessToken) {
    await editMessage(
      chatId,
      menuMsgId,
      task.isSharedGcTemp
        ? `<blockquote><b>Owner Drive Unavailable</b>\n\nThe bot owner needs to reconnect Google Drive with /login.</blockquote>`
        : `<blockquote><b>Session Expired</b>\n\nPlease reconnect your Google Drive with /login.</blockquote>`,
      env
    );
    return;
  }

  const quota = (!isGofile && !isLeech && accessToken) ? await getDriveQuota(accessToken) : null;
  const fileSize = task.fileSize || 0;

  if (!isGofile && !isLeech && !task.batch && fileSize > 0 && quota && quota.free !== Infinity && fileSize > quota.free) {
    const msg =
      `<blockquote><b>Insufficient Drive Storage</b>\n\n` +
      `<code>${escapeHtml(task.customName || task.detectedName)}</code></blockquote>\n\n` +
      `Required  ·  <code>${fmtBytes(fileSize)}</code>\n\n` +
      `Available  ·  <code>${fmtBytes(quota.free)}</code>\n\n` +
      `<i>Free up space in Google Drive and try again.</i>`;
    await editMessage(chatId, menuMsgId, msg, env);
    return;
  }

  // Fast server-side copy directly in Worker for single Drive file in normal mode
  const singleItem = !task.batch && task.items?.length === 1 ? task.items[0] : null;
  if (!isGofile && !isLeech && singleItem && singleItem.type === 'gdrive' && !task.isFolder && task.mode === 'normal') {
    await executeDirectDriveCopy(task, singleItem, accessToken, env);
    return;
  }

  let fallbackNotice = '';
  if (!task.batch && fileSize > 0) {
    if (task.mode === 'extract' || task.mode === 'zip') {
      const workspaceNeeded = fileSize * 2.1;
      if (workspaceNeeded > RUNNER_LIMIT_BYTES) {
        fallbackNotice =
          `<blockquote><b>Workspace Notice</b>\n\n` +
          `Archive processing needs <code>${fmtBytes(workspaceNeeded)}</code>. Switching to direct upload.</blockquote>\n\n`;
        task.mode = 'normal';
      }
    }

    if (fileSize > RUNNER_LIMIT_BYTES) {
      await editMessage(
        chatId,
        menuMsgId,
        `<blockquote><b>Capacity Limit</b>\n\n` +
          `File size (<code>${fmtBytes(fileSize)}</code>) exceeds the 112 GiB runner workspace.</blockquote>`,
        env
      );
      return;
    }
  }

  const modeTag = task.isYtdl
    ? (YT_AUDIO_QUALITIES.has(task.ytQuality) ? '#Audio' : '#ytdlp') + (isLeech ? ' #Leech' : '')
    : (isLeech
        ? (task.mode === 'extract' ? '#Extract #Leech' : task.mode === 'zip' ? '#ZIP #Leech' : '#Leech')
        : (task.mode === 'extract' ? '#Extract' : task.mode === 'zip' ? '#ArchiveZIP' : '#Mirror'));
  const freeDriveStr = quota && quota.free !== Infinity ? fmtBytes(quota.free) : 'Unlimited';
  const actionsUrl = getActionsUrl(env) || 'https://github.com';
  const displayTitle = task.batch
    ? `Batch (${task.items.length} links)`
    : (task.customName || task.detectedName);

  const destLines = isLeech
    ? `├ Dest : Telegram (Leech)\n├ Part Limit : <code>2.00 GB (Auto Split)</code>\n`
    : isGofile
      ? `├ Dest : Gofile (Fresh Guest)\n├ Quota : <code>100GB DL / 10d idle</code>\n`
      : `├ Folder : ${escapeHtml(task.isSharedGcTemp ? 'GC Shared (5-Day Temp)' : task.folderName)}\n├ Drive Free : <code>${freeDriveStr}</code>\n`;

  const userRole = task.userRole || await getUserRoleTag(userId, !!task.isChannel, env);
  const displayBy = /^[a-zA-Z0-9_]{4,}$/.test(String(task.username || '')) ? `@${task.username}` : (task.username || 'User');

  const copyrightLine = isLeech
    ? `\n\n<blockquote>⚠️ <b>Copyright Warning:</b> Do not leech copyrighted content — it could get the group and bot both flagged or banned.${task.chatType === 'private' ? ' DM files auto-delete in 30m.' : ''}</blockquote>`
    : '';

  const bootText =
    `${fallbackNotice}` +
    `<blockquote>📄 <b>Name :</b> <code>${escapeHtml(displayTitle)}</code></blockquote>\n\n` +
    `┌ Status : <a href="${actionsUrl}">Booting..</a> (0.00%)\n` +
    `├ [<code>□□□□□□□□□□□□</code>]\n` +
    `├ By : ${escapeHtml(displayBy)} [${escapeHtml(userRole)}]\n` +
    `├ UserID : <code>[${escapeHtml(String(userId))}]</code>\n` +
    `├ Size : <code>${fileSize > 0 ? fmtBytes(fileSize) : 'Unknown'}</code>\n` +
    `${destLines}` +
    `├ Mode : <code>${modeTag}</code>\n` +
    `└ ⛔ /cancel_${taskId}\n\n` +
    `____________________________\n\n` +
    `<pre><code>┌ SYSTEM\n` +
    `├ 🟢 Cpu [□□□□□□□□□□] 0.0%\n` +
    `├ 🟢 Ram [□□□□□□□□□□] 0.0%\n` +
    `├ 🟢 Free [■□□□□□□□□□] 115.00GB\n` +
    `└ 🕒 Allocating runner (~10s)..</code></pre>${copyrightLine}`;

  await editMessage(chatId, menuMsgId, bootText, env, {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: `st_ref:${taskId}`, style: 'primary' },
        { text: '🔽 Close', callback_data: `st_close:${taskId}`, style: 'danger' }
      ]
    ]
  });

  const jobData = {
    jobId: taskId,
    userId: String(userId),
    userRole,
    credUserId,
    username: task.username,
    chatId,
    chatType: task.chatType || 'private',
    isChannel: !!task.isChannel,
    isSharedGcTemp: !!task.isSharedGcTemp,
    threadId: task.threadId || null,
    replyToMsgId: task.replyToMsgId || null,
    messageId: menuMsgId,
    repoUrl: getRepoUrl(env),
    tgDecision: '',
    fileUrl: task.fileUrl,
    items: task.items,
    batch: !!task.batch,
    detectedName: displayTitle,
    customName: task.customName,
    fileSize: task.fileSize,
    dest,
    leechAsDoc: !!task.leechAsDoc,
    folderId: (isGofile || isLeech) ? '' : task.folderId,
    folderName: isLeech ? 'Telegram (Leech)' : (isGofile ? 'Gofile (Guest)' : task.folderName),
    mode: task.mode,
    selectFilter: task.selectFilter,
    archivePassword: task.archivePassword || '',
    share: isLeech ? false : (task.isSharedGcTemp ? true : !!task.share),
    conflict: task.conflict || 'rename',
    isYtdl: !!task.isYtdl,
    ytQuality: task.ytQuality || 'best',
    ytContainer: task.ytContainer || 'mp4',
    ytSubs: !!task.ytSubs,
    ytSubLang: task.ytSubLang || 'en',
    ytMeta: task.ytMeta !== false,
    ytSponsorBlock: !!task.ytSponsorBlock,
    ytPlaylist: task.ytPlaylist || 'single',
    ytPlaylistItems: task.ytPlaylistItems || '',
    ytTrim: task.ytTrim || '',
    status: 'booting',
    cancelled: false,
    createdAt: Date.now()
  };

  await getStore(env).put(`job:${taskId}`, JSON.stringify(jobData), { expirationTtl: 25200 });
  await addActiveJobForUser(userId, taskId, env);

  const dispatched = await triggerGithubWorkflow(taskId, env);
  if (!dispatched) {
    await removeActiveJobForUser(userId, taskId, env);
    await editMessage(
      chatId,
      menuMsgId,
      `<blockquote><b>Dispatch Error</b>\n\nCould not trigger GitHub Actions runner.</blockquote>`,
      env
    );
  }
}

async function executeDirectDriveCopy(task, item, accessToken, env) {
  const { chatId, userId, menuMsgId, folderId, folderName } = task;
  const targetName = (task.customName || task.detectedName || 'Drive File').trim();
  const conflict = task.conflict || 'rename';

  await editMessage(
    chatId,
    menuMsgId,
    `<blockquote>📄 <b>Name :</b> <code>${escapeHtml(targetName)}</code></blockquote>\n\n` +
      `┌ Status : Server-Side Copy..\n` +
      `├ Engine : <code>Drive API v3</code>\n` +
      `└ Folder : ${escapeHtml(task.isSharedGcTemp ? 'GC Shared (5-Day Temp)' : (folderName || 'My Drive'))}`,
    env
  );

  try {
    let finalName = targetName;
    const existing = await findDriveExisting(accessToken, folderId, targetName);
    let copied = null;
    let status = 'completed';

    if (existing.length > 0) {
      if (conflict === 'skip') {
        copied = existing[0];
        status = 'skipped';
      } else if (conflict === 'overwrite') {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing[0].id)}?supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trashed: true })
          }
        );
      } else {
        finalName = await findFreeDriveName(accessToken, folderId, targetName, false);
      }
    }

    if (!copied) {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      };
      if (item.resourceKey) {
        headers['X-Goog-Drive-Resource-Keys'] = `${item.id}/${item.resourceKey}`;
      }
      const copyRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}/copy?fields=id,name,mimeType,webViewLink,size&supportsAllDrives=true`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: finalName,
            parents: [folderId || 'root']
          })
        }
      );
      const copyJson = await copyRes.json();
      if (!copyRes.ok || !copyJson.id) {
        throw new Error(extractDriveApiError(copyJson, 'Drive server-side copy failed'));
      }
      copied = copyJson;
    }

    const fid = copied.id;
    const fileLink = copied.webViewLink || `https://drive.google.com/file/d/${fid}/view`;
    const folderUrl = folderId && folderId !== 'root'
      ? `https://drive.google.com/drive/folders/${folderId}`
      : 'https://drive.google.com/drive/my-drive';
    const size = parseInt(copied.size || task.fileSize || 0, 10) || 0;

    let shared = false;
    let direct = '';
    if ((task.share || task.isSharedGcTemp) && status === 'completed') {
      shared = await makeDrivePublic(accessToken, fid);
      if (shared) {
        direct = `https://drive.google.com/uc?id=${fid}&export=download`;
      }
    }

    const userRole = task.userRole || await getUserRoleTag(userId, !!task.isChannel, env);
    const uname = task.username && !task.username.startsWith('@') && /^[a-zA-Z0-9_]{4,}$/.test(task.username)
      ? `@${task.username}`
      : (task.username || 'User');
    const title = status === 'completed' ? 'Transfer Complete' : 'Skipped — Already Exists';
    let text =
      `<blockquote><b>${title}</b>\n\n` +
      `<code>${escapeHtml(copied.name || finalName)}</code></blockquote>\n\n` +
      `Size  ·  <code>${fmtBytes(size)}</code>\n\n` +
      `Folder  ·  ${escapeHtml(task.isSharedGcTemp ? 'GC Shared (5-Day Temp)' : (folderName || 'My Drive'))}\n\n` +
      `Engine  ·  <code>Drive Server-Side</code>\n\n`;
    if (shared) {
      text += `Access  ·  Anyone with the link\n\n`;
    }
    text += `User  ·  ${escapeHtml(uname)} [${escapeHtml(userRole)}]`;

    if (task.isSharedGcTemp) {
      text += `\n\n<blockquote>${GC_TEMP_NOTICE_HTML}</blockquote>`;
    }

    const rows = [[
      { text: task.isSharedGcTemp ? '⬇ Download File' : '▸  Open File', url: fileLink, style: 'success' },
      { text: 'Open Folder', url: folderUrl, style: 'primary' }
    ]];
    if (direct && !task.isSharedGcTemp) {
      rows.push([{ text: '⬇ Direct Download', url: direct, style: 'primary' }]);
    }
    if (task.isSharedGcTemp && status === 'completed' && fid && size <= PERM_REQ_MAX_BYTES) {
      rows.push([{ text: '📌 Request Permanent Storage', callback_data: `perm_req:${task.taskId}`, style: 'primary' }]);
    }

    await editMessage(chatId, menuMsgId, text, env, { inline_keyboard: rows });

    if (task.isSharedGcTemp && status === 'completed' && fid) {
      const chatRec = await getApprovedChat(chatId, env);
      await registerGcTempExpiry({
        jobId: task.taskId,
        credUserId: String(task.credUserId || getOwnerId(env)),
        chatId: String(chatId),
        chatTitle: chatRec?.title || String(chatId),
        threadId: task.threadId || null,
        msgId: menuMsgId,
        userId: String(userId),
        username: task.username || '',
        files: [{ id: fid, name: copied.name || finalName, size, link: fileLink }],
        totalSize: size,
        createdAt: Date.now(),
        expiresAt: Date.now() + GC_TEMP_TTL_MS,
        permRequested: false,
        permDenied: false,
        permApproved: false,
        mirrorHtml: text,
        mirrorKbRows: rows
      }, env);
    }

    await appendHistory(userId, [{
      name: copied.name || finalName,
      link: fileLink,
      direct,
      size,
      status,
      mode: 'gdrive-copy',
      shared,
      ts: Date.now()
    }], env);
    if (!task.isChannel) {
      await bumpUserStats(task.userId || userId, { succeeded: 1 }, {}, env);
    }
  } catch (err) {
    if (!task.isChannel) {
      await bumpUserStats(task.userId || userId, { failed: 1 }, {}, env);
    }
    const reason = friendlyDriveError(err.message) || err.message || 'Drive copy failed';
    await editMessage(
      chatId,
      menuMsgId,
      `<blockquote><b>Transfer Failed</b>\n\n` +
        `<code>${escapeHtml(targetName)}</code></blockquote>\n\n` +
        `Reason  ·  <code>${escapeHtml(reason.slice(0, 300))}</code>`,
      env
    );
  }
}

async function triggerGithubWorkflow(jobId, env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW || 'mirror.yml'}/dispatches`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      'User-Agent': 'Telegram-GDrive-Worker'
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { job_id: jobId }
    })
  });
  return res.ok;
}

// ============================================================================
// INTERNAL RUNNER ENDPOINTS
// ============================================================================

async function handleInternalRunner(request, path, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.JOB_SECRET || auth !== `Bearer ${env.JOB_SECRET}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  const body = await request.json();
  const jobId = body.job_id;
  if (!jobId) return jsonResponse({ ok: false, error: 'Missing job_id' }, 400);

  const jRaw = await getStore(env).get(`job:${jobId}`);
  if (!jRaw) return jsonResponse({ ok: false, error: 'Job not found' }, 404);
  const job = JSON.parse(jRaw);
  const credUid = String(job.credUserId || job.userId);

  if (path === '/internal/job') {
    if (body.run_id) {
      job.runId = String(body.run_id);
      job.status = 'running';
      await getStore(env).put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
    }
    const tokenInfo = await getValidTokenInfo(credUid, env, false);
    if (job.dest !== 'gofile' && job.dest !== 'telegram' && !tokenInfo) {
      return jsonResponse({ ok: false, error: 'Could not mint Google access token for user' }, 400);
    }
    return jsonResponse({
      ok: true,
      job: {
        ...job,
        accessToken: tokenInfo?.accessToken || '',
        tokenExpiry: tokenInfo?.tokenExpiry || null
      }
    });
  }

  if (path === '/internal/refresh') {
    const tokenInfo = await getValidTokenInfo(credUid, env, !!body.force);
    return jsonResponse({
      ok: !!tokenInfo,
      accessToken: tokenInfo?.accessToken || null,
      expiry: tokenInfo?.tokenExpiry || null
    });
  }

  if (path === '/internal/job-status') {
    if (typeof body.last_card === 'string' && body.last_card.length > 0) {
      job.lastCardHtml = body.last_card;
      await getStore(env).put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
    }
    return jsonResponse({
      ok: true,
      cancelled: !!job.cancelled,
      status: job.status,
      messageId: job.messageId || '',
      tgDecision: job.tgDecision || ''
    });
  }

  if (path === '/internal/complete') {
    job.status = body.status || 'completed';
    if (!job.statsRecorded && !job.isChannel) {
      job.statsRecorded = true;
      const statField = job.status === 'cancelled' ? 'cancelled' : (job.status === 'failed' ? 'failed' : 'succeeded');
      await bumpUserStats(job.userId, { [statField]: 1 }, {}, env);
    }
    await getStore(env).put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
    await removeActiveJobForUser(job.userId, jobId, env);

    if (Array.isArray(body.items) && body.items.length > 0) {
      const doneItems = body.items
        .filter(it => it && (it.status === 'completed' || it.status === 'skipped') && (it.link || job.dest === 'telegram'))
        .map(it => ({
          id: it.id || '',
          name: it.name || 'File',
          link: it.link || '',
          direct: it.direct || '',
          size: it.size || 0,
          status: it.status,
          mode: job.dest === 'telegram' ? 'leech' : (job.mode || 'normal'),
          shared: !!it.shared,
          ts: Date.now()
        }));
      if (doneItems.length) {
        await appendHistory(job.userId, doneItems, env);
      }

      if (job.dest === 'telegram') {
        const msgIds = Array.isArray(body.leech_msg_ids) ? body.leech_msg_ids.filter(Boolean) : [];
        if (msgIds.length > 0 && job.chatId) {
          const isPrivateChat = job.chatType === 'private';
          const noticeText = isPrivateChat
            ? `<blockquote><b>⏳ Save Your File(s) — Auto-Delete in 30 Minutes</b></blockquote>\n\n` +
              `Please forward these file(s) to <b>Saved Messages</b> or somewhere safe — they will be <b>automatically deleted in 30 minutes</b>.\n\n` +
              `<blockquote>⚠️ <b>Copyright Warning:</b> Do not leech copyrighted content, as it could get the group and bot both flagged and possibly banned.</blockquote>`
            : `<blockquote><b>⚠️ Copyright Notice</b></blockquote>\n\n` +
              `Do not leech copyrighted content — it could get the group and bot both flagged and possibly banned.\n\n` +
              `<i>Use the button below to delete the uploaded file(s) anytime.</i>`;
          const delKb = {
            inline_keyboard: [[
              { text: isPrivateChat ? '🗑 Delete Now' : '🗑 Delete File(s)', callback_data: `leech_del:${jobId}`, style: 'danger' }
            ]]
          };
          const sentNotice = await sendMessage(job.chatId, noticeText, env, delKb, null, job.threadId || null).catch(() => null);
          const delRec = {
            jobId,
            chatId: String(job.chatId),
            userId: String(job.userId),
            isPrivate: isPrivateChat,
            fileMsgIds: msgIds,
            noticeMsgId: sentNotice?.result?.message_id || null,
            createdAt: Date.now(),
            expiresAt: isPrivateChat ? (Date.now() + 30 * 60 * 1000) : null
          };
          await getStore(env).put(`leech_del:${jobId}`, JSON.stringify(delRec), { expirationTtl: isPrivateChat ? 3600 : 2592000 });
          if (isPrivateChat && env.STATE_DO && delRec.expiresAt) {
            const stub = env.STATE_DO.get(env.STATE_DO.idFromName('global'));
            await stub.fetch('https://state.do/leech-schedule', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(delRec)
            }).catch(() => {});
          }
        }
      }

      if (job.isSharedGcTemp && job.dest === 'gdrive') {
        const expFiles = doneItems.filter(it => it.status === 'completed' && it.id);
        if (expFiles.length) {
          const totalSize = expFiles.reduce((acc, it) => acc + (parseInt(it.size || 0, 10) || 0), 0);
          const chatRec = await getApprovedChat(job.chatId, env);
          await registerGcTempExpiry({
            jobId,
            credUserId: credUid,
            chatId: String(job.chatId),
            chatTitle: chatRec?.title || String(job.chatId),
            threadId: job.threadId || null,
            msgId: body.msg_id || job.messageId || null,
            userId: String(job.userId),
            username: job.username || '',
            files: expFiles.map(it => ({ id: it.id, name: it.name, size: it.size || 0, link: it.link })),
            totalSize,
            createdAt: Date.now(),
            expiresAt: Date.now() + GC_TEMP_TTL_MS,
            permRequested: false,
            permDenied: false,
            permApproved: false,
            mirrorHtml: body.mirror_html || '',
            mirrorKbRows: Array.isArray(body.mirror_kb?.inline_keyboard) ? body.mirror_kb.inline_keyboard : null
          }, env);
        }
      }
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: 'Unknown path' }, 404);
}

// ============================================================================
// HISTORY, ACTIVE TASKS & CANCELLATION
// ============================================================================

async function appendHistory(userId, entries, env) {
  if (!entries || !entries.length) return;
  const raw = await getStore(env).get(`history:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  const merged = [...entries.reverse(), ...list].slice(0, MAX_HISTORY_ITEMS);
  await getStore(env).put(`history:${userId}`, JSON.stringify(merged));
}

async function sendHistory(chatId, userId, editMsgId, env, threadId = null) {
  const raw = await getStore(env).get(`history:${userId}`);
  const list = raw ? JSON.parse(raw) : [];

  if (!list.length) {
    const emptyText = `<blockquote><b>Transfer History</b>\n\n<i>No completed transfers yet.</i></blockquote>`;
    if (editMsgId) {
      await editMessage(chatId, editMsgId, emptyText, env);
    } else {
      await sendMessage(chatId, emptyText, env, null, null, threadId);
    }
    return;
  }

  let body = '';
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const icon = it.status === 'skipped' ? '↷' : '✓';
    const name = escapeHtml(truncate(it.name || 'File', 42));
    const sizeStr = it.size > 0 ? `  <code>${fmtBytes(it.size)}</code>` : '';
    const line = it.link
      ? `${i + 1}. ${icon} <a href="${escapeHtml(it.link)}">${name}</a>${sizeStr}\n`
      : `${i + 1}. ${icon} <code>${name}</code>${it.mode === 'leech' ? ' <i>(Telegram)</i>' : ''}${sizeStr}\n`;
    if (body.length + line.length > 3400) break;
    body += line;
  }

  const text =
    `<blockquote><b>Transfer History</b>\n\n` +
    `<i>Last ${list.length} transfers</i></blockquote>\n\n` +
    body;

  const kb = {
    inline_keyboard: [[{ text: '🗑 Clear History', callback_data: 'hist_clear', style: 'danger' }]]
  };

  if (editMsgId) {
    await editMessage(chatId, editMsgId, text, env, kb);
  } else {
    await sendMessage(chatId, text, env, kb, null, threadId);
  }
}

async function addActiveJobForUser(userId, jobId, env) {
  const raw = await getStore(env).get(`active:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(jobId)) list.push(jobId);
  await getStore(env).put(`active:${userId}`, JSON.stringify(list), { expirationTtl: 25200 });
}

async function removeActiveJobForUser(userId, jobId, env) {
  const raw = await getStore(env).get(`active:${userId}`);
  if (!raw) return;
  const list = JSON.parse(raw).filter(id => id !== jobId);
  await getStore(env).put(`active:${userId}`, JSON.stringify(list), { expirationTtl: 25200 });
}

async function cancelActiveJob(chatId, userId, jobId, env, threadId = null) {
  const jRaw = await getStore(env).get(`job:${jobId}`);
  if (!jRaw) {
    await sendMessage(chatId, `<i>Task <code>${escapeHtml(jobId)}</code> is no longer active.</i>`, env, null, null, threadId);
    return;
  }
  const job = JSON.parse(jRaw);
  if (!(await canControlRecord(job, userId, env))) {
    await sendMessage(chatId, `<i>You can only cancel your own tasks.</i>`, env, null, null, threadId);
    return;
  }
  job.cancelled = true;
  job.status = 'cancelled';
  if (!job.statsRecorded && !job.isChannel) {
    job.statsRecorded = true;
    await bumpUserStats(job.userId, { cancelled: 1 }, {}, env);
  }
  await getStore(env).put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
  await removeActiveJobForUser(job.userId, jobId, env);

  if (job.runId) {
    await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${job.runId}/cancel`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          'User-Agent': 'Telegram-GDrive-Worker'
        }
      }
    );
  }

  await sendMessage(chatId, `Cancelling  ·  <code>${escapeHtml(jobId)}</code>`, env, null, null, threadId);
}

async function sendActiveTasks(chatId, userId, env, _filterChatId = null, threadId = null) {
  const raw = await getStore(env).get(`active:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  const activeJobs = [];
  const keptIds = [];

  for (const jid of list) {
    const jr = await getStore(env).get(`job:${jid}`);
    if (!jr) continue;
    const j = JSON.parse(jr);
    if (j.cancelled || ['completed', 'cancelled', 'failed'].includes(j.status)) continue;
    keptIds.push(jid);
    activeJobs.push([jid, j]);
  }

  if (keptIds.length !== list.length) {
    await getStore(env).put(`active:${userId}`, JSON.stringify(keptIds), { expirationTtl: 25200 });
  }

  if (!activeJobs.length) {
    await sendMessage(chatId, `<blockquote><b>Active Tasks</b>\n\n<i>No transfers running right now.</i></blockquote>`, env, null, null, threadId);
    return;
  }

  for (const [jid, j] of activeJobs) {
    if (j.messageId) {
      await deleteMessage(chatId, j.messageId, env);
    }

    const name = escapeHtml(j.customName || j.detectedName || 'Task');
    const state = escapeHtml(j.status || 'starting');
    const userTag = j.username ? `@${escapeHtml(j.username)}` : `<code>${escapeHtml(String(j.userId || userId))}</code>`;
    const folder = escapeHtml(
      j.dest === 'telegram'
        ? 'Telegram (Leech)'
        : (j.dest === 'gofile' ? 'Gofile (Guest)' : (j.isSharedGcTemp ? 'GC Shared (5-Day Temp)' : (j.folderName || 'My Drive')))
    );

    const cardText = j.lastCardHtml || (
      `<code>${name}</code>\n\n` +
      `<b>Status  ·  ${state}</b>\n` +
      `<code>[░░░░░░░░░░░░░░░░░░░░]</code>  <b><code>0.0%</code></b>\n` +
      `Size  ·  <code>${fmtBytes(j.fileSize)}</code>\n` +
      `Dest  ·  <code>${folder}</code>\n` +
      `User  ·  ${userTag}  |  ID  ·  <code>${escapeHtml(String(j.userId || userId))}</code>\n` +
      `Stop  ·  /cancel_${jid}\n\n` +
      `<pre><code>SYSTEM\nLive card restored — awaiting next sync..</code></pre>`
    );

    const kb = {
      inline_keyboard: [[
        { text: '🔄 Refresh', callback_data: `st_ref:${jid}`, style: 'primary' },
        { text: '🔽 Close', callback_data: `st_close:${jid}`, style: 'danger' }
      ]]
    };

    const sent = await sendMessage(chatId, cardText, env, kb, null, j.threadId || threadId);
    if (sent?.result?.message_id) {
      j.messageId = String(sent.result.message_id);
      await getStore(env).put(`job:${jid}`, JSON.stringify(j), { expirationTtl: 25200 });
    }
  }
}

// ============================================================================
// MENUS, URL PARSING & LINK VERIFICATION
// ============================================================================

function buildOpenSourceNoteHtml(env) {
  const repoUrl = getRepoUrl(env);
  const actionsUrl = getActionsUrl(env);
  if (!repoUrl) {
    return `<blockquote><b>Open-Source &amp; Transparent VM</b>\n\nThis bot is open-source and runs every mirror job on GitHub Actions VMs.</blockquote>`;
  }
  return (
    `<blockquote><b>Open-Source &amp; Transparent VM</b>\n\n` +
    `This bot is open-source and uses <b>GitHub Actions</b> as its VM. ` +
    `You can watch every upload &amp; mirror live in <a href="${escapeHtml(actionsUrl)}">GitHub Actions</a> ` +
    `and inspect the full code &amp; workflow on the <a href="${escapeHtml(repoUrl)}">Repository Page</a>.</blockquote>`
  );
}

async function sendStartScreen(chatId, userId, username, env, opts = {}) {
  const isGroup = !!opts.isGroup;
  const threadId = opts.threadId || null;
  const replyToMsgId = opts.replyToMsgId || null;
  const stored = await getUserProfile(userId, env);
  const profile = getEffectiveProfile(userId, stored);
  const osNote = buildOpenSourceNoteHtml(env);

  if (!hasDriveAuth(stored)) {
    const gcInfo = isGroup
      ? `Default GC Dest  ·  <b>${profile.defaultDest === 'telegram' ? 'Telegram (Leech)' : 'Shared Group Drive (5-Day Auto-Delete)'}</b>\n\n<i>Tip: Run /login to connect your own Google Drive for permanent storage.</i>\n\n`
      : `Destination  ·  <b>${profile.defaultDest === 'telegram' ? 'Telegram (Leech)' : 'Gofile (No Login Required)'}</b>\n\n`;
    const text =
      `<blockquote><b>Cloud Mirror &amp; Leech Engine</b>\n\n` +
      `Free On-Demand Mirroring &amp; Leeching (Telegram + Gofile + Google Drive)</blockquote>\n\n` +
      gcInfo +
      `Bandwidth  ·  Up to <code>1.8 Gbps</code> (16x Aria2c)\n\n` +
      `Features  ·  Direct URLs · Telegram Files (&lt;4GB) · Auto Split (&gt;2GB) · yt-dlp · Batch · Extract · ZIP\n\n` +
      `Telemetry  ·  <code>2.5s</code> Live Progress &amp; System Stats\n\n` +
      `${osNote}\n\n` +
      `<b>Commands</b>\n\n` +
      `<code>/m &lt;link&gt;</code> — Mirror URLs, reply to any Telegram file, or send a <code>t.me</code> link\n\n` +
      `<code>/leech &lt;link&gt;</code> (<code>/l</code>) — Leech files directly into Telegram (auto-splits &gt; 2 GB)\n\n` +
      `<code>/yt &lt;link&gt;</code> — Download videos / audio / playlists via yt-dlp\n\n` +
      `/help — Full guide    /tasks — Active transfers    /history — Recent transfers\n\n` +
      `/settings — Preferences    /login — Connect Google Drive (Permanent)`;

    if (isGroup) {
      await sendMessage(chatId, text, env, null, replyToMsgId, threadId);
      return;
    }
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    await sendMessage(
      chatId,
      text,
      env,
      { inline_keyboard: [[{ text: '▸  Connect Google Drive (Permanent)', url: authUrl, style: 'primary' }]] },
      replyToMsgId,
      threadId
    );
    return;
  }

  const destLabel = profile.defaultDest === 'telegram'
    ? 'Telegram (Leech)'
    : (profile.defaultDest === 'gofile' ? 'Gofile (Temp Guest)' : 'Google Drive (Permanent)');
  const text =
    `<blockquote><b>Cloud Mirror &amp; Leech Engine</b>\n\n` +
    `<code>${escapeHtml(profile.email)}</code></blockquote>\n\n` +
    `Default Dest  ·  ${destLabel}\n\n` +
    `Upload Folder  ·  ${escapeHtml(profile.folderName || 'My Drive')}\n\n` +
    `Options Menu  ·  ${profile.buttonMode !== false ? 'Enabled' : 'Disabled'}\n\n` +
    `Auto Share  ·  ${profile.autoShare ? 'Enabled' : 'Disabled'}    Duplicate  ·  ${conflictLabel(profile.conflict || 'rename')}\n\n` +
    `${osNote}\n\n` +
    `<b>Commands</b>\n\n` +
    `<code>/m &lt;link&gt;</code> — Mirror URLs, Drive links, Telegram files, or <code>t.me</code> links\n\n` +
    `<code>/leech &lt;link&gt;</code> (<code>/l</code>) — Leech files directly into Telegram (auto-splits &gt; 2 GB)\n\n` +
    `<code>/yt &lt;link&gt;</code> — Download videos / audio / playlists via yt-dlp\n\n` +
    `/setdldir — Browse &amp; select target folder\n\n` +
    `/tasks — Active transfers    /history — Recent transfers\n\n` +
    `/settings — Preferences    /help — Full guide    /logout — Unlink Drive`;

  await sendMessage(
    chatId,
    text,
    env,
    isGroup
      ? null
      : {
          inline_keyboard: [[
            { text: 'Browse Folder', callback_data: 'cfg_dir', style: 'primary' },
            { text: `ButtonMode: ${profile.buttonMode !== false ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_btn' }
          ]]
        },
    replyToMsgId,
    threadId
  );
}

async function sendHelpScreen(chatId, userId, env, opts = {}) {
  const threadId = opts.threadId || null;
  const replyToMsgId = opts.replyToMsgId || null;
  const isOwnerUser = isOwner(userId, env);
  const isAdminUser = await isAdmin(userId, env);
  const osNote = buildOpenSourceNoteHtml(env);

  let adminLines = '';
  if (!opts.isGroup && isAdminUser) {
    adminLines += `\n\n<b>Admin Commands (DM)</b>\n\n` +
      `<code>/reqgroup &lt;link_or_id&gt;</code> — Request Owner approval for a Group or Channel`;
  }
  if (!opts.isGroup && isOwnerUser) {
    adminLines += `\n\n<b>Owner Commands</b>\n\n` +
      `/admin — Manage Admins &amp; Authorized Groups/Channels\n\n` +
      `<code>/status @username</code> — Check Admin status, bot start &amp; mirror stats\n\n` +
      `<code>/auth &lt;id&gt;</code> / <code>/unauth &lt;id&gt;</code> — Quick approve or revoke a user/chat ID\n\n` +
      `/authorize — Approve the current group/channel`;
  }

  const text =
    `<blockquote><b>Cloud Mirror &amp; Leech Engine — Help &amp; Guide</b></blockquote>\n\n` +
    `<b>Mirror &amp; Leech Commands</b>\n\n` +
    `<code>/m &lt;url&gt;</code> — Mirror direct links, Drive links, Gofile, SourceForge, <code>t.me</code> posts, or reply <code>/m</code> to any file\n\n` +
    `<code>/leech &lt;url&gt;</code> (<code>/l</code>) — Leech files straight to Telegram (auto-splits files &gt; 2 GB into <code>1.95 GB</code> parts)\n\n` +
    `<code>/yt &lt;url&gt;</code> — Download videos, audio, or playlists (YouTube, Instagram, TikTok, X, etc.)\n\n` +
    `<b>Account &amp; Preferences</b>\n\n` +
    `/login — Connect your personal Google Drive (works in both DMs &amp; Groups)\n\n` +
    `/setdldir — Pick your default Drive upload folder\n\n` +
    `/settings — Configure default destination, Leech type, ButtonMode, Auto Share, Duplicate policy &amp; yt-dlp presets\n\n` +
    `/logout — Unlink your Google Drive\n\n` +
    `<b>Status &amp; History</b>\n\n` +
    `/tasks — View or reopen running jobs\n\n` +
    `/history — View recent transfers\n\n` +
    `<b>Group Storage Rules</b>\n\n` +
    `• Bare links &amp; casual media in groups are ignored — always use <code>/m</code>, <code>/l</code>, or <code>/yt</code>.\n` +
    `• Without <code>/login</code>, group <code>/m</code> files upload to shared temporary Drive storage (public link, auto-deleted after <b>5 days</b>; files ≤ 50 GB can be requested for permanent storage).\n` +
    `• With <code>/login</code>, your group mirrors upload straight to <b>your own Drive</b> privately.` +
    `${adminLines}\n\n` +
    `${osNote}`;

  const repoUrl = getRepoUrl(env);
  const actionsUrl = getActionsUrl(env);
  const kb = repoUrl
    ? {
        inline_keyboard: [[
          { text: '📂 View Source Repo', url: repoUrl, style: 'primary' },
          { text: '⚙ GitHub Actions', url: actionsUrl, style: 'primary' }
        ]]
      }
    : null;

  await sendMessage(chatId, text, env, kb, replyToMsgId, threadId);
}

async function sendSettingsMenu(chatId, userId, profile, editMsgId, env, threadId = null) {
  const hasDrive = hasDriveAuth(profile);
  const eff = getEffectiveProfile(userId, profile);
  const yq = ytQualityLabel(eff.ytQuality || 'best');
  const yc = ytContainerLabel(eff.ytContainer || 'mp4');
  const destStr = eff.defaultDest === 'telegram'
    ? 'Telegram (Leech to Chat)'
    : (eff.defaultDest === 'gofile' ? 'Gofile (Temp · Fresh Guest)' : 'Google Drive (Permanent)');
  const leechModeStr = eff.leechAsDoc ? 'Document (Original File)' : 'Media (Stream Video / Audio)';
  const acctLine = hasDrive ? `<code>${escapeHtml(eff.email)}</code>` : `<i>Guest Mode (No Google Drive Linked)</i>`;
  const text =
    `<blockquote><b>Preferences</b>\n\n` +
    `${acctLine}</blockquote>\n\n` +
    `Default Dest  ·  ${destStr}\n\n` +
    `Leech Upload As  ·  ${leechModeStr}\n\n` +
    (hasDrive ? `Target Folder  ·  ${escapeHtml(eff.folderName || 'My Drive')}\n\n` : '') +
    `ButtonMode  ·  ${eff.buttonMode !== false ? 'Enabled' : 'Disabled'}\n\n` +
    (hasDrive
      ? `Auto Share  ·  ${eff.autoShare ? 'Enabled (Anyone with link)' : 'Disabled'}\n\n` +
        `On Duplicate  ·  ${conflictLabel(eff.conflict || 'rename')}\n\n`
      : '') +
    `Media (yt-dlp)  ·  <code>${yq} · ${yc}</code>`;

  const destBtnLabel = eff.defaultDest === 'telegram'
    ? 'Telegram (Leech)'
    : (eff.defaultDest === 'gofile' ? 'Gofile' : 'Google Drive');
  const rows = [];
  rows.push([
    { text: `Dest: ${destBtnLabel}`, callback_data: 'cfg_toggle_dest', style: 'primary' },
    { text: `Leech: ${eff.leechAsDoc ? 'Document' : 'Media'}`, callback_data: 'cfg_toggle_asdoc' }
  ]);
  if (hasDrive) {
    rows.push([{ text: 'Browse / Change Folder', callback_data: 'cfg_dir', style: 'primary' }]);
    rows.push([
      { text: `ButtonMode: ${eff.buttonMode !== false ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_btn' },
      { text: `Auto Share: ${eff.autoShare ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_share' }
    ]);
    rows.push([
      { text: `Duplicate: ${conflictLabel(eff.conflict || 'rename')}`, callback_data: 'cfg_conf_menu' },
      { text: `🎬 Media: ${yq}`, callback_data: 'cfg_yt_menu' }
    ]);
  } else {
    rows.push([
      { text: `ButtonMode: ${eff.buttonMode !== false ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_btn' },
      { text: `🎬 Media: ${yq}`, callback_data: 'cfg_yt_menu', style: 'primary' }
    ]);
  }

  const kb = { inline_keyboard: rows };
  if (editMsgId) {
    await editMessage(chatId, editMsgId, text, env, kb);
  } else {
    await sendMessage(chatId, text, env, kb, null, threadId);
  }
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (let raw of matches) {
    raw = raw.replace(/[.,;!?)]+$/, '');
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
      if (out.length >= MAX_BATCH_URLS) break;
    }
  }
  return out;
}

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : u.hostname;
  } catch (_) {
    return 'link';
  }
}

function parseTelegramPostUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 't.me' && host !== 'telegram.me' && host !== 'telegram.dog') {
      return null;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    if (parts[0] === 'c' && parts.length >= 3) {
      const internalId = parts[1];
      const msgId = parseInt(parts[parts.length - 1], 10);
      if (/^\d+$/.test(internalId) && Number.isInteger(msgId) && msgId > 0) {
        return { chat: `-100${internalId}`, messageId: msgId, isPrivate: true, url: rawUrl };
      }
      return null;
    }

    const chIdx = parts[0] === 's' && parts.length >= 3 ? 1 : 0;
    const channel = parts[chIdx];
    const msgId = parseInt(parts[parts.length - 1], 10);
    if (
      !channel ||
      channel.startsWith('+') ||
      /^(?:joinchat|addstickers|addlist|addemoji|proxy|socks|share|iv|login|confirmphone|contact)$/i.test(channel) ||
      !/^[a-zA-Z0-9_]{4,}$/.test(channel) ||
      !Number.isInteger(msgId) ||
      msgId <= 0
    ) {
      return null;
    }
    return { chat: channel, messageId: msgId, isPrivate: false, url: rawUrl };
  } catch (_) {
    return null;
  }
}

async function inspectTelegramPostLink(tgPost) {
  let fileName = `Telegram_${tgPost.isPrivate ? 'post' : tgPost.chat}_${tgPost.messageId}`;
  let sizeBytes = 0;
  if (!tgPost.isPrivate) {
    try {
      const embedUrl = `https://t.me/${encodeURIComponent(tgPost.chat)}/${tgPost.messageId}?embed=1&mode=tme`;
      const res = await fetch(embedUrl, { headers: { 'User-Agent': DEFAULT_UA } });
      if (res.ok) {
        const html = (await res.text()).slice(0, 65536);
        const titleM = html.match(/<div[^>]+class=["'][^"']*tgme_widget_message_document_title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        if (titleM && titleM[1]) {
          const clean = decodeHtmlEntities(titleM[1].replace(/<[^>]+>/g, '').trim()).replace(/[/\\?%*:|"<>]/g, '_');
          if (clean) fileName = clean;
        }
        const extraM = html.match(/<div[^>]+class=["'][^"']*tgme_widget_message_document_extra[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        if (extraM && extraM[1]) {
          const szM = extraM[1].match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)/i);
          if (szM) {
            const val = parseFloat(szM[1]);
            const unit = szM[2].toUpperCase();
            const mult =
              unit === 'GB' || unit === 'GIB'
                ? 1024 ** 3
                : unit === 'MB' || unit === 'MIB'
                  ? 1024 ** 2
                  : unit === 'KB' || unit === 'KIB'
                    ? 1024
                    : 1;
            if (!Number.isNaN(val) && val > 0) {
              sizeBytes = Math.round(val * mult);
            }
          }
        }
      }
    } catch (_) {}
  }
  return { fileName, sizeBytes };
}

function parseDriveUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('drive.google.com') && !host.endsWith('docs.google.com') && host !== 'drive.usercontent.google.com') {
      return null;
    }
    const resourceKey = u.searchParams.get('resourcekey') || u.searchParams.get('resourceKey') || '';
    const folderMatch = u.pathname.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (folderMatch) {
      return { id: folderMatch[1], resourceKey, isFolder: true };
    }
    const fileMatch = u.pathname.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    if (fileMatch) {
      return { id: fileMatch[1], resourceKey, isFolder: false };
    }
    const idParam = u.searchParams.get('id');
    if (idParam && /^[a-zA-Z0-9_-]{10,}$/.test(idParam)) {
      return { id: idParam, resourceKey, isFolder: false };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function inspectDriveLink(info, accessToken) {
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (info.resourceKey) {
      headers['X-Goog-Drive-Resource-Keys'] = `${info.id}/${info.resourceKey}`;
    }
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(info.id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok || !data.id) {
      return { valid: false, reason: extractDriveApiError(data, 'Could not inspect Google Drive link') };
    }
    const isFolder = data.mimeType === FOLDER_MIME;
    return {
      valid: true,
      fileName: data.name || 'Drive Item',
      sizeBytes: data.size ? parseInt(data.size, 10) : 0,
      contentType: data.mimeType || 'application/octet-stream',
      acceptRanges: true,
      isFolder
    };
  } catch (err) {
    return { valid: false, reason: `Drive inspection error: ${err.message}` };
  }
}

const DIRECT_FILE_EXT_RE = /\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|tar\.xz|txz|mkv|mp4|avi|webm|mov|m4v|mp3|flac|m4a|ogg|wav|iso|img|apk|exe|msi|dmg|deb|rpm|appimage|pdf|epub|bin)(\?.*)?$/i;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WGET_UA = 'Wget/1.21.3';

function isSourceForgeHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return h === 'sourceforge.net' || h === 'sf.net' || h.endsWith('.sourceforge.net');
}

function isSourceForgeUrl(rawUrl) {
  try {
    return isSourceForgeHost(new URL(rawUrl).hostname);
  } catch (_) {
    return false;
  }
}

function uaForUrl(rawUrl) {
  return isSourceForgeUrl(rawUrl) ? WGET_UA : DEFAULT_UA;
}

// ============================================================================
// GOFILE SOURCE (download FROM Gofile)
// Gofile's store links are authorized by the same guest token that listed the
// content. The website token is derived from UA + account token + a rotating
// salt; the salt lives (hex-escaped) in https://gofile.io/js/wt.obf.js.
// ============================================================================

const GOFILE_API_BASE = 'https://api.gofile.io';
const GOFILE_DEFAULT_WT_SALT = '12af056dacea0b';
let gofileSaltCache = { salt: '', at: 0 };

function isGofileHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return h === 'gofile.io' || h.endsWith('.gofile.io');
}

function isGofileUrl(rawUrl) {
  return !!parseGofileUrl(rawUrl);
}

function isGofileContentId(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  if (!/^[A-Za-z0-9]{8}$/.test(v)) return false;
  return !['download', 'contents', 'accounts', 'uploadfile', 'createfolder'].includes(v.toLowerCase());
}

function parseGofileUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!isGofileHost(host)) return null;

    for (const key of ['c', 'id', 'contentId', 'code']) {
      const v = (u.searchParams.get(key) || '').trim();
      if (isGofileContentId(v)) {
        return { id: v, host, url: u.toString(), isStore: host !== 'gofile.io' };
      }
    }

    const segs = u.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
    let cand = '';
    if (segs[0] === 'd' && segs[1]) cand = segs[1];
    else if (segs[0] === 'download' && segs[1]) cand = segs[1] === 'web' ? (segs[2] || '') : segs[1];
    else if (segs[0] === 'f' && segs[1]) cand = segs[1];
    if (isGofileContentId(cand)) {
      return { id: cand, host, url: u.toString(), isStore: host !== 'gofile.io' };
    }

    const uuid = u.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return { id: uuid[0], host, url: u.toString(), isStore: host !== 'gofile.io' };
    return null;
  } catch (_) {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function gofileWebsiteToken(ua, token, salt) {
  const slot = Math.floor(Date.now() / 1000 / 14400);
  const raw = `${ua}::en-US::${token}::${slot}::${salt}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getGofileWtSalt(env, force = false) {
  const override = String(env?.GOFILE_WT_SALT || '').trim();
  if (override) return override;
  if (!force && gofileSaltCache.salt && Date.now() - gofileSaltCache.at < 60 * 60 * 1000) {
    return gofileSaltCache.salt;
  }
  try {
    const res = await fetchWithTimeout(
      'https://gofile.io/js/wt.obf.js',
      { headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' } },
      6000
    );
    if (res.ok) {
      const text = await res.text();
      const decoded = text.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const hits = decoded.match(/[0-9a-f]{12,20}/g) || [];
      const salt = hits.find(s => /[a-f]/.test(s) && /\d/.test(s)) || hits[0];
      if (salt) {
        gofileSaltCache = { salt, at: Date.now() };
        return salt;
      }
    }
  } catch (_) {}
  return GOFILE_DEFAULT_WT_SALT;
}

async function gofileApiFetch(path, opts = {}) {
  const {
    method = 'GET',
    token = '',
    env,
    body = null,
    timeoutMs = 9000,
    retrySalt = true
  } = opts;
  const ua = DEFAULT_UA;

  const doFetch = async (salt) => {
    const wt = await gofileWebsiteToken(ua, token, salt);
    const headers = {
      'User-Agent': ua,
      'X-Website-Token': wt,
      'X-BL': 'en-US',
      Accept: '*/*',
      Origin: 'https://gofile.io',
      Referer: 'https://gofile.io/'
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers.Cookie = `accountToken=${token}`;
    }
    if (body !== null) headers['Content-Type'] = 'application/json';
    const res = await fetchWithTimeout(`${GOFILE_API_BASE}${path}`, {
      method,
      headers,
      body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      redirect: 'follow'
    }, timeoutMs);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { res, data };
  };

  let salt = await getGofileWtSalt(env);
  let out = await doFetch(salt);
  if (retrySalt && out.data?.status === 'error-notPremium') {
    salt = await getGofileWtSalt(env, true);
    out = await doFetch(salt);
  }
  return out;
}

async function gofileGuestToken(env) {
  const { res, data } = await gofileApiFetch('/accounts', { method: 'POST', body: {}, env });
  const token = data?.data?.token;
  if (!res.ok || data?.status !== 'ok' || !token) {
    throw new Error(data?.status || `HTTP ${res.status}`);
  }
  return token;
}

async function inspectGofileLink(info, env) {
  try {
    const token = await gofileGuestToken(env);
    const { res, data } = await gofileApiFetch(
      `/contents/${encodeURIComponent(info.id)}?cache=true&page=1&pageSize=1000&sortField=createTime&sortDirection=1`,
      { token, env, timeoutMs: 10000 }
    );
    const status = data?.status;
    const d = data?.data || {};
    if (status === 'error-notFound' || res.status === 404) {
      return { valid: false, reason: 'Gofile content was not found (expired, deleted, or invalid link).' };
    }
    if (status !== 'ok' || !d.id) {
      return { valid: false, reason: `Gofile API error: ${status || `HTTP ${res.status}`}` };
    }
    if (d.canAccess === false) {
      return { valid: false, reason: 'This Gofile content is not publicly accessible.' };
    }
    const isFolder = d.type === 'folder';
    const name = String(d.name || '').trim() || `Gofile_${String(info.id).slice(0, 8)}`;
    const size = isFolder ? Number(d.totalSize || 0) : Number(d.size || 0);
    return {
      valid: true,
      fileName: name,
      sizeBytes: size,
      contentType: isFolder ? 'inode/directory' : (d.mimetype || 'application/octet-stream'),
      acceptRanges: true,
      isFolder,
      gofileMeta: {
        id: d.id || info.id,
        name,
        size,
        childrenCount: isFolder ? Number(d.childrenCount || 0) : 0,
        md5: d.md5 || '',
        type: d.type || 'file'
      }
    };
  } catch (err) {
    // Cloudflare egress can be blocked by Gofile. Keep the task usable and let
    // the runner inspect with Chrome impersonation.
    const guess = guessNameFromUrl(info.url || '') || `Gofile_${String(info.id).slice(0, 8)}`;
    return {
      valid: true,
      fallback: true,
      fileName: guess,
      sizeBytes: 0,
      contentType: 'application/octet-stream',
      acceptRanges: true,
      isFolder: false,
      gofileMeta: { id: info.id, name: guess, size: 0, childrenCount: 0, md5: '', type: 'file' },
      warning: `Gofile metadata unavailable from Worker (${err?.message || err}); runner will inspect.`
    };
  }
}

function normalizeSourceForgeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'sourceforge.net') {
      const mP = u.pathname.match(/^\/p\/([^/]+)(\/files(?:\/.*)?)$/);
      if (mP) {
        u.pathname = `/projects/${mP[1]}${mP[2]}`;
        return u.toString();
      }
      const mPOnly = u.pathname.match(/^\/p\/([^/]+)\/?$/);
      if (mPOnly) {
        u.pathname = `/projects/${mPOnly[1]}/files/`;
        return u.toString();
      }
    }
  } catch (_) {}
  return rawUrl;
}

function parseSourceForgeProjectPath(rawUrl) {
  try {
    const norm = normalizeSourceForgeUrl(rawUrl);
    const u = new URL(norm);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'sourceforge.net') return null;

    const mRoot = u.pathname.match(/^\/projects\/([^/]+)\/?$/);
    if (mRoot) {
      return { kind: 'folder', project: mRoot[1], relPath: '', folderUrl: `https://sourceforge.net/projects/${mRoot[1]}/files/` };
    }

    const mFilesRoot = u.pathname.match(/^\/projects\/([^/]+)\/files\/?$/);
    if (mFilesRoot) {
      return { kind: 'folder', project: mFilesRoot[1], relPath: '', folderUrl: `https://sourceforge.net/projects/${mFilesRoot[1]}/files/` };
    }

    const mFiles = u.pathname.match(/^\/projects\/([^/]+)\/files\/(.+)$/);
    if (!mFiles) return null;

    const project = mFiles[1];
    const rawRest = mFiles[2];
    const trimmedRest = rawRest.replace(/\/+$/, '');
    if (trimmedRest === 'latest/download') {
      return {
        kind: 'file',
        project,
        relPath: 'latest',
        fileName: `${project}_latest`,
        directUrl: `https://sourceforge.net/projects/${project}/files/latest/download`,
        sourceUrl: `https://sourceforge.net/projects/${project}/files/latest/download`
      };
    }
    if (trimmedRest.endsWith('/download')) {
      const rel = trimmedRest.slice(0, -'/download'.length).replace(/^\/+|\/+$/g, '');
      const fName = decodeURIComponent(rel.split('/').filter(Boolean).pop() || `${project}_file`);
      return {
        kind: 'file',
        project,
        relPath: rel,
        fileName: fName,
        directUrl: `https://downloads.sourceforge.net/project/${project}/${rel}?viasf=1`,
        sourceUrl: `https://sourceforge.net/projects/${project}/files/${rel}/download`
      };
    }
    if (rawRest.endsWith('/')) {
      const rel = trimmedRest.replace(/^\/+|\/+$/g, '');
      return {
        kind: 'folder',
        project,
        relPath: rel,
        folderUrl: `https://sourceforge.net/projects/${project}/files/${rel}/`
      };
    }

    const rel = trimmedRest.replace(/^\/+|\/+$/g, '');
    const fName = decodeURIComponent(rel.split('/').filter(Boolean).pop() || `${project}_file`);
    return {
      kind: 'maybe',
      project,
      relPath: rel,
      fileName: fName,
      directUrl: `https://downloads.sourceforge.net/project/${project}/${rel}?viasf=1`,
      sourceUrl: `https://sourceforge.net/projects/${project}/files/${rel}/download`,
      folderUrl: `https://sourceforge.net/projects/${project}/files/${rel}/`
    };
  } catch (_) {
    return null;
  }
}

async function fetchSourceForgeRssItems(project, dirRelPath = '') {
  const cleanDir = String(dirRelPath || '').replace(/^\/+|\/+$/g, '');
  const rssPath = cleanDir ? `/${cleanDir}` : '/';
  const rssUrl = `https://sourceforge.net/projects/${encodeURIComponent(project)}/rss?path=${encodeURIComponent(rssPath)}`;
  try {
    const res = await fetch(rssUrl, {
      method: 'GET',
      headers: { 'User-Agent': WGET_UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      redirect: 'follow'
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const blk = m[1];
      const linkM = blk.match(/<link>([\s\S]*?)<\/link>/i);
      const titleM = blk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const szM = blk.match(/\bfilesize=["'](\d+)["']/i);
      const link = decodeHtmlEntities((linkM?.[1] || '').trim());
      if (!link || /\/files\/latest\/download$/i.test(link)) continue;
      items.push({
        link,
        relPath: (titleM?.[1] || '').trim().replace(/^\/+/, ''),
        sizeBytes: szM ? parseInt(szM[1], 10) || 0 : 0
      });
    }
    return items;
  } catch (_) {
    return [];
  }
}

async function buildSourceForgeRunnerFallback(rawUrl, sfMeta) {
  let fileName = sfMeta?.fileName || '';
  let sizeBytes = 0;

  if (!fileName) {
    try {
      const u = new URL(rawUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[parts.length - 1] === 'download' && parts.length >= 2) {
        fileName = decodeURIComponent(parts[parts.length - 2]);
      } else if (parts.length) {
        fileName = decodeURIComponent(parts[parts.length - 1]);
      }
    } catch (_) {}
  }

  if (sfMeta?.project && sfMeta?.relPath && sfMeta.relPath !== 'latest') {
    const dirParts = sfMeta.relPath.split('/').filter(Boolean);
    dirParts.pop();
    const rssItems = await fetchSourceForgeRssItems(sfMeta.project, dirParts.join('/'));
    const match = rssItems.find(it => it.relPath === sfMeta.relPath || it.link.includes(`/${sfMeta.relPath}/download`));
    if (match) {
      if (match.sizeBytes > 0) sizeBytes = match.sizeBytes;
      if (!fileName && match.relPath) fileName = match.relPath.split('/').pop() || fileName;
    }
  }

  return {
    kind: 'url',
    verification: {
      valid: true,
      fileName: fileName || 'sourceforge_file.bin',
      sizeBytes,
      contentType: 'application/octet-stream',
      acceptRanges: true
    },
    finalUrl: sfMeta?.directUrl || rawUrl,
    sourceUrl: sfMeta?.sourceUrl || rawUrl,
    resolvedVia: 'SourceForge (Runner)'
  };
}

async function expandSourceForgeFolder(folderUrl, maxFiles = MAX_BATCH_URLS) {
  const queue = [folderUrl];
  const seenPages = new Set();
  const files = [];
  const seenFiles = new Set();

  while (queue.length && seenPages.size < 12 && files.length < maxFiles) {
    const pageUrl = queue.shift();
    if (seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);

    let htmlText = '';
    try {
      const res = await fetch(pageUrl, {
        method: 'GET',
        headers: { 'User-Agent': WGET_UA, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow'
      });
      if (res.ok) {
        htmlText = await res.text();
      }
    } catch (_) {}

    if (htmlText) {
      const rowRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
      let m;
      while ((m = rowRe.exec(htmlText)) !== null) {
        const trAttrs = m[1];
        const trBody = m[2];
        const cls = extractAttr(trAttrs, 'class').toLowerCase();
        const hrefMatch = trBody.match(/<a\b[^>]*\bhref=["']([^"']+)["']/i);
        if (!hrefMatch) continue;

        let absUrl;
        try {
          absUrl = new URL(decodeHtmlEntities(hrefMatch[1]), pageUrl).toString();
        } catch (_) {
          continue;
        }

        if (/\bfile\b/.test(cls) && absUrl.includes('/files/') && absUrl.endsWith('/download')) {
          if (/\/files\/latest\/download$/i.test(absUrl)) continue;
          if (!seenFiles.has(absUrl)) {
            seenFiles.add(absUrl);
            files.push(absUrl);
            if (files.length >= maxFiles) break;
          }
        } else if (/\bfolder\b/.test(cls) && absUrl.includes('/files/') && !absUrl.endsWith('/download')) {
          const cleanDir = absUrl.split('#')[0].split('?')[0];
          if (!seenPages.has(cleanDir) && !queue.includes(cleanDir)) {
            queue.push(cleanDir);
          }
        }
      }
    }
  }

  // Fallback to SourceForge RSS feed if HTML folder listing was blocked or empty
  if (!files.length) {
    const sf = parseSourceForgeProjectPath(folderUrl);
    if (sf?.project) {
      const rssItems = await fetchSourceForgeRssItems(sf.project, sf.relPath || '');
      for (const it of rssItems) {
        if (!seenFiles.has(it.link)) {
          seenFiles.add(it.link);
          files.push(it.link);
          if (files.length >= maxFiles) break;
        }
      }
    }
  }

  return files;
}

async function expandSourceForgeInputs(urls) {
  const out = [];
  const seen = new Set();
  const pushUrl = (u) => {
    if (u && !seen.has(u) && out.length < MAX_BATCH_URLS) {
      seen.add(u);
      out.push(u);
    }
  };

  for (const raw of urls) {
    let cur = normalizeSourceForgeUrl(raw);
    try {
      const host = new URL(cur).hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'sf.net') {
        const r = await fetch(cur, { method: 'HEAD', headers: { 'User-Agent': WGET_UA }, redirect: 'follow' }).catch(() => null);
        if (r?.url) cur = normalizeSourceForgeUrl(r.url);
      }
    } catch (_) {}

    const sf = parseSourceForgeProjectPath(cur);
    if (!sf) {
      pushUrl(cur);
      continue;
    }
    if (sf.kind === 'file') {
      pushUrl(cur);
      continue;
    }
    if (sf.kind === 'maybe') {
      const v = await verifyDirectLink(sf.directUrl);
      if (v.valid || /\.[a-z0-9]{1,8}$/i.test(sf.relPath)) {
        pushUrl(cur);
        continue;
      }
    }
    const found = await expandSourceForgeFolder(sf.folderUrl, MAX_BATCH_URLS - out.length);
    if (!found.length) {
      // Worker may be CF-blocked by SourceForge; let runner crawl the folder directly
      pushUrl(sf.folderUrl);
      continue;
    }
    for (const f of found) pushUrl(f);
    if (out.length >= MAX_BATCH_URLS) break;
  }

  return { urls: out.length ? out : urls };
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function rewriteKnownDirectUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'pixeldrain.com') {
      const fileM = u.pathname.match(/^\/u\/([a-zA-Z0-9_-]+)/);
      if (fileM) return { url: `https://pixeldrain.com/api/file/${fileM[1]}?download`, via: 'Pixeldrain' };
      const listM = u.pathname.match(/^\/l\/([a-zA-Z0-9_-]+)/);
      if (listM) return { url: `https://pixeldrain.com/api/list/${listM[1]}/zip`, via: 'Pixeldrain List' };
    }

    if (host === 'dropbox.com') {
      if (u.searchParams.get('dl') !== '1') {
        u.searchParams.set('dl', '1');
        return { url: u.toString(), via: 'Dropbox' };
      }
    }

    if (host === 'github.com') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
      if (m) {
        return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, via: 'GitHub Raw' };
      }
    }

    if (host === 'gitlab.com' && u.pathname.includes('/-/blob/')) {
      u.pathname = u.pathname.replace('/-/blob/', '/-/raw/');
      return { url: u.toString(), via: 'GitLab Raw' };
    }

    if (host === 'huggingface.co' && u.pathname.includes('/blob/')) {
      u.pathname = u.pathname.replace('/blob/', '/resolve/');
      return { url: u.toString(), via: 'Hugging Face' };
    }

    if (isSourceForgeHost(host)) {
      const sf = parseSourceForgeProjectPath(rawUrl);
      if (sf && (sf.kind === 'file' || sf.kind === 'maybe') && sf.directUrl && sf.directUrl !== rawUrl) {
        return { url: sf.directUrl, via: 'SourceForge', sourceUrl: sf.sourceUrl || '' };
      }
      if (host === 'master.dl.sourceforge.net') {
        const dlUrl = rawUrl.replace('://master.dl.sourceforge.net/', '://downloads.sourceforge.net/');
        return { url: dlUrl, via: 'SourceForge', sourceUrl: dlUrl };
      }
    }
  } catch (_) {}
  return null;
}

function detectChallengePage(headers, htmlText) {
  const cfMitigated = (headers?.get?.('cf-mitigated') || '').toLowerCase();
  if (cfMitigated === 'challenge') {
    return 'Protected by anti-bot verification. Open in your browser and send the direct file link.';
  }
  const low = (htmlText || '').slice(0, 60000).toLowerCase();
  if (
    low.includes('cf-turnstile') ||
    low.includes('challenges.cloudflare.com') ||
    low.includes('cdn-cgi/challenge-platform') ||
    low.includes('<title>just a moment...</title>') ||
    low.includes('g-recaptcha') ||
    low.includes('www.google.com/recaptcha') ||
    low.includes('h-captcha') ||
    low.includes('hcaptcha.com/1/api.js')
  ) {
    return 'Protected by CAPTCHA or anti-bot verification. Open in your browser and send the direct file link.';
  }
  return null;
}

function extractHtmlRedirect(htmlText, baseUrl) {
  const snippet = (htmlText || '').slice(0, 60000);
  const metaMatch = snippet.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*([^"'\s>]+)/i) ||
    snippet.match(/<meta[^>]+content=["'][^"']*url\s*=\s*([^"'\s>]+)[^>]+http-equiv=["']?refresh["']?/i);
  if (metaMatch && metaMatch[1]) {
    try {
      const resolved = new URL(decodeHtmlEntities(metaMatch[1].trim()), baseUrl).toString();
      if (/^https?:\/\//i.test(resolved) && resolved !== baseUrl) return resolved;
    } catch (_) {}
  }

  const jsMatch = snippet.match(/(?:window\.location(?:\.href)?\s*=\s*|location\.replace\(\s*)["'](https?:\/\/[^"']+)["']/i);
  if (jsMatch && jsMatch[1]) {
    const resolved = decodeHtmlEntities(jsMatch[1].trim());
    if (resolved !== baseUrl) return resolved;
  }
  return null;
}

function extractAttr(tag, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? decodeHtmlEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : '';
}

function extractHostDownloadCandidates(pageUrl, htmlText) {
  let host = '';
  let pathname = '';
  try {
    const u = new URL(pageUrl);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname;
  } catch (_) {}

  if (host === 'mediafire.com' || host.endsWith('.mediafire.com')) {
    if (pathname.startsWith('/folder/')) {
      return { error: 'MediaFire folders are not supported as a single direct link.' };
    }
    const cands = [];
    const btnMatch = htmlText.match(/<a\b[^>]*\bid=["']downloadButton["'][^>]*>/i);
    if (btnMatch) {
      const href = extractAttr(btnMatch[0], 'href');
      if (/^https?:\/\//i.test(href)) {
        cands.push({ url: href, via: 'MediaFire', reExtractOnRunner: true });
      }
      const scrambled = extractAttr(btnMatch[0], 'data-scrambled-url');
      if (scrambled) {
        try {
          const decoded = atob(scrambled);
          if (/^https?:\/\//i.test(decoded)) {
            cands.push({ url: decoded, via: 'MediaFire', reExtractOnRunner: true });
          }
        } catch (_) {}
      }
    }
    if (cands.length) return { candidates: cands };
  }

  if (host === 'sourceforge.net') {
    const cands = [];
    const releaseMatch = htmlText.match(/data-release-url=["'](https?:\/\/[^"']+)["']/i);
    if (releaseMatch) {
      cands.push({ url: decodeHtmlEntities(releaseMatch[1]), via: 'SourceForge', reExtractOnRunner: true });
    }
    const dlLinkMatch = htmlText.match(/href=["'](https?:\/\/downloads\.sourceforge\.net\/[^"']+)["']/i);
    if (dlLinkMatch) {
      cands.push({ url: decodeHtmlEntities(dlLinkMatch[1]), via: 'SourceForge', reExtractOnRunner: true });
    }
    if (cands.length) return { candidates: cands };
  }

  if (host === 'onedrive.live.com' || host.endsWith('.sharepoint.com')) {
    try {
      const bytes = new TextEncoder().encode(pageUrl);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return {
        candidates: [{ url: `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`, via: 'OneDrive', reExtractOnRunner: false }]
      };
    } catch (_) {}
  }

  // Generic HTML download button / direct binary link extractor
  const scored = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]{1,600})>/gi;
  let m;
  while ((m = anchorRe.exec(htmlText)) !== null) {
    const attrs = m[1];
    const href = extractAttr(attrs, 'href');
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(href)) continue;

    let absUrl;
    try {
      absUrl = new URL(href, pageUrl).toString();
    } catch (_) {
      continue;
    }
    if (!/^https?:\/\//i.test(absUrl) || absUrl === pageUrl || seen.has(absUrl)) continue;
    seen.add(absUrl);

    const idVal = extractAttr(attrs, 'id').toLowerCase();
    const clsVal = extractAttr(attrs, 'class').toLowerCase();
    const hasDownloadAttr = /\bdownload\b/i.test(attrs);
    let score = 0;
    if (hasDownloadAttr) score += 5;
    if (/(?:^|[\s_-])(download|dl-btn|dl_btn|download-btn|btn-download)(?:$|[\s_-])/i.test(`${idVal} ${clsVal}`)) score += 4;
    if (DIRECT_FILE_EXT_RE.test(absUrl)) score += 3;

    if (score >= 3) {
      scored.push({ url: absUrl, via: 'Page Extractor', reExtractOnRunner: false, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { candidates: scored.slice(0, 3) };
}

function parseMetaFromResponse(res, fallbackUrl) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const contentDisp = res.headers.get('content-disposition') || '';
  const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' || res.status === 206;

  let sizeBytes = 0;
  const contentRange = res.headers.get('content-range') || '';
  const rangeMatch = contentRange.match(/\/(\d+)$/);
  if (rangeMatch) {
    sizeBytes = parseInt(rangeMatch[1], 10);
  } else {
    const cl = res.headers.get('content-length');
    if (cl) sizeBytes = parseInt(cl, 10) || 0;
  }

  if (contentType.includes('text/html') && !contentDisp.toLowerCase().includes('attachment')) {
    return { isHtml: true, contentType, contentDisp };
  }

  let fileName = 'download.bin';
  const dispMatch = contentDisp.match(/filename\*?=['"]?(?:UTF-8'')?([^'";\n]+)['"]?/i);
  if (dispMatch && dispMatch[1]) {
    try {
      fileName = decodeURIComponent(dispMatch[1].trim());
    } catch (_) {
      fileName = dispMatch[1].trim();
    }
  } else {
    try {
      const u = new URL(res.url || fallbackUrl);
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg && seg.length < 180) {
        fileName = decodeURIComponent(seg);
      }
    } catch (_) {}
  }

  return {
    isHtml: false,
    valid: true,
    fileName,
    sizeBytes,
    contentType,
    acceptRanges
  };
}

async function resolveAndInspectInput(rawUrl, accessToken, env) {
  const gofileInfo = parseGofileUrl(rawUrl);
  if (gofileInfo) {
    const inspection = await inspectGofileLink(gofileInfo, env);
    if (!inspection.valid) {
      return { kind: 'error', reason: inspection.reason };
    }
    return {
      kind: 'gofile',
      gofileInfo: {
        type: 'gofile',
        id: inspection.gofileMeta?.id || gofileInfo.id,
        url: rawUrl,
        name: inspection.fileName,
        size: inspection.sizeBytes || 0,
        isFolder: !!inspection.isFolder,
        childrenCount: inspection.gofileMeta?.childrenCount || 0,
        md5: inspection.gofileMeta?.md5 || ''
      },
      verification: {
        valid: true,
        fileName: inspection.fileName,
        sizeBytes: inspection.sizeBytes || 0,
        contentType: inspection.contentType || 'application/octet-stream',
        acceptRanges: true,
        isFolder: !!inspection.isFolder
      },
      finalUrl: rawUrl,
      sourceUrl: '',
      resolvedVia: inspection.fallback ? 'Gofile (Runner Metadata)' : 'Gofile API'
    };
  }

  let currentUrl = normalizeSourceForgeUrl(rawUrl);
  const sfInit = isSourceForgeUrl(currentUrl) ? parseSourceForgeProjectPath(currentUrl) : null;
  if (sfInit && sfInit.kind === 'folder') {
    const folderLabel = decodeURIComponent((sfInit.relPath || sfInit.project || 'SourceForge').split('/').filter(Boolean).pop() || sfInit.project);
    return {
      kind: 'sf_folder',
      sfInfo: {
        type: 'sf_folder',
        url: sfInit.folderUrl,
        project: sfInit.project,
        relPath: sfInit.relPath || '',
        name: folderLabel
      },
      verification: {
        valid: true,
        fileName: folderLabel,
        sizeBytes: 0,
        contentType: 'inode/directory',
        acceptRanges: true,
        isFolder: true
      },
      finalUrl: sfInit.folderUrl,
      sourceUrl: sfInit.folderUrl,
      resolvedVia: 'SourceForge Folder (Runner)'
    };
  }

  const visited = new Set();
  const viaChain = [];
  let stickySourceUrl = sfInit?.sourceUrl || '';
  let fetches = 0;

  const sfFallbackOrError = async (reason) => {
    if (isSourceForgeUrl(rawUrl) || isSourceForgeUrl(currentUrl)) {
      return await buildSourceForgeRunnerFallback(rawUrl, sfInit);
    }
    return { kind: 'error', reason };
  };

  for (let hop = 0; hop < 10 && fetches < 14; hop++) {
    if (isMediaSiteUrl(currentUrl)) {
      return {
        kind: 'ytdl',
        finalUrl: currentUrl,
        resolvedVia: viaChain.join(' → ')
      };
    }

    const tgPost = parseTelegramPostUrl(currentUrl);
    if (tgPost) {
      const tgMeta = await inspectTelegramPostLink(tgPost);
      return {
        kind: 'tg_media',
        tgInfo: {
          type: 'tg_media',
          chatId: tgPost.chat,
          messageId: tgPost.messageId,
          fileId: '',
          url: currentUrl,
          name: tgMeta.fileName,
          size: tgMeta.sizeBytes || 0
        },
        verification: {
          valid: true,
          fileName: tgMeta.fileName,
          sizeBytes: tgMeta.sizeBytes || 0,
          contentType: 'application/octet-stream',
          acceptRanges: true,
          isFolder: false
        },
        finalUrl: currentUrl,
        sourceUrl: '',
        resolvedVia: [...viaChain, 'Telegram MTProto (Kurigram)'].filter(Boolean).join(' → ')
      };
    }

    const driveInfo = parseDriveUrl(currentUrl);
    if (driveInfo) {
      if (!accessToken) {
        if (driveInfo.isFolder) {
          return { kind: 'error', reason: 'Google Drive folders require /login to read folder contents.' };
        }
        const rk = driveInfo.resourceKey ? `&resourcekey=${encodeURIComponent(driveInfo.resourceKey)}` : '';
        const pubUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveInfo.id)}&export=download&confirm=t${rk}`;
        const v = await verifyDirectLink(pubUrl);
        if (v.valid) {
          return {
            kind: 'url',
            verification: v,
            finalUrl: pubUrl,
            sourceUrl: '',
            resolvedVia: [...viaChain, 'Public Drive'].filter(Boolean).join(' → ')
          };
        }
        return { kind: 'error', reason: 'This Google Drive link requires /login (private or confirmation-gated).' };
      }
      const verification = await inspectDriveLink(driveInfo, accessToken);
      if (!verification.valid) {
        return { kind: 'error', reason: verification.reason };
      }
      return {
        kind: 'gdrive',
        driveInfo,
        verification,
        finalUrl: currentUrl,
        sourceUrl: '',
        resolvedVia: viaChain.join(' → ')
      };
    }

    const rewritten = rewriteKnownDirectUrl(currentUrl);
    if (rewritten && rewritten.url !== currentUrl && !visited.has(rewritten.url)) {
      visited.add(currentUrl);
      currentUrl = rewritten.url;
      if (rewritten.sourceUrl && !stickySourceUrl) stickySourceUrl = rewritten.sourceUrl;
      if (!viaChain.includes(rewritten.via)) viaChain.push(rewritten.via);
      continue;
    }

    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    if (isSourceForgeUrl(currentUrl) && !stickySourceUrl) {
      const sfMeta = parseSourceForgeProjectPath(currentUrl);
      if (sfMeta?.sourceUrl) stickySourceUrl = sfMeta.sourceUrl;
      else if (currentUrl.includes('downloads.sourceforge.net/')) stickySourceUrl = currentUrl;
      if (!viaChain.includes('SourceForge')) viaChain.push('SourceForge');
    }

    const reqUa = uaForUrl(currentUrl);
    let res;
    try {
      fetches++;
      res = await fetch(currentUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': reqUa },
        redirect: 'manual'
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
          currentUrl = new URL(loc, currentUrl).toString();
          if (!viaChain.includes('Redirect') && !isSourceForgeUrl(currentUrl)) viaChain.push('Redirect');
          continue;
        }
      }

      if (!res.ok || res.status === 405 || res.status === 403 || res.status === 501) {
        fetches++;
        const controller = new AbortController();
        res = await fetch(currentUrl, {
          method: 'GET',
          headers: { 'User-Agent': reqUa, Range: 'bytes=0-0' },
          redirect: 'manual',
          signal: controller.signal
        });
        if (res.status >= 300 && res.status < 400) {
          controller.abort();
          const loc = res.headers.get('location');
          if (loc) {
            currentUrl = new URL(loc, currentUrl).toString();
            if (!viaChain.includes('Redirect') && !isSourceForgeUrl(currentUrl)) viaChain.push('Redirect');
            continue;
          }
        }
        controller.abort();
      }
    } catch (err) {
      return await sfFallbackOrError(`Connection error: ${err.message}`);
    }

    const meta = parseMetaFromResponse(res, currentUrl);
    if (!meta.isHtml) {
      if (!res.ok && res.status !== 206) {
        return await sfFallbackOrError(`Remote server returned HTTP ${res.status}.`);
      }
      return {
        kind: 'url',
        verification: meta,
        finalUrl: currentUrl,
        sourceUrl: '',
        resolvedVia: viaChain.join(' → ')
      };
    }

    // Response is HTML — fetch page text to unwrap meta/JS redirects or extract host download link
    let htmlText = '';
    try {
      fetches++;
      const pageRes = await fetch(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': reqUa, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow'
      });
      const finalPageUrl = pageRes.url || currentUrl;
      if (finalPageUrl !== currentUrl) {
        currentUrl = finalPageUrl;
        if (isMediaSiteUrl(currentUrl)) {
          return { kind: 'ytdl', finalUrl: currentUrl, resolvedVia: viaChain.join(' → ') };
        }
        const driveAfter = parseDriveUrl(currentUrl);
        if (driveAfter) continue;
      }
      htmlText = (await pageRes.text()).slice(0, 262144);
      const blocked = detectChallengePage(pageRes.headers, htmlText);
      if (blocked) {
        return await sfFallbackOrError(blocked);
      }
      if (!pageRes.ok) {
        let host = '';
        try { host = new URL(currentUrl).hostname.toLowerCase(); } catch {}
        if (host.endsWith('googleusercontent.com') && (pageRes.status === 400 || pageRes.status === 403 || pageRes.status === 410)) {
          return {
            kind: 'error',
            reason: `Google download server returned HTTP ${pageRes.status} (signed download URLs are IP/session-bound or expired; share the original Drive/source link instead).`
          };
        }
        return await sfFallbackOrError(`Remote server returned HTTP ${pageRes.status}.`);
      }
    } catch (err) {
      return await sfFallbackOrError(`Failed to inspect page: ${err.message}`);
    }

    const hostRes = extractHostDownloadCandidates(currentUrl, htmlText);
    if (hostRes.error) {
      return { kind: 'error', reason: hostRes.error };
    }
    if (hostRes.candidates && hostRes.candidates.length) {
      for (const cand of hostRes.candidates) {
        fetches++;
        const v = await verifyDirectLink(cand.url);
        if (v.valid) {
          const chain = [...viaChain, cand.via].filter(Boolean);
          return {
            kind: 'url',
            verification: v,
            finalUrl: cand.url,
            sourceUrl: cand.reExtractOnRunner ? currentUrl : '',
            resolvedVia: chain.join(' → ')
          };
        }
      }
    }

    const htmlRedir = extractHtmlRedirect(htmlText, currentUrl);
    if (htmlRedir && !visited.has(htmlRedir)) {
      currentUrl = htmlRedir;
      if (!viaChain.includes('Redirect')) viaChain.push('Redirect');
      continue;
    }

    return await sfFallbackOrError('URL points to an HTML webpage with no extractable direct file link.');
  }

  return await sfFallbackOrError('Too many redirects while resolving link.');
}

async function verifyDirectLink(url) {
  try {
    const reqUa = uaForUrl(url);
    let res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': reqUa },
      redirect: 'follow'
    });

    if (!res.ok || res.status === 405 || res.status === 403 || res.status === 501) {
      const controller = new AbortController();
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': reqUa, Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: controller.signal
      });
      controller.abort();
    }

    if (!res.ok && res.status !== 206) {
      return { valid: false, reason: `HTTP ${res.status}` };
    }

    const meta = parseMetaFromResponse(res, url);
    if (meta.isHtml) {
      return { valid: false, reason: 'URL points to an HTML webpage rather than a direct file.' };
    }
    return meta;
  } catch (err) {
    return { valid: false, reason: `Connection error: ${err.message}` };
  }
}

// ============================================================================
// TELEGRAM & FORMATTING UTILITIES
// ============================================================================

async function postTelegramMessage(method, payload, env) {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data?.ok && payload.reply_markup?.inline_keyboard) {
    const hasStyle = payload.reply_markup.inline_keyboard.some(row => row.some(b => b && b.style));
    if (hasStyle) {
      const cleanPayload = {
        ...payload,
        reply_markup: {
          ...payload.reply_markup,
          inline_keyboard: payload.reply_markup.inline_keyboard.map(row =>
            row.map(({ style: _s, ...btn }) => btn)
          )
        }
      };
      const retryRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanPayload)
      });
      return await retryRes.json();
    }
  }
  return data;
}

async function sendMessage(chatId, text, env, replyMarkup = null, replyToMsgId = null, threadId = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
  if (threadId && !replyToMsgId) payload.message_thread_id = threadId;
  return await postTelegramMessage('sendMessage', payload, env);
}

async function editMessage(chatId, messageId, text, env, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return await postTelegramMessage('editMessageText', payload, env);
}

async function deleteMessage(chatId, messageId, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

async function answerCb(cbId, text, showAlert, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: cbId,
      text: text || undefined,
      show_alert: !!showAlert
    })
  });
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function htmlResponse(title, bodyHtml) {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet"><style>body{font-family:'Roboto',system-ui,-apple-system,sans-serif;font-weight:400;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:#1e293b;padding:32px;border-radius:16px;max-width:420px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.4)}h1{margin-top:0;color:#38bdf8;font-size:1.45rem;font-weight:500}p{color:#cbd5e1;line-height:1.75;font-weight:300}code{font-family:'Roboto Mono',monospace}</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${bodyHtml}</p></div></body></html>`;
  return new Response(page, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
