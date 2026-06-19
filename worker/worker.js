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
        default:             return jsonResponse({ ok: false, message: 'unknown action' }, 400);
      }
    } catch (e) {
      return jsonResponse({ ok: false, message: String(e && e.message ? e.message : e) });
    }
  }
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
function roomsBrief(rooms) { return rooms.map(r => ({ name: r.name, lastUpdate: r.last_update_time || 0 })); }

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
    message_num: r.message_num || 0
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
    if (code === 429 || code >= 500) return; // 混雑/一時エラー → スキップ（キャッシュしない）

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
    const resp = new Response(JSON.stringify(shaped), {
      headers: { 'Cache-Control': 'max-age=21600', 'Content-Type': 'application/json' }
    });
    ctx.waitUntil(cache.put(cacheKey, resp)); // 6時間保持
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
  // その部屋の last_update_time が変わるので、次回 roomTasks で自動的に取り直される。
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
