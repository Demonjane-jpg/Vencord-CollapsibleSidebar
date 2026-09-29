/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findStoreLazy } from "@webpack";

let cachedThemeBg: string | null = null;

/**
 * Robustly extracts the active Discord theme background.
 * Works with Discord Nitro built-in gradient presets AND Discord Nitro custom color themes.
 */
export function getDiscordThemeBackground(): string | null {
    // 1. Try ClientThemesBackgroundStore
    try {
        const store: any = findStoreLazy("ClientThemesBackgroundStore");
        if (store) {
            if (typeof store.getLinearGradient === "function") {
                const grad = store.getLinearGradient();
                if (grad && typeof grad === "string" && grad !== "none") {
                    cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${grad}`;
                    return cachedThemeBg;
                }
            }
            const preset = store.gradientPreset;
            if (preset) {
                if (Array.isArray(preset.colors) && preset.colors.length > 0) {
                    const colors = preset.colors.map((c: any) =>
                        typeof c === "number" ? `#${c.toString(16).padStart(6, "0")}` : String(c)
                    );
                    const angle = typeof preset.angle === "number" ? `${preset.angle}deg` : "180deg";
                    const gradient = `linear-gradient(${angle}, ${colors.join(", ")})`;
                    cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${gradient}`;
                    return cachedThemeBg;
                }
                if (typeof preset.gradient === "string" && preset.gradient) {
                    cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${preset.gradient}`;
                    return cachedThemeBg;
                }
            }
        }
    } catch {}

    // 2. Try UserSettingsProtoStore appearance.clientThemeSettings
    try {
        const protoStore: any = findStoreLazy("UserSettingsProtoStore");
        const clientTheme = protoStore?.settings?.appearance?.clientThemeSettings;
        if (clientTheme) {
            if (Array.isArray(clientTheme.colors) && clientTheme.colors.length > 0) {
                const colors = clientTheme.colors.map((c: any) =>
                    typeof c === "number" ? `#${c.toString(16).padStart(6, "0")}` : String(c)
                );
                const angle = typeof clientTheme.angle === "number" ? `${clientTheme.angle}deg` : "180deg";
                const gradient = `linear-gradient(${angle}, ${colors.join(", ")})`;
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${gradient}`;
                return cachedThemeBg;
            }
            if (clientTheme.primaryColor != null) {
                const c1 = typeof clientTheme.primaryColor === "number"
                    ? `#${clientTheme.primaryColor.toString(16).padStart(6, "0")}`
                    : String(clientTheme.primaryColor);
                const c2 = clientTheme.accentColor != null
                    ? (typeof clientTheme.accentColor === "number"
                        ? `#${clientTheme.accentColor.toString(16).padStart(6, "0")}`
                        : String(clientTheme.accentColor))
                    : c1;
                const gradient = `linear-gradient(180deg, ${c1}, ${c2})`;
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${gradient}`;
                return cachedThemeBg;
            }
        }
    } catch {}

    // 3. Inspect DOM background elements: [class*="bg_"], .bg__*, etc.
    try {
        const bgElements = document.querySelectorAll<HTMLElement>('[class*="bg_"], [class*="bg__"]');
        for (const el of bgElements) {
            if (el.style?.backgroundImage && el.style.backgroundImage !== "none") {
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${el.style.backgroundImage}`;
                return cachedThemeBg;
            }
            if (el.style?.background && el.style.background !== "none" && !el.style.background.includes("transparent")) {
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${el.style.background}`;
                return cachedThemeBg;
            }
            const comp = window.getComputedStyle(el);
            if (comp.backgroundImage && comp.backgroundImage !== "none") {
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${comp.backgroundImage}`;
                return cachedThemeBg;
            }
        }
    } catch {}

    // 4. Check app containers: [class*="appAsidePanelWrapper_"], #app-mount, body
    try {
        const appContainers = document.querySelectorAll<HTMLElement>('[class*="appAsidePanelWrapper_"], #app-mount, body');
        for (const el of appContainers) {
            const comp = window.getComputedStyle(el);
            if (comp.backgroundImage && comp.backgroundImage !== "none") {
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${comp.backgroundImage}`;
                return cachedThemeBg;
            }
        }
    } catch {}

    // 5. Check CSS variables that Discord sets on root/body
    try {
        const docStyle = window.getComputedStyle(document.documentElement);
        const bodyStyle = window.getComputedStyle(document.body);
        for (const s of [docStyle, bodyStyle]) {
            const themeBg = s.getPropertyValue("--theme-background-gradient") ||
                            s.getPropertyValue("--custom-theme-background") ||
                            s.getPropertyValue("--client-theme-gradient") ||
                            s.getPropertyValue("--bg-base-primary");
            if (themeBg && themeBg.trim() && themeBg !== "none" && !themeBg.includes("transparent")) {
                cachedThemeBg = `linear-gradient(var(--bg-overlay-2, rgba(0, 0, 0, 0.35)), var(--bg-overlay-2, rgba(0, 0, 0, 0.35))), ${themeBg.trim()}`;
                return cachedThemeBg;
            }
        }
    } catch {}

    // 6. Check chat textarea or active guild / sidebar computed styles for tinted background
    try {
        const chatInput = document.querySelector<HTMLElement>('[class*="channelTextArea_"], form[class*="form_"]');
        if (chatInput) {
            const comp = window.getComputedStyle(chatInput);
            if (comp.backgroundColor && comp.backgroundColor !== "transparent" && comp.backgroundColor !== "rgba(0, 0, 0, 0)") {
                const rgb = comp.backgroundColor.match(/\d+/g);
                if (rgb && rgb.length >= 3) {
                    const r = parseInt(rgb[0], 10);
                    const g = parseInt(rgb[1], 10);
                    const b = parseInt(rgb[2], 10);
                    if (Math.abs(r - g) > 8 || Math.abs(r - b) > 8) {
                        cachedThemeBg = `linear-gradient(rgba(0, 0, 0, 0.25), rgba(0, 0, 0, 0.25)), rgb(${r}, ${g}, ${b})`;
                        return cachedThemeBg;
                    }
                }
            }
        }
    } catch {}

    // If previously cached, return it so theme is not lost when elements hide
    if (cachedThemeBg) return cachedThemeBg;

    return null;
}

export function listenToThemeChanges(callback: () => void): () => void {
    const cleanups: (() => void)[] = [];

    const attach = (storeName: string) => {
        try {
            const store: any = findStoreLazy(storeName);
            if (store?.addChangeListener) {
                store.addChangeListener(callback);
                cleanups.push(() => {
                    try {
                        store.removeChangeListener(callback);
                    } catch {}
                });
            }
        } catch {}
    };

    attach("ClientThemesBackgroundStore");
    attach("ThemeStore");
    attach("UserSettingsProtoStore");

    return () => {
        cleanups.forEach(fn => fn());
    };
}
