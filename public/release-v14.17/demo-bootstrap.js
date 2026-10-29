"use strict";
(async function () {
  try {
    const response = await fetch('/api/demo-session', { cache: 'no-store' });
    if (!response.ok) throw new Error('Örnek portföy için giriş yapmalısın.');
    const { storageScope } = await response.json();
    if (typeof storageScope !== 'string' || !storageScope.startsWith('investment-demo:')) throw new Error('Oturum doğrulanamadı.');
    function scopedStorage(storage) {
      return {
        getItem: key => storage.getItem(storageScope + key),
        setItem: (key, value) => storage.setItem(storageScope + key, value),
        removeItem: key => storage.removeItem(storageScope + key),
      };
    }
    window.DemoContext = { local: scopedStorage(localStorage), session: scopedStorage(sessionStorage) };
    const script = document.createElement('script');
    script.src = './app-v14.17.js?v=demo-1';
    document.body.append(script);
  } catch (error) {
    document.body.replaceChildren();
    const main = document.createElement('main');
    main.style.cssText = 'max-width:32rem;margin:15vh auto;padding:24px;font:16px system-ui;line-height:1.7';
    const text = document.createElement('p');
    text.textContent = error.message || 'Oturum açılamadı. Lütfen yeniden dene.';
    const link = document.createElement('a');
    link.href = '/'; link.target = '_top'; link.textContent = 'Örnek portföye dön';
    main.append(text, link); document.body.append(main);
  }
})();
