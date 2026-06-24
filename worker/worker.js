/**
 * Cloudflare Worker: Chatwork TODO Hub のバックエンド。
 *
 * 役割は2つ:
 *   1) Chatwork API のプロキシ（ブラウザは CORS 制限で直接叩けないため）
 *   2) 端末間で共有する「設定」の保存・読込（KV、内容はクライアントで暗号化済み）
 *
 * 認証は無し。各リクエストでユーザー自身の Chatwork トークンを受け取って処理する。
 * トークンそのものは保存しない（保存キーには SHA-256 ダイジェストを使う）。
 *
 * フロント（index.html）の google.script.run シムが、この Worker に
 * { action, token, ... } を POST(text/plain) で送ってくる。
 */

const CW_BASE = 'https://api.chatwork.com/v2';
const ALLOW_ORIGIN = '*'; // 必要なら GitHub Pages のオリジンに絞れる

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  }, extra || {});
}
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders() });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    if (request.method !== 'POST') return jsonResponse({ ok: false, message: 'POST only' }, 405);

    let body;
    try { body = JSON.parse(await request.text()); }
    catch (e) { return jsonResponse({ ok: false, message: 'bad request' }, 400); }

    const action = body && body.action;
    try {
      switch (action) {
        case 'init':           return jsonResponse(await apiInit(body.token));
        case 'roomList':       return jsonResponse(await apiRoomList(body.token));
        case 'roomTasksBatch': return jsonResponse(await apiRoomTasksBatch(body.token, body.rooms, !!body.force, ctx));
        case 'completeTask':   return jsonResponse(await apiCompleteTask(body.token, body.roomId, body.taskId));
        case 'loadSettings': return jsonResponse(await apiLoadSettings(env, body.token));
        case 'saveSettings': return jsonResponse(await apiSaveSettings(env, body.token, body.payload, body.clientUpdatedAt));
        case 'savePushSub':  return jsonResponse(await apiSavePushSub(env, body.token, body.deviceId, body.sub));
        case 'removePushSub':return jsonResponse(await apiRemovePushSub(env, body.token, body.deviceId));
        case 'saveSchedule': return jsonResponse(await apiSaveSchedule(env, body.token, body.items));
        case 'getSchedule':  return jsonResponse(await apiGetSchedule(env, body.token));
        case 'ackReminder':  return jsonResponse(await apiAckReminder(env, body.token, body.id, ctx));
        case 'pushTest':     return jsonResponse(await apiPushTest(env, body.token, ctx));
        default:             return jsonResponse({ ok: false, message: 'unknown action' }, 400);
      }
    } catch (e) {
      return jsonResponse({ ok: false, message: String(e && e.message ? e.message : e) });
    }
  },
  // Cron（毎分）: 期限の来たリマインドを各端末へWebPush送信する
  async scheduled(event, env, ctx) { ctx.waitUntil(runDueReminders(env)); }
};

/* ---------- Chatwork helpers ---------- */

function cwHeaders(token) { return { 'X-ChatWorkToken': token, 'Accept': 'application/json' }; }

function rateMsg(code) {
  if (code === 429) return 'アクセスが集中しています（429）。数分待ってから再読み込みしてください。';
  if (code === 401) return 'トークンが正しくありません（401）。再確認してください。';
  return '接続に失敗しました (' + code + ')';
}

async function cwGet(token, path) {
  return fetch(CW_BASE + path, { headers: cwHeaders(token) });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * タスク取得を 429/5xx のとき少し待ってリトライする。
 * subrequest 上限(50)に収めるため maxAttempts は小さく保つ（1バッチ15室×3回=45）。
 */
async function cwGetTasksRetry(token, roomId, maxAttempts) {
  let res;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await cwGet(token, '/rooms/' + roomId + '/tasks?status=open');
    if (res.status !== 429 && res.status < 500) return res; // 成功 or 恒久エラーは即返す
    if (attempt < maxAttempts) await sleep(res.status === 429 ? 1400 : 700 * attempt);
  }
  return res; // リトライ尽きてもまだ 429/5xx の可能性あり（呼び出し側でスキップ）
}

async function getMe(token) {
  if (!token) throw new Error('APIトークンがありません');
  const res = await cwGet(token, '/me');
  if (res.status !== 200) throw new Error(rateMsg(res.status));
  return res.json();
}

async function getRooms(token) {
  const res = await cwGet(token, '/rooms');
  if (res.status !== 200) throw new Error(rateMsg(res.status));
  return res.json();
}

function publicMe(me) { return { accountId: me.account_id, name: me.name, chatworkId: me.chatwork_id || '' }; }

function stripBodyPrefix(body) {
  return String(body).replace(/^(?:\s|　|\[\/?[a-zA-Z][^\]]*\])+/, '');
}
function isMemoTask(body) {
  if (!body) return false;
  return /^(?:メモ|めも|memo)/i.test(stripBodyPrefix(body));
}

function shapeTask(t) {
  const roomId = t.room ? t.room.room_id : '';
  const messageId = t.message_id || '';
  const link = messageId
    ? 'https://www.chatwork.com/#!rid' + roomId + '-' + messageId
    : 'https://www.chatwork.com/#!rid' + roomId;
  return {
    taskId: t.task_id,
    roomId: roomId,
    roomName: t.room ? t.room.name : '',
    roomIcon: t.room ? (t.room.icon_path || '') : '',
    assigneeId: t.account ? t.account.account_id : '',
    assigneeName: t.account ? t.account.name : '',
    assignedByName: t.assigned_by_account ? t.assigned_by_account.name : '',
    body: t.body || '',
    isMemo: isMemoTask(t.body),
    limitType: t.limit_type || 'none',
    dueTime: (t.limit_time && t.limit_type !== 'none') ? t.limit_time : 0,
    link: link
  };
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function tokenDigest(token) {
  if (!token) throw new Error('APIトークンがありません');
  return (await sha256hex('cwtodo:' + token)).slice(0, 24);
}

/* 並列数を抑えながら map（Chatwork のレート制限対策） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const n = Math.min(limit, items.length) || 0;
  const workers = new Array(n).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- actions ---------- */

async function apiInit(token) {
  const me = await getMe(token);
  return { ok: true, me: publicMe(me) };
}

/**
 * 部屋一覧（+本人情報）。subrequest は2回だけ。
 * クライアントはこの rooms を ~40室ずつに分けて roomTasksBatch を複数回呼ぶ
 * （Cloudflare 無料プランの「1呼び出しあたり subrequest 50回」制限を回避するため）。
 */
async function apiRoomList(token) {
  const me = await getMe(token);          // 1 subrequest
  const rooms = await getRooms(token);    // 1 subrequest（last_update_time を含む）
  const slim = rooms.map(r => ({
    room_id: r.room_id,
    name: r.name,
    icon_path: r.icon_path || '',
    last_update_time: r.last_update_time || 0,
    message_num: r.message_num || 0,
    task_num: r.task_num || 0, // そのルームの未完了タスク数（全担当者）。0なら取得をスキップできる
    type: r.type || '' // 'my' | 'direct' | 'group'。direct=1on1チャット
  }));
  console.log('roomList rooms=' + slim.length);
  return { ok: true, me: publicMe(me), rooms: slim };
}

/** 渡された部屋（最大40室程度）の未完了タスクをまとめて取得。部屋単位でキャッシュ。 */
async function apiRoomTasksBatch(token, rooms, force, ctx) {
  if (!token) throw new Error('APIトークンがありません');
  const dg = await tokenDigest(token);
  const cache = caches.default;
  const tasks = [];
  const stats = { rooms: (rooms || []).length, cacheHit: 0, c200: 0, c204: 0, c403: 0, c404: 0, c429: 0, c5xx: 0, other: 0 };

  await mapLimit(rooms || [], 4, async (room) => {
    const lut = room.last_update_time || 0;
    // last_update_time をキーに含める → 部屋が更新されるとキーが変わり自動で取り直しになる
    const cacheKey = new Request('https://cw-cache.local/rt/' + dg + '/' + room.room_id + '/' + lut);
    // lut を含めない「最新版」キー。混雑(429)時に前回の結果を見せるためのフォールバック
    const latestKey = new Request('https://cw-cache.local/rt-latest/' + dg + '/' + room.room_id);

    if (!force) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const arr = await hit.json();
        arr.forEach(t => tasks.push(t));
        stats.cacheHit++;
        return;
      }
    }

    const res = await cwGetTasksRetry(token, room.room_id, 3); // 429/5xx は最大2回リトライ
    const code = res.status;
    if (code === 200) stats.c200++; else if (code === 204) stats.c204++; else if (code === 403) stats.c403++;
    else if (code === 404) stats.c404++; else if (code === 429) stats.c429++; else if (code >= 500) stats.c5xx++; else stats.other++;
    if (code === 429 || code >= 500) {
      // 混雑/一時エラー → 前回保存した最新版があれば見せる（無ければスキップ）
      const stale = await cache.match(latestKey);
      if (stale) { (await stale.json()).forEach(t => tasks.push(t)); }
      return;
    }

    let shaped = [];
    if (code === 200) {
      let arr;
      try { arr = await res.json(); } catch (e) { return; }
      (arr || []).forEach(t => shaped.push(shapeTask({
        task_id: t.task_id,
        room: { room_id: room.room_id, name: room.name, icon_path: room.icon_path },
        account: t.account,
        assigned_by_account: t.assigned_by_account,
        message_id: t.message_id,
        body: t.body,
        limit_time: t.limit_time,
        limit_type: t.limit_type
      })));
    } else if (code !== 204 && code !== 403 && code !== 404) {
      return; // 想定外コードはキャッシュしない
    }

    shaped.forEach(t => tasks.push(t));
    const body = JSON.stringify(shaped);
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { 'Cache-Control': 'max-age=21600', 'Content-Type': 'application/json' }
    }))); // lut付き：6時間保持
    ctx.waitUntil(cache.put(latestKey, new Response(body, {
      headers: { 'Cache-Control': 'max-age=86400', 'Content-Type': 'application/json' }
    }))); // 最新版：24時間。混雑時フォールバック用
  });

  console.log('roomTasksBatch', JSON.stringify(stats), 'tasks=' + tasks.length);
  return { ok: true, tasks: tasks };
}

async function apiCompleteTask(token, roomId, taskId) {
  const res = await fetch(
    CW_BASE + '/rooms/' + encodeURIComponent(roomId) + '/tasks/' + encodeURIComponent(taskId) + '/status',
    {
      method: 'PUT',
      headers: Object.assign(cwHeaders(token), { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: 'body=done'
    }
  );
  if (res.status !== 200) {
    let txt = ''; try { txt = await res.text(); } catch (e) {}
    throw new Error('状態変更に失敗 (' + res.status + '): ' + txt);
  }
  // タスク完了は last_update_time を変えない（メッセージ投稿ではないため）。
  // そのままだと差分更新で完了済みが復活するので、クライアントが完了後に
  // apiRefetchRoom（force:true）でその部屋のキャッシュを取り直す。
  return { ok: true };
}

/* ---------- 設定の同期（KV: env.SETTINGS、中身はクライアントで暗号化済み） ---------- */

async function apiLoadSettings(env, token) {
  const dg = await tokenDigest(token);
  const raw = await env.SETTINGS.get('s_' + dg);
  if (!raw) return { ok: true, found: false };
  let obj; try { obj = JSON.parse(raw); } catch (e) { return { ok: true, found: false }; }
  return { ok: true, found: true, updatedAt: obj.updatedAt || 0, payload: obj.payload || '' };
}

async function apiSaveSettings(env, token, payload, clientUpdatedAt) {
  const dg = await tokenDigest(token);
  const updatedAt = Math.max(Date.now(), (clientUpdatedAt || 0) + 1); // 単調増加（後勝ち）
  await env.SETTINGS.put('s_' + dg, JSON.stringify({ v: 1, updatedAt: updatedAt, payload: payload || '' }));
  return { ok: true, updatedAt: updatedAt };
}

/* ====== Web Push（アプリを閉じていても通知。RFC 8291/8188 + VAPID をWebCryptoで自前実装） ======
   ・KV: push_<dg> = { deviceId: {endpoint, keys:{p256dh,auth}}, ... }（端末の購読）
   ・KV: sched_<dg> = { items:[{id,time,rep,repN,e}], updatedAt }（送信スケジュール。e はクライアント暗号文＝サーバは中身を読めない）
   ・通知本文(e)は端末でAES-GCM暗号化済み。サーバは時刻判定と中継のみ。SWが復号して表示する。 */
const TENC = new TextEncoder();
function pB64u(bytes) { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function pUb64(u) { const s = atob(String(u).replace(/-/g, '+').replace(/_/g, '/')); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }
function pConcat() { let n = 0; for (let i = 0; i < arguments.length; i++) n += arguments[i].length; const o = new Uint8Array(n); let p = 0; for (let i = 0; i < arguments.length; i++) { o.set(arguments[i], p); p += arguments[i].length; } return o; }
async function pHkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, k, len * 8));
}
async function pImportEcdhPub(p256dhB64) {
  const pub = pUb64(p256dhB64);
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pB64u(pub.slice(1, 33)), y: pB64u(pub.slice(33, 65)), ext: true, key_ops: [] }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}
// 送信ペイロードを aes128gcm で暗号化（RFC 8291）
async function encryptPush(plaintextBytes, p256dhB64, authB64) {
  const uaPub = pUb64(p256dhB64), auth = pUb64(authB64);
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await pImportEcdhPub(p256dhB64);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const ikm = await pHkdf(auth, ecdh, pConcat(TENC.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await pHkdf(salt, ikm, TENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await pHkdf(salt, ikm, TENC.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const record = pConcat(plaintextBytes, new Uint8Array([0x02]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));
  const rs = new Uint8Array([0, 0, 0x10, 0x00]); // record size 4096
  return pConcat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
// VAPID の Authorization ヘッダ（ES256 JWT）
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const pub = pUb64(env.VAPID_PUBLIC);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: pB64u(pub.slice(1, 33)), y: pB64u(pub.slice(33, 65)), ext: true, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = pB64u(TENC.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = pB64u(TENC.encode(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://example.com' })));
  const data = header + '.' + payload;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, TENC.encode(data)));
  return 'vapid t=' + data + '.' + pB64u(sig) + ', k=' + env.VAPID_PUBLIC;
}
// 1端末へ送信。戻りは HTTP ステータス（404/410 は購読切れ＝呼び出し側で掃除）
async function sendWebPush(sub, payloadObj, env) {
  const body = await encryptPush(TENC.encode(JSON.stringify(payloadObj)), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Authorization': await vapidAuth(sub.endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': '2419200' },
    body: body
  });
  return res.status;
}

function advanceTime(time, rep, n) {
  n = n || 1;
  if (rep === 'hour') return time + n * 3600000;
  if (rep === 'day') return time + n * 86400000;
  if (rep === 'week') return time + 7 * 86400000;
  if (rep === 'month') { const d = new Date(time); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); }
  return time;
}

async function loadSubs(env, dg) { const r = await env.SETTINGS.get('push_' + dg); if (!r) return {}; try { return JSON.parse(r) || {}; } catch (e) { return {}; } }
async function subList(env, dg) { const m = await loadSubs(env, dg); return Object.keys(m).map(function (d) { return m[d]; }); }

async function apiSavePushSub(env, token, deviceId, sub) {
  const dg = await tokenDigest(token);
  if (!deviceId || !sub || !sub.endpoint) return { ok: false, message: 'invalid subscription' };
  const m = await loadSubs(env, dg);
  m[deviceId] = { endpoint: sub.endpoint, keys: sub.keys };
  await env.SETTINGS.put('push_' + dg, JSON.stringify(m));
  return { ok: true };
}
async function apiRemovePushSub(env, token, deviceId) {
  const dg = await tokenDigest(token);
  const m = await loadSubs(env, dg);
  if (deviceId && m[deviceId]) { delete m[deviceId]; await env.SETTINGS.put('push_' + dg, JSON.stringify(m)); }
  return { ok: true };
}
async function apiSaveSchedule(env, token, items) {
  const dg = await tokenDigest(token);
  const clean = (items || []).filter(function (it) { return it && it.id && it.time; })
    .map(function (it) { return { id: it.id, time: Number(it.time), rep: it.rep || 'none', repN: it.repN || 1, e: it.e || '' }; });
  await env.SETTINGS.put('sched_' + dg, JSON.stringify({ items: clean, updatedAt: Date.now() }));
  return { ok: true };
}
async function apiGetSchedule(env, token) {
  const dg = await tokenDigest(token);
  const r = await env.SETTINGS.get('sched_' + dg);
  let items = []; if (r) { try { items = (JSON.parse(r).items) || []; } catch (e) {} }
  return { ok: true, ids: items.map(function (it) { return it.id; }) };
}
// 1端末で確認/タップ → 他端末の同じ通知を閉じる（close push）＋単発はスケジュールから除去
async function apiAckReminder(env, token, id, ctx) {
  const dg = await tokenDigest(token);
  const r = await env.SETTINGS.get('sched_' + dg);
  if (r) {
    let sched; try { sched = JSON.parse(r); } catch (e) { sched = null; }
    if (sched && sched.items) {
      const it = sched.items.filter(function (x) { return x.id === id; })[0];
      const recurring = it && it.rep && it.rep !== 'none';
      if (!recurring) { sched.items = sched.items.filter(function (x) { return x.id !== id; }); await env.SETTINGS.put('sched_' + dg, JSON.stringify(sched)); }
    }
  }
  const subs = await subList(env, dg);
  for (const s of subs) { try { await sendWebPush(s, { t: 'close', id: id }, env); } catch (e) {} }
  return { ok: true };
}
async function apiPushTest(env, token, ctx) {
  const dg = await tokenDigest(token);
  const subs = await subList(env, dg);
  if (!subs.length) return { ok: false, message: 'この端末はまだプッシュ購読していません（通知をオンにしてください）' };
  let sent = 0;
  for (const s of subs) { try { const st = await sendWebPush(s, { t: 'test' }, env); if (st >= 200 && st < 300) sent++; } catch (e) {} }
  return { ok: true, sent: sent, subs: subs.length };
}

// Cron 本体：全ユーザーのスケジュールを走査し、期限到来分を送信
async function runDueReminders(env) {
  const now = Date.now();
  const list = await env.SETTINGS.list({ prefix: 'sched_' });
  for (const k of list.keys) {
    const dg = k.name.slice('sched_'.length);
    const raw = await env.SETTINGS.get(k.name); if (!raw) continue;
    let sched; try { sched = JSON.parse(raw); } catch (e) { continue; }
    const items = sched.items || [];
    const due = items.filter(function (it) { return Number(it.time) <= now; });
    if (!due.length) continue;
    const m = await loadSubs(env, dg);
    const devices = Object.keys(m);
    if (!devices.length) { // 購読端末ゼロなら、過ぎた単発は溜めないよう掃除だけ
      sched.items = items.filter(function (it) { return (it.rep && it.rep !== 'none') || Number(it.time) > now; });
      await env.SETTINGS.put(k.name, JSON.stringify(sched));
      continue;
    }
    let changed = false; const dead = [];
    for (const it of due) {
      const oneShot = !(it.rep && it.rep !== 'none');
      const payload = { t: 'fire', id: it.id, e: it.e || '', oneShot: oneShot };
      for (const d of devices) {
        try { const st = await sendWebPush(m[d], payload, env); if (st === 404 || st === 410) dead.push(d); } catch (e) {}
      }
      if (oneShot) { it._done = true; changed = true; }
      else { let nt = advanceTime(Number(it.time), it.rep, it.repN), g = 0; while (nt <= now && g < 100000) { nt = advanceTime(nt, it.rep, it.repN); g++; } it.time = nt; changed = true; }
    }
    if (dead.length) { dead.forEach(function (d) { delete m[d]; }); await env.SETTINGS.put('push_' + dg, JSON.stringify(m)); }
    if (changed) { sched.items = items.filter(function (it) { return !it._done; }); await env.SETTINGS.put(k.name, JSON.stringify(sched)); }
  }
}
