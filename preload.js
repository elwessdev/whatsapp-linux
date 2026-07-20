const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to the WhatsApp Web page (main world) so the injected
// Notification shim below can talk to the main process without granting
// the page any direct Node/Electron access.
contextBridge.exposeInMainWorld('__waNotifyBridge', {
  send: (id, title, body, icon) =>
    ipcRenderer.send('wa-notification', { id, title, body, icon }),
  onClick: (callback) => {
    ipcRenderer.on('wa-notification-clicked', (_event, id) => callback(id));
  },
});

// Injects a script into the page's own JS world that replaces the native
// Notification constructor with a shim forwarding to the Electron main
// process, which shows a real GNOME/libnotify notification.
function injectNotificationShim() {
  const script = document.createElement('script');
  script.textContent = `(() => {
    let counter = 0;
    const registry = new Map();

    class NotificationShim extends EventTarget {
      constructor(title, options = {}) {
        super();
        this._id = ++counter;
        this.title = title;
        this.body = options.body || '';
        this.icon = options.icon || '';
        this.onclick = null;
        registry.set(this._id, this);
        window.__waNotifyBridge.send(this._id, this.title, this.body, this.icon);
        // A notification is only ever clickable while it's still plausibly
        // on screen; evict it after that instead of relying solely on
        // close() being called, which WhatsApp Web doesn't always do.
        setTimeout(() => registry.delete(this._id), 30000);
      }
      close() {
        registry.delete(this._id);
      }
      addEventListener(type, listener) {
        super.addEventListener(type, listener);
      }
      static requestPermission(callback) {
        if (typeof callback === 'function') callback('granted');
        return Promise.resolve('granted');
      }
      static get permission() {
        return 'granted';
      }
    }

    window.__waNotifyBridge.onClick((id) => {
      const instance = registry.get(id);
      if (!instance) return;
      const evt = new Event('click');
      instance.dispatchEvent(evt);
      if (typeof instance.onclick === 'function') {
        instance.onclick(evt);
      }
    });

    window.Notification = NotificationShim;
  })();`;
  document.documentElement.appendChild(script);
  script.remove();
}

// ---------------------------------------------------------------------------
// Floating button to collapse/expand the WhatsApp Web contacts (chat list)
// sidebar, giving more room to the conversation panel.
// ---------------------------------------------------------------------------
const SIDEBAR_STATE_KEY = '__waLinuxSidebarCollapsed';
const CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
const CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

function injectSidebarToggle() {
  if (document.getElementById('wa-linux-toggle-btn')) return;

  const style = document.createElement('style');
  style.textContent = `
    #wa-linux-toggle-btn {
      position: fixed;
      top: 8px;
      left: 8px;
      z-index: 100000;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #202c33;
      color: #e9edef;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
      opacity: 0.85;
      transition: opacity 0.15s ease, left 0.2s ease;
    }
    #wa-linux-toggle-btn:hover { opacity: 1; }
    body.wa-linux-sidebar-collapsed #side { display: none !important; }
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'wa-linux-toggle-btn';
  button.title = 'Toggle contacts list';

  const collapsed = localStorage.getItem(SIDEBAR_STATE_KEY) === '1';
  if (collapsed) document.body.classList.add('wa-linux-sidebar-collapsed');
  button.innerHTML = collapsed ? CHEVRON_RIGHT : CHEVRON_LEFT;

  button.addEventListener('click', () => {
    const isCollapsed = document.body.classList.toggle('wa-linux-sidebar-collapsed');
    localStorage.setItem(SIDEBAR_STATE_KEY, isCollapsed ? '1' : '0');
    button.innerHTML = isCollapsed ? CHEVRON_RIGHT : CHEVRON_LEFT;
  });

  document.body.appendChild(button);
}

function waitForSidebarAndInject() {
  if (document.getElementById('side')) {
    injectSidebarToggle();
    return;
  }
  // WhatsApp Web's boot sequence (QR scan through initial sync) mutates the
  // DOM heavily; a MutationObserver watching the whole document would fire
  // on every one of those mutations. A bounded poll is cheaper here.
  const interval = setInterval(() => {
    if (document.getElementById('side')) {
      clearInterval(interval);
      injectSidebarToggle();
    }
  }, 250);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    injectNotificationShim();
    waitForSidebarAndInject();
  });
} else {
  injectNotificationShim();
  waitForSidebarAndInject();
}
