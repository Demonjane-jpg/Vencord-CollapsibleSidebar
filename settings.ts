/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    focusKeybind: {
        type: OptionType.STRING,
        default: "Alt+C",
        description: "Shortcut key to instantly focus the floating chat text box (e.g. 'Alt+C', 'Ctrl+Shift+D')",
        restartNeeded: false,
        onChange(newVal: string) {
            try {
                const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
                if (Native?.registerGlobalFocusKeybind) {
                    Native.registerGlobalFocusKeybind(newVal);
                }
            } catch {}
        }
    }
});

/**
 * Checks if a keyboard event matches the configured keybind string.
 */
export function matchKeybind(
    e: KeyboardEvent | { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; key?: string; code?: string; },
    keybindStr: string
): boolean {
    if (!keybindStr) return false;
    const parts = keybindStr.toLowerCase().split("+").map(p => p.trim());
    const wantsCtrl = parts.includes("ctrl") || parts.includes("control");
    const wantsAlt = parts.includes("alt");
    const wantsShift = parts.includes("shift");
    const wantsMeta = parts.includes("meta") || parts.includes("win") || parts.includes("cmd");
    const keyPart = parts.find(p => !["ctrl", "control", "alt", "shift", "meta", "win", "cmd"].includes(p));

    if (wantsCtrl !== e.ctrlKey) return false;
    if (wantsAlt !== e.altKey) return false;
    if (wantsShift !== e.shiftKey) return false;
    if (wantsMeta !== e.metaKey) return false;

    if (!keyPart) return true;
    const eventKey = e.key ? e.key.toLowerCase() : "";
    const eventCode = e.code ? e.code.toLowerCase() : "";

    return eventKey === keyPart || eventCode === `key${keyPart}` || eventCode === keyPart;
}
