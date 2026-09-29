#!/usr/bin/env bash
# Vencord CollapsibleSidebar - Linux Focus Helper
# Supports X11 (xdotool, wmctrl, xprop) and Wayland (Hyprland, Sway, KDE, XWayland)

TEMP_FILE="${TMPDIR:-/tmp}/vc_last_fg_window.txt"
ACTION="$1"
DISCORD_PID="$2"

save_window() {
    # 1. Hyprland (Wayland)
    if [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ] && command -v hyprctl >/dev/null 2>&1; then
        addr=$(hyprctl activewindow -j 2>/dev/null | grep -o '"address": "[^"]*"' | head -n1 | cut -d'"' -f4)
        if [ -n "$addr" ]; then
            echo "hypr:$addr" > "$TEMP_FILE"
            exit 0
        fi
    fi

    # 2. Sway / wlroots (Wayland)
    if [ -n "$SWAYSOCK" ] && command -v swaymsg >/dev/null 2>&1; then
        focused_id=$(swaymsg -t get_tree 2>/dev/null | grep -B2 '"focused": true' | grep '"id":' | head -n1 | tr -dc '0-9')
        if [ -n "$focused_id" ]; then
            echo "sway:$focused_id" > "$TEMP_FILE"
            exit 0
        fi
    fi

    # 3. KDE Plasma (Wayland via kdotool if available)
    if command -v kdotool >/dev/null 2>&1; then
        win_id=$(kdotool getactivewindow 2>/dev/null)
        if [ -n "$win_id" ]; then
            echo "kde:$win_id" > "$TEMP_FILE"
            exit 0
        fi
    fi

    # 4. X11 / XWayland via xdotool
    if command -v xdotool >/dev/null 2>&1; then
        win_id=$(xdotool getactivewindow 2>/dev/null)
        if [ -n "$win_id" ]; then
            echo "x11:$win_id" > "$TEMP_FILE"
            exit 0
        fi
    fi

    # 5. X11 via xprop fallback
    if command -v xprop >/dev/null 2>&1; then
        win_id=$(xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | awk '{print $NF}')
        if [ -n "$win_id" ] && [ "$win_id" != "0x0" ]; then
            echo "x11:$win_id" > "$TEMP_FILE"
            exit 0
        fi
    fi

    # 6. X11 via wmctrl fallback
    if command -v wmctrl >/dev/null 2>&1; then
        win_id=$(xprop -root 32x '\t$0' _NET_ACTIVE_WINDOW 2>/dev/null | cut -f 2)
        if [ -n "$win_id" ]; then
            echo "x11:$win_id" > "$TEMP_FILE"
            exit 0
        fi
    fi

    exit 1
}

restore_window() {
    [ ! -f "$TEMP_FILE" ] && exit 1
    target=$(cat "$TEMP_FILE" 2>/dev/null)
    [ -z "$target" ] && exit 1

    type="${target%%:*}"
    val="${target#*:}"

    case "$type" in
        hypr)
            if command -v hyprctl >/dev/null 2>&1; then
                hyprctl dispatch focuswindow "address:$val" >/dev/null 2>&1
                exit 0
            fi
            ;;
        sway)
            if command -v swaymsg >/dev/null 2>&1; then
                swaymsg "[con_id=$val] focus" >/dev/null 2>&1
                exit 0
            fi
            ;;
        kde)
            if command -v kdotool >/dev/null 2>&1; then
                kdotool windowactivate "$val" >/dev/null 2>&1
                exit 0
            fi
            ;;
        x11)
            if command -v xdotool >/dev/null 2>&1; then
                xdotool windowactivate "$val" >/dev/null 2>&1
                exit 0
            elif command -v wmctrl >/dev/null 2>&1; then
                wmctrl -i -a "$val" >/dev/null 2>&1
                exit 0
            fi
            ;;
    esac

    exit 1
}

case "$ACTION" in
    save)
        save_window
        ;;
    restore)
        restore_window
        ;;
    *)
        echo "Usage: $0 {save|restore} [discord_pid]"
        exit 1
        ;;
esac
