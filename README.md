# Vencord CollapsibleSidebar

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Vencord Userplugin](https://img.shields.io/badge/Vencord-Userplugin-7289da.svg)](https://vencord.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6.svg)](https://www.typescriptlang.org/)

**CollapsibleSidebar** is a custom [Vencord](https://vencord.dev) userplugin that lets you independently collapse Discord's **Servers rail**, **Messages sidebar**, and **Bottom Panel** to maximize your horizontal screen and chat space.

When the Messages sidebar is collapsed, the Bottom Panel seamlessly transitions into an adaptable, **draggable floating panel**—giving you uninterrupted access to your native Discord profile, microphone, headphones, settings, voice connections, camera, and screen-sharing controls.

---

## 📸 Screenshots

> *Screenshots coming soon!*

---

## ✨ Features

- **Independently Toggleable Regions**:
  - **Servers**: Discord's vertical server icon rail.
  - **Messages**: The entire channel/DM sidebar (Friends, Nitro, DMs, text & voice channels).
  - **Bottom Panel**: Discord's user account panel, voice connection bar, and video/stream controls.
  - All **8 state combinations** work independently without interfering with one another.
- **True Chat Space Reclamation**:
  - Collapsing the sidebars removes their grid columns entirely. Your chat, message composer, and call view expand to fill the reclaimed horizontal space.
- **Draggable Floating Bottom Panel**:
  - When the Messages sidebar is collapsed, the Bottom Panel automatically enters floating mode at its standard width (~240px) rather than being squished or hidden.
  - A dedicated top grab handle allows you to smoothly reposition the panel anywhere on your screen.
  - Interactive controls (mute, deafen, settings, disconnect, video) are completely isolated from dragging to prevent misclicks.
- **Dynamic Voice & Video Sizing**:
  - Equipped with a built-in `ResizeObserver` that automatically detects when voice connection status, RTC ping, camera previews, or screen-share controls appear.
  - Anchored positioning ensures the panel expands upward naturally without clipping or extending beyond your screen.
- **Window Boundary Clamping**:
  - Resizing your Discord window automatically re-clamps the floating panel to ensure it never gets pushed off-screen.
- **Full State & Position Persistence**:
  - Your collapse preferences and custom floating panel coordinates are saved automatically via Vencord's DataStore and restored across Discord restarts.
- **Instant Position Recovery**:
  - Double-click the drag handle or select **Reset Floating Position** from the toolbar menu to immediately snap the panel back to its default bottom-left position.

---

## 📥 Installation Guide

> [!IMPORTANT]
> **Prerequisite**: Custom userplugins require a local Vencord source build. If you do not have a working local Vencord source installation yet, follow the [official Vencord building from source guide](https://github.com/Vendicated/Vencord#building-from-source) before installing this plugin.

Choose either **Method 1 (Git)** or **Method 2 (Manual Download)** below.

### Method 1: Git Clone (Recommended)

1. Open your terminal or PowerShell and navigate to your local Vencord repository folder:
   ```bash
   cd path/to/Vencord
   ```
2. Clone this repository directly into your `src/userplugins/collapsibleSidebar` folder:
   ```bash
   git clone https://github.com/Demonjane-jpg/Vencord-CollapsibleSidebar.git src/userplugins/collapsibleSidebar
   ```
3. Build and inject Vencord (see [Building & Injecting](#-building--injecting) below).

---

### Method 2: Manual Download

1. Download the [`index.tsx`](https://raw.githubusercontent.com/Demonjane-jpg/Vencord-CollapsibleSidebar/main/index.tsx) file from this repository.
2. In your Vencord directory, navigate to `src/userplugins/`.
3. Create a folder named `collapsibleSidebar` if it does not already exist:
   ```
   Vencord/
   └── src/
       └── userplugins/
           └── collapsibleSidebar/
               └── index.tsx   <-- Place index.tsx here
   ```
4. Build and inject Vencord (see [Building & Injecting](#-building--injecting) below).

---

## 🔨 Building & Injecting

After placing the plugin in your `src/userplugins/collapsibleSidebar/` folder:

### On Windows:

1. Fully close Discord (check your system tray to ensure Discord is completely closed).
2. In your Vencord folder, open PowerShell or Command Prompt and run:
   ```powershell
   pnpm.cmd build
   pnpm.cmd inject
   ```

### On macOS / Linux:

1. Fully close Discord.
2. In your Vencord folder, open a terminal and run:
   ```bash
   pnpm build
   pnpm inject
   ```

3. Launch Discord.

---

## 🚀 How to Enable & Use

1. In Discord, open **User Settings** (the gear icon next to your name).
2. Scroll down the left sidebar to the **Vencord** section and click **Plugins**.
3. In the search box, type **`CollapsibleSidebar`**.
4. Toggle the switch to **ON**. (Discord may prompt you to restart).
5. Once enabled, look at Discord's top title bar: a new **sidebar toggle icon** will appear immediately to the right of Discord's back/forward navigation arrows.
6. Click the icon to open the controls menu:
   - **Collapse Everything**: Immediately collapses Servers, Messages, and Bottom Panel together.
   - **Expand Everything**: Immediately expands Servers, Messages, and Bottom Panel together, regardless of their current individual states.
   - **Collapse / Expand Servers**: Toggle only the server rail.
   - **Collapse / Expand Messages**: Toggle only the channels/messages sidebar.
   - **Collapse / Expand Bottom Panel**: Toggle only the user account/voice panel.
   - **Reset Floating Position**: Reset the floating panel back to its default bottom-left position.

---

## ❓ Troubleshooting

- **Plugin does not appear in Vencord Settings**:
  - Verify that the file is located at `src/userplugins/collapsibleSidebar/index.tsx`.
  - Ensure you ran `pnpm.cmd build` (or `pnpm build`) without compilation errors.
- **Changes didn't take effect in Discord**:
  - Make sure Discord was fully closed before running `pnpm.cmd inject` (or `pnpm inject`).
  - Press `Ctrl + R` (or `Cmd + R` on macOS) inside Discord to reload the client.
- **Floating panel moved off-screen**:
  - Click the sidebar toggle button in the top navigation bar and select **Reset Floating Position**, or double-click the top drag handle.
- **Accidental button clicks while moving the panel**:
  - Dragging is exclusively enabled on the **top handle bar** (`••••` grip pill). Clicking your avatar, mute, deafen, or settings buttons will never initiate a drag.

---

## 📜 License

This project is licensed under the **GNU General Public License v3.0 or later (GPL-3.0-or-later)** — see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This is an unofficial community modification. It is not affiliated with, maintained by, or endorsed by Discord, Inc. or the official Vencord development team.
