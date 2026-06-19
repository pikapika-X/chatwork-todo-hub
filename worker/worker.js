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
        case 'init':         return jsonResponse(await apiInit(body.token));
        case 'roomTasks':    return jsonResponse(await apiRoomTasks(body.token, !!body.force, ctx));
        case 'completeTask': return jsonResponse(await apiCompleteTask(body.token, body.roomId, body.taskId));
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

async function apiRoomTasks(token, force, ctx) {
  const dg = await tokenDigest(token);
  const me = await getMe(token);          // 1 リクエスト
  const rooms = await getRooms(token);    // 1 リクエスト（last_update_time を含む）
  const cache = caches.default;
  const tasks = [];

  await mapLimit(rooms, 8, async (room) => {
    const lut = room.last_update_time || 0;
    // last_update_time をキーに含める → 部屋が更新されるとキーが変わり自動で取り直しになる
    const cacheKey = new Request('https://cw-cache.local/rt/' + dg + '/' + room.room_id + '/' + lut);

    if (!force) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const arr = await hit.json();
        arr.forEach(t => tasks.push(t));
        return;
      }
    }

    const res = await cwGet(token, '/rooms/' + room.room_id + '/tasks?status=open');
    const code = res.status;
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

  return { ok: true, me: publicMe(me), tasks: tasks, rooms: roomsBrief(rooms), cached: false };
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
