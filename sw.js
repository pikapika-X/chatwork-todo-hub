/* ToDo Hub Station — 通知専用サービスワーカー
   ※ fetch ハンドラは持たない（＝アプリ本体やアイコンを一切キャッシュしない）。
     目的は Android Chrome でも OS 通知を出せるようにすることだけ。 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

// 通知をタップしたら、そのタスクのチャットワーク位置（data.url）を開く。無ければアプリを前面に。
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cls) {
      if (url) {
        // すでに開いているチャットワークのタブがあれば、それを使い回して移動
        for (var i = 0; i < cls.length; i++) {
          if (cls[i].url && cls[i].url.indexOf('chatwork.com') > -1) {
            if (cls[i].navigate) { try { cls[i].navigate(url); } catch (_) {} }
            return cls[i].focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return;
      }
      for (var j = 0; j < cls.length; j++) { if ('focus' in cls[j]) return cls[j].focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
