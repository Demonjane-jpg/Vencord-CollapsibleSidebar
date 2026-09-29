# 🐧 Linux External Focus Cycling Addon (`Alt + C`)

This folder contains the optional, modular helper for **Linux** users who want the `Alt + C` global focus cycling feature to switch bidirectionally between external Linux applications (browsers, terminals, code editors) and Discord floating chats.

---

## 🛠️ Supported Environments

- **X11 / X.Org**: Works with any window manager or desktop environment via `xdotool` or `wmctrl`.
- **Wayland (Hyprland)**: Fully supported natively via `hyprctl`.
- **Wayland (Sway / wlroots)**: Fully supported natively via `swaymsg`.
- **Wayland (KDE Plasma)**: Supported via `kdotool`.
- **XWayland Apps**: Supported via `xdotool`.

---

## 📦 Prerequisites

Install the appropriate tool for your desktop environment:

### On Ubuntu / Debian / Mint:
```bash
sudo apt update && sudo apt install xdotool wmctrl
```

### On Arch Linux / Manjaro:
```bash
sudo pacman -S xdotool wmctrl
```

### On Fedora / RHEL:
```bash
sudo dnf install xdotool wmctrl
```

*(Note: If you are running **Hyprland** or **Sway**, `hyprctl` or `swaymsg` is already built into your compositor!)*

---

## 🚀 Quick Installation

Run the provided install script to place `vc_focusHelper.sh` into your `~/.local/bin/` folder:

```bash
chmod +x install.sh
./install.sh
```

Alternatively, copy `focusHelper.sh` directly into your Vencord plugin folder:
```bash
cp focusHelper.sh ~/.config/Vencord/src/userplugins/collapsibleSidebar/focusHelper.sh
chmod +x ~/.config/Vencord/src/userplugins/collapsibleSidebar/focusHelper.sh
```

---

## ✨ How It Works

1. When you press `Alt + C` in any Linux app (e.g. terminal, browser), Discord captures the global shortcut and executes `focusHelper.sh save`.
2. The script records the active window handle/address to `/tmp/vc_last_fg_window.txt`.
3. Focus jumps into your Discord floating chat box.
4. Pressing `Alt + C` again cycles through any other open floating chats, and finally calls `focusHelper.sh restore`, smoothly restoring focus to your previous application without any lag or freezing.
