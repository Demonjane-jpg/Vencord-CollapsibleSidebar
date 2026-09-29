#!/usr/bin/env bash
# Quick installer for Vencord CollapsibleSidebar Linux Focus Helper

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.local/bin"

mkdir -p "$TARGET_DIR"
cp "$SCRIPT_DIR/focusHelper.sh" "$TARGET_DIR/vc_focusHelper.sh"
chmod +x "$TARGET_DIR/vc_focusHelper.sh"

echo "✅ Installed vc_focusHelper.sh to $TARGET_DIR/vc_focusHelper.sh"
echo "Make sure you have installed one of the supported window tools:"
echo "  - For X11: xdotool (e.g. 'sudo apt install xdotool' or 'sudo pacman -S xdotool')"
echo "  - For Hyprland: hyprctl (included with Hyprland)"
echo "  - For Sway: swaymsg (included with Sway)"
echo "  - For KDE Wayland: kdotool"
