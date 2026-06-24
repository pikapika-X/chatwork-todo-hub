/* ToDo Hub Station — 通知専用サービスワーカー
   ※ fetch ハンドラは持たない（＝アプリ本体やアイコンを一切キャッシュしない）。
     目的は Android Chrome でも OS 通知を出せるようにすることだけ。 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

// 通知をタップしたら、このTODOアプリを前面に出して該当タスク（data.roomId/taskId）へ移動する。
// すでにアプリが開いていればそのウィンドウへ指示を送り、閉じていれば ?focus= 付きで起動する。
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  var scope = self.registration.scope; // 例: https://pikapika-x.github.io/chatwork-todo-hub/
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cls) {
      // すでに開いている TODO アプリのウィンドウがあれば、前面に出して該当タスクへ移動指示
      for (var i = 0; i < cls.length; i++) {
        if (cls[i].url && cls[i].url.indexOf(scope) === 0) {
          if (cls[i].postMessage) { try { cls[i].postMessage({ type: 'focusTask', roomId: d.roomId, taskId: d.taskId }); } catch (_) {} }
          return cls[i].focus();
        }
      }
      // 無ければ起動（?focus= で起動後に該当タスクへ移動）
      var url = './index.html';
      if (d.roomId && d.taskId) url += '?focus=' + d.roomId + '-' + d.taskId;
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
