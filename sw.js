/* ToDo Hub Station — 通知専用サービスワーカー
   ※ fetch ハンドラは持たない（＝アプリ本体やアイコンを一切キャッシュしない）。
     目的は Android Chrome でも OS 通知を出せるようにすることだけ。 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

// 通知をタップしたらアプリを前面に出す（無ければ開く）
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cls) {
      for (var i = 0; i < cls.length; i++) {
        if ('focus' in cls[i]) return cls[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
