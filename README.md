# WhatsApp Desktop for Linux

An unofficial [WhatsApp Web](https://web.whatsapp.com) wrapper for Ubuntu/Linux desktops, built with Electron. Adds the things the browser tab doesn't give you: a tray icon, native GNOME notifications, background mode, and persistent login.

> **Not affiliated with WhatsApp or Meta.** This is an independent, unofficial client that loads the real web.whatsapp.com in a desktop window. "WhatsApp" and its logo are trademarks of Meta / WhatsApp LLC.

## Features

- Loads WhatsApp Web with a proper Chrome user agent so it isn't blocked
- System tray icon with Show/Hide and Quit, unread count in the tooltip
- Closing the window hides it to the tray instead of quitting
- Native desktop notifications (via GNOME/libnotify), click-to-focus
- Persistent login - no re-scanning the QR code on every relaunch
- Single-instance lock - a second launch just focuses the existing window
- Hidden menu bar (Alt to reveal), spellcheck, external links open in your default browser
- A small in-page button to collapse/expand the chat list for a wider conversation view

## Install

Download the latest `.deb` or `.AppImage` from the [Releases page](../../releases/latest), or build them yourself (below).

**.deb (Ubuntu/Debian):**
```bash
sudo apt install ./whatsapp-linux_*.deb
```

**AppImage** (no install needed, works across most distros):
```bash
chmod +x WhatsApp-Desktop-*.AppImage
./WhatsApp-Desktop-*.AppImage
```

## Build from source

```bash
git clone <this-repo>
cd whatsapp-linux
npm install
npm start          # run in dev mode
npm run build:deb  # produce dist/whatsapp-linux_*.deb
npm run build       # both .deb and .AppImage
```

Requires Node.js and npm. Packaging targets Ubuntu/Debian-based distros via [electron-builder](https://www.electron.build/).

## Why does it need `--no-sandbox`?

Ubuntu 23.10+ restricts unprivileged user-namespace creation via AppArmor, which crashes Chromium's sandbox/zygote init for apps without a registered AppArmor profile - the same thing that trips up other unpackaged Electron/CEF apps on these releases. The app disables Chromium's OS-level sandbox to avoid that crash; page-level protections (context isolation, no Node integration in the loaded page, origin-restricted permissions) are unaffected.

## License

MIT - see [LICENSE](LICENSE).
