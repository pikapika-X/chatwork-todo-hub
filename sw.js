/* ToDo Hub Station — 通知サービスワーカー
   ・fetch ハンドラは持たない（アプリ本体やアイコンはキャッシュしない）。
   ・push: サーバ(Cloudflare)からのWebPushを受信し、暗号化された本文(e)を端末側で復号して通知表示。
   ・notificationclick: アプリを前面に出して該当タスクへ移動し、確認済みをサーバに伝える（他端末の同通知も閉じる）。 */

var WORKER_URL = 'https://chatwork-todo-hub.usdm-information.workers.dev';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

/* ---- IndexedDB から token を読む（ページが保存。push本文の復号とack呼び出しに使用） ---- */
function idbGet(key) {
  return new Promise(function (resolve) {
    var rq = indexedDB.open('cwpush', 1);
    rq.onupgradeneeded = function () { try { rq.result.createObjectStore('kv'); } catch (_) {} };
    rq.onsuccess = function () {
      try {
        var db = rq.result, tx = db.transaction('kv', 'readonly'), g = tx.objectStore('kv').get(key);
        g.onsuccess = function () { resolve(g.result); };
        g.onerror = function () { resolve(null); };
      } catch (_) { resolve(null); }
    };
    rq.onerror = function () { resolve(null); };
  });
}

/* ---- 本文の復号（鍵 = SHA-256(token)。ページの encryptStr と対） ---- */
function b64ToBytes(b64) { var bin = atob(b64), n = bin.length, o = new Uint8Array(n); for (var i = 0; i < n; i++) o[i] = bin.charCodeAt(i); return o; }
async function decryptStr(b64, token) {
  var raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  var key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  var buf = b64ToBytes(b64), iv = buf.slice(0, 12), ct = buf.slice(12);
  var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/* ---- 確認済みをサーバへ通知（単発はスケジュールから除去＋他端末の同通知を閉じる） ---- */
function ack(id) {
  return idbGet('token').then(function (token) {
    if (!token || !id) return;
    return fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ action: 'ackReminder', token: token, id: id }) }).catch(function () {});
  }).catch(function () {});
}

self.addEventListener('push', function (e) {
  e.waitUntil((async function () {
    var data = {}; try { data = e.data ? e.data.json() : {}; } catch (_) { data = {}; }
    // 他端末で確認された → 同じ通知を閉じる
    if (data.t === 'close') {
      var ns = await self.registration.getNotifications({ tag: 'rem-' + data.id });
      ns.forEach(function (n) { n.close(); });
      return;
    }
    if (data.t === 'test') {
      return self.registration.showNotification('🔔 テスト通知', { body: 'プッシュ通知は正常に届いています。', icon: 'icon-192.png?v=2', badge: 'icon-192.png?v=2', tag: 'cwtest' });
    }
    // リマインド本文を端末側で復号（サーバは中身を読めない）
    var title = '⏰ リマインド', body = '', roomId = '', taskId = '';
    try {
      var token = await idbGet('token');
      if (token && data.e) { var info = JSON.parse(await decryptStr(data.e, token)); title = info.title || title; body = info.body || ''; roomId = info.roomId; taskId = info.taskId; }
    } catch (_) {}
    await self.registration.showNotification(title, {
      body: body, icon: 'icon-192.png?v=2', badge: 'icon-192.png?v=2',
      tag: 'rem-' + data.id, renotify: true, requireInteraction: true,
      data: { roomId: roomId, taskId: taskId, id: data.id }
    });
    // 開いているアプリにも「発火した」ことを伝え、一覧の未読件数を即時更新
    if (data.oneShot) {
      var cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      cls.forEach(function (c) { if (c.postMessage) { try { c.postMessage({ type: 'reminderFired', id: data.id }); } catch (_) {} } });
    }
  })());
});

// 通知タップ → アプリを前面化して該当タスクへ。確認済みをサーバへ（他端末の同通知も閉じる）。
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  var scope = self.registration.scope; // 例: https://pikapika-x.github.io/chatwork-todo-hub/
  e.waitUntil((async function () {
    if (d.id) { try { await ack(d.id); } catch (_) {} }
    var cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < cls.length; i++) {
      if (cls[i].url && cls[i].url.indexOf(scope) === 0) {
        if (cls[i].postMessage) { try { cls[i].postMessage({ type: 'focusTask', roomId: d.roomId, taskId: d.taskId }); } catch (_) {} }
        return cls[i].focus();
      }
    }
    var url = './index.html';
    if (d.roomId && d.taskId) url += '?focus=' + d.roomId + '-' + d.taskId;
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
