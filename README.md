# Vencord CollapsibleSidebar & Floating Chats

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Vencord Userplugin](https://img.shields.io/badge/Vencord-Userplugin-7289da.svg)](https://vencord.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6.svg)](https://www.typescriptlang.org/)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen.svg)]()

**CollapsibleSidebar** is a powerful [Vencord](https://vencord.dev) userplugin that lets you collapse Discord's **Servers rail**, **Messages sidebar**, and **Bottom Panel** to maximize horizontal screen space, while introducing **independent desktop floating chat windows** with full multi-monitor dragging, global focus cycling (`Alt + C`), and complete rich messaging support.

---

## ✨ Features

### 🪟 1. Independent Desktop Floating Chat Windows
- **One-Click Pop-Out**: Pop out any text channel, voice text chat, group DM, or direct message into a standalone desktop window using the pop-out icon in the channel header.
- **Drag Anywhere & Multi-Monitor**: Drag floating chat windows anywhere across your desktop setup, including secondary monitors and directly over full-screen games, web browsers, or code editors.
- **Persistent Always-On-Top**: Windows use OS-level `screen-saver` tier and native Win32 `HWND_TOPMOST` elevation. They stay on top even when other programs are opened, closed, minimized, or restored, and immediately bring themselves forward when clicked.
- **Multiple Simultaneous Chats**: Open and manage multiple floating chats at once with cascading layout positions and corner resize handles.
- **In-Window File Attachments**: Attach files, pictures, and documents directly within the floating window using the native file picker (`+` button), complete with preview chips and direct Discord REST uploads without needing to switch to the main Discord window.
- **Full Emoji, Sticker & GIF Pickers**:
  - **Server Emojis**: Full server rail navigation with server icons, custom server emoji packs, and Discord Nitro favorites.
  - **Stickers**: Server sticker picker with server navigation rail.
  - **GIFs**: Integrated Tenor GIF search and sending.
- **Discord Nitro Theme Integration**: Automatically extracts and applies custom Discord Nitro gradient themes, dark mode, light mode, and transparent backgrounds in real time.

---

### ⚡ 2. Seamless Global Focus Cycling (`Alt + C`)
- **Bidirectional Keyboard Cycling**: Seamlessly cycle between your active external application (e.g. Bing search bar in Chrome/Edge, VS Code, PowerShell, Terminal, games) and your open floating Discord chats with a single keybind.
- **Cycle Flow**:
  1. Typing in your external app (e.g. Bing search bar) $\rightarrow$ press `Alt + C`.
  2. Focus hops directly into the first open Discord floating chat composer.
  3. Press `Alt + C` again to cycle through any other open floating chats.
  4. On the final floating chat, pressing `Alt + C` returns focus directly back to your external app's typing field.
- **Zero-Lag & Deadlock-Free**: Powered by non-blocking asynchronous process spawning and lightweight Win32 P/Invoke helpers.
- **No Minimizing or Icon Locking**: Bypasses Windows Focus Stealing Prevention cleanly without simulating fake `Alt` keystrokes or triggering Alt+Tab task toggling.
- **Configurable Shortcut**: Default is `Alt + C`, fully customizable in Vencord Plugin Settings.

---

### 📐 3. Collapsible Sidebar Regions
- **Independently Toggleable Regions**:
  - **Servers Rail**: Discord's vertical server icon list.
  - **Messages Sidebar**: The channels/DM list (Friends, Nitro, DMs, text & voice channels).
  - **Bottom Panel**: Discord's user account bar, voice status, and camera/streaming controls.
  - All 8 state combinations work independently.
- **True Screen Space Reclamation**: Collapsing sidebars completely removes their layout columns, expanding your chat and voice view to 100% of the reclaimed screen width.
- **Draggable & Corner-Resizable Floating Bottom Panel**:
  - When the Messages sidebar is closed, your user panel (avatar, mute, deafen, settings) automatically floats with a dedicated drag handle and corner resize handles.
  - Dynamic `ResizeObserver` detects voice status, ping, camera preview, and screen share controls, expanding smoothly upward without clipping.
  - State and custom positions persist across Discord restarts.

---

## 📂 Project Architecture

```
collapsibleSidebar/
├── index.tsx          # Main plugin entry, sidebar toggles, context menus, and header buttons
├── floatingChat.tsx   # Floating chat portal, composers, emoji/sticker/GIF pickers & attachments
├── native.ts          # Electron main process hooks, global shortcut registry & window management
├── focusHelper.cs     # Native Win32 C# source for deadlock-free foreground window switching
├── focusHelper.exe    # Compiled high-performance Win32 helper binary
├── settings.ts        # Plugin settings definitions (custom focus keybind, options)
├── theme.ts           # Discord Nitro theme extraction and live background listener
├── extra/
│   └── linux/         # Optional modular helper scripts for Linux users (X11 & Wayland)
└── README.md          # Documentation & user guide
```

---

## 📥 Installation & Setup

> [!IMPORTANT]
> Custom userplugins require a local Vencord source build. If you don't have one set up yet, check out the [official Vencord building from source guide](https://github.com/Vendicated/Vencord#building-from-source).

### Step 1: Clone into Vencord
Clone this repository directly into your Vencord `src/userplugins/collapsibleSidebar` folder:
```bash
git clone https://github.com/Demonjane-jpg/Vencord-CollapsibleSidebar.git src/userplugins/collapsibleSidebar
```

### Step 2: Native Focus Helper Setup

#### On Windows (Default):
Compile `focusHelper.cs` using the built-in Microsoft .NET Framework C# compiler:
```powershell
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /optimize+ /out:"src\userplugins\collapsibleSidebar\focusHelper.exe" "src\userplugins\collapsibleSidebar\focusHelper.cs"
```

#### On Linux (Optional Addon):
If you are on Linux and want external app focus cycling (`Alt + C`), check out the [Linux Addon Guide](extra/linux/README.md) or run:
```bash
chmod +x src/userplugins/collapsibleSidebar/extra/linux/install.sh
./src/userplugins/collapsibleSidebar/extra/linux/install.sh
```

### Step 3: Build & Inject Vencord
1. Completely close Discord.
2. In your Vencord root directory, run:
```powershell
pnpm build
pnpm inject
```
3. Launch Discord.

---

## 🚀 How to Use

1. **Enable the Plugin**:
   - In Discord, go to **User Settings** (gear icon) $\rightarrow$ **Vencord** $\rightarrow$ **Plugins**.
   - Search for **`CollapsibleSidebar`** and toggle it **ON**.
2. **Pop Out a Floating Chat**:
   - In any channel or DM, click the **pop-out icon** in the top header (next to the search bar/pins).
   - The chat window will immediately pop out into an independent, draggable desktop window.
3. **Cycle with Keybind (`Alt + C`)**:
   - Start typing in your browser, terminal, or any app.
   - Press `Alt + C` to hop into your floating chat.
   - Press `Alt + C` again to return directly to your external app's text bar.
4. **Collapse Sidebars**:
   - Click the **sidebar toggle icon** in Discord's top titlebar to open the menu.
   - Toggle **Servers**, **Messages**, or **Bottom Panel** individually, or click **Close All** / **Open Everything**.

---

## ⚙️ Configuration

In Discord under **Settings $\rightarrow$ Plugins $\rightarrow$ CollapsibleSidebar**, you can configure:
- **Focus Keybind**: Customize the global shortcut used to cycle between external applications and floating chat windows (default: `Alt + C`, or set to `None` to disable).

---

## 📜 License

This project is licensed under the **GNU General Public License v3.0 or later (GPL-3.0-or-later)** — see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This is an unofficial community modification. It is not affiliated with, maintained by, or endorsed by Discord, Inc. or the official Vencord development team.
