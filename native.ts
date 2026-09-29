/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import electron, { app, BrowserWindow, globalShortcut, type IpcMainInvokeEvent } from "electron";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

function logNative(msg: string) {
    try {
        const p = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "vc_focus_native.log");
        fs.appendFileSync(p, new Date().toISOString() + " " + msg + "\n");
    } catch {}
}

interface FocusHelperTarget {
    command: string;
    argsPrefix: string[];
}

function getFocusHelperTarget(): FocusHelperTarget | null {
    if (process.platform === "win32") {
        const candidates = [
            path.join(process.env.TEMP || "", "vc_focusHelper.exe"),
            path.join(__dirname, "focusHelper.exe"),
            path.join(__dirname, "..", "src", "userplugins", "collapsibleSidebar", "focusHelper.exe"),
            path.join(__dirname, "userplugins", "collapsibleSidebar", "focusHelper.exe")
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return { command: p, argsPrefix: [] };
        }
    } else if (process.platform === "linux") {
        const candidates = [
            path.join(process.env.HOME || "", ".local", "bin", "vc_focusHelper.sh"),
            path.join(__dirname, "focusHelper.sh"),
            path.join(__dirname, "..", "src", "userplugins", "collapsibleSidebar", "focusHelper.sh"),
            path.join(__dirname, "..", "src", "userplugins", "collapsibleSidebar", "extra", "linux", "focusHelper.sh"),
            path.join(__dirname, "extra", "linux", "focusHelper.sh")
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return { command: "bash", argsPrefix: [p] };
        }
    }
    return null;
}

function makeChatTopmost(win: BrowserWindow) {
    if (!win || win.isDestroyed()) return;
    try {
        win.setAlwaysOnTop(true, "screen-saver");
        win.moveTop();
        if (process.platform === "win32") {
            const handleBuf = win.getNativeWindowHandle();
            const hwndStr = process.arch === "x64" ? handleBuf.readBigInt64LE().toString() : handleBuf.readInt32LE().toString();
            const helper = getFocusHelperTarget();
            if (helper) {
                // Asynchronous non-blocking invocation prevents UI stutter
                const child = spawn(helper.command, [...helper.argsPrefix, "topmost", hwndStr], { detached: true, stdio: "ignore" });
                child.unref();
            }
        }
    } catch {}
}

// Hook WebContents.prototype.setWindowOpenHandler so Electron always allows independent desktop chat windows
try {
    const wcProto = (electron as any).webContents?.prototype;
    const origSetWindowOpenHandler = wcProto?.setWindowOpenHandler;
    if (origSetWindowOpenHandler && !origSetWindowOpenHandler.__vcHooked) {
        wcProto.setWindowOpenHandler = function (handler: any) {
            this.on?.("did-create-window", (childWindow: any, details: any) => {
                if (details?.frameName?.startsWith("DISCORD_vc_chat_")) {
                    childWindow.windowKey = details.frameName;
                    makeChatTopmost(childWindow);

                    childWindow.on?.("show", () => makeChatTopmost(childWindow));
                    childWindow.on?.("focus", () => makeChatTopmost(childWindow));
                    childWindow.on?.("restore", () => makeChatTopmost(childWindow));
                }
            });
            return origSetWindowOpenHandler.call(this, (details: any) => {
                if (details.url === "about:blank" || details.frameName?.startsWith("DISCORD_vc_chat_")) {
                    return {
                        action: "allow",
                        overrideBrowserWindowOptions: {
                            autoHideMenuBar: true,
                            alwaysOnTop: true,
                            frame: false,
                            resizable: true,
                            minWidth: 320,
                            minHeight: 240,
                            backgroundColor: "#1e1f22"
                        }
                    };
                }
                return handler(details);
            });
        };
        wcProto.setWindowOpenHandler.__vcHooked = true;
    }
} catch (e) {
    console.warn("[CollapsibleSidebar] Failed to patch setWindowOpenHandler in native:", e);
}

try {
    app?.on?.("browser-window-created", (_event, win) => {
        win?.webContents?.on?.("page-title-updated", (_e, title) => {
            const match = title.match(/\[vc_chat_(.+?)\]/);
            if (match) {
                (win as any).chatChannelId = match[1];
                (win as any).windowKey = `DISCORD_vc_chat_${match[1]}`;
                makeChatTopmost(win);
            }
        });
    });
} catch {}

let currentAccelerator: string | null = null;
let lastRendererSender: IpcMainInvokeEvent["sender"] | null = null;
let originWasExternal = false;

function saveForegroundWindow() {
    const helper = getFocusHelperTarget();
    if (helper) {
        try {
            spawnSync(helper.command, [...helper.argsPrefix, "save", process.pid.toString()], { stdio: "ignore", timeout: 200 });
        } catch {}
    }
}

function restoreForegroundWindow(): boolean {
    const helper = getFocusHelperTarget();
    if (helper) {
        try {
            const child = spawn(helper.command, [...helper.argsPrefix, "restore"], { detached: true, stdio: "ignore" });
            child.unref();
            logNative("restoreForegroundWindow: spawned detached restore");
            return true;
        } catch (err) {
            logNative("restoreForegroundWindow error: " + err);
        }
    }
    return false;
}

function getMainWindow(): BrowserWindow | null {
    if (lastRendererSender && !lastRendererSender.isDestroyed()) {
        const win = BrowserWindow.fromWebContents(lastRendererSender);
        if (win && !win.isDestroyed()) return win;
    }
    const allWins = BrowserWindow.getAllWindows();
    return allWins.find(w => {
        if (w.isDestroyed()) return false;
        const title = w.getTitle() || "";
        return !title.includes("[vc_chat_") && !(w as any).windowKey?.startsWith("DISCORD_vc_chat_");
    }) ?? null;
}

function isChatWindow(win: BrowserWindow): boolean {
    if (win.isDestroyed()) return false;
    const title = win.getTitle() || "";
    const key = (win as any).windowKey || "";
    const tagged = (win as any).chatChannelId || "";
    return !!(tagged || key.startsWith("DISCORD_vc_chat_") || title.includes("[vc_chat_"));
}

function getChatChannelId(win: BrowserWindow): string | null {
    if (win.isDestroyed()) return null;
    const tagged = (win as any).chatChannelId;
    if (tagged) return tagged;
    const key = (win as any).windowKey || "";
    const m1 = key.match(/^DISCORD_vc_chat_(.+)$/);
    if (m1) return m1[1];
    const title = win.getTitle() || "";
    const m2 = title.match(/\[vc_chat_(.+?)\]/);
    if (m2) return m2[1];
    return null;
}

function getMainWebContents() {
    const mainWin = getMainWindow();
    return mainWin?.webContents ?? (lastRendererSender && !lastRendererSender.isDestroyed() ? lastRendererSender : null);
}

function focusNativeHwnd(hwndStr: string) {
    if (process.platform !== "win32") return;
    const helper = getFocusHelperTarget();
    if (helper) {
        try {
            // Asynchronous non-blocking invocation prevents UI stutter
            const child = spawn(helper.command, [...helper.argsPrefix, "focus", hwndStr], { detached: true, stdio: "ignore" });
            child.unref();
        } catch {}
    }
}

export function tagChatWindow(_e: IpcMainInvokeEvent, channelId: string) {
    const mainWin = getMainWindow();
    const allWindows = BrowserWindow.getAllWindows();
    for (const w of allWindows) {
        if (w !== mainWin && !w.isDestroyed()) {
            const title = w.getTitle() || "";
            if (title.includes(`[vc_chat_${channelId}]`) || !(w as any).chatChannelId) {
                (w as any).chatChannelId = channelId;
                (w as any).windowKey = `DISCORD_vc_chat_${channelId}`;
                makeChatTopmost(w);
            }
        }
    }
    return true;
}

export function bringToFront(_e: IpcMainInvokeEvent, channelId?: string) {
    const allWindows = BrowserWindow.getAllWindows();
    const mainWin = getMainWindow();
    for (const w of allWindows) {
        if (w !== mainWin && !w.isDestroyed() && isChatWindow(w)) {
            if (!channelId || getChatChannelId(w) === channelId) {
                makeChatTopmost(w);
            }
        }
    }
    return true;
}

export function refreshAlwaysOnTop(_e: IpcMainInvokeEvent, channelId?: string) {
    return bringToFront(_e, channelId);
}

export function registerGlobalFocusKeybind(e: IpcMainInvokeEvent, accelerator: string) {
    lastRendererSender = e.sender;

    if (currentAccelerator) {
        try {
            globalShortcut.unregister(currentAccelerator);
        } catch {}
        currentAccelerator = null;
    }

    if (!accelerator || accelerator.trim().toLowerCase() === "none") {
        return true;
    }

    try {
        if (globalShortcut.isRegistered(accelerator)) {
            globalShortcut.unregister(accelerator);
        }
    } catch {}

    try {
        const success = globalShortcut.register(accelerator, () => {
            const focusedWin = BrowserWindow.getFocusedWindow();
            const mainWin = getMainWindow();

            let targetPayload: string = "__EXTERNAL__";

            if (!focusedWin) {
                // Focus was in an external application (Chrome, Terminal, etc.)
                if (!originWasExternal) {
                    originWasExternal = true;
                    saveForegroundWindow();
                }
                targetPayload = "__EXTERNAL__";
                logNative("HotKey: external app. originWasExternal=true");
            } else if (mainWin && focusedWin === mainWin) {
                // Focus was in Discord's main window
                originWasExternal = false;
                targetPayload = "__MAIN_WINDOW__";
                logNative("HotKey: main Discord window. originWasExternal=false");
            } else {
                // Focus was in one of our floating chat windows!
                // DO NOT overwrite originWasExternal! Keep it so we can return to external!
                const chId = getChatChannelId(focusedWin);
                targetPayload = chId || "__DETACHED__";
                logNative("HotKey: floating chat. channelId=" + (chId || "unknown") + " originWasExternal=" + originWasExternal);
            }

            const sender = getMainWebContents();
            if (sender && !sender.isDestroyed()) {
                sender.executeJavaScript(`
                    if (typeof window.__vcCycleFloatingChat === "function") {
                        window.__vcCycleFloatingChat(${JSON.stringify(targetPayload)});
                    }
                `).catch(() => {});
            }
        });

        if (success) {
            currentAccelerator = accelerator;
            return true;
        }
    } catch (err) {
        console.warn("[CollapsibleSidebar] Failed to register global shortcut:", accelerator, err);
    }

    return false;
}

export function restorePreviousFocus(e?: IpcMainInvokeEvent) {
    logNative("restorePreviousFocus called. originWasExternal=" + originWasExternal);
    if (originWasExternal) {
        originWasExternal = false;
        restoreForegroundWindow();
        logNative("restorePreviousFocus: restored external window asynchronously");
        return true;
    }
    logNative("restorePreviousFocus: focusMainWindow");
    return focusMainWindow(e);
}

export function focusChatWindow(_e: IpcMainInvokeEvent, channelId: string) {
    const allWindows = BrowserWindow.getAllWindows();
    const mainWin = getMainWindow();
    let chatWin = allWindows.find(w => {
        if (w.isDestroyed()) return false;
        return getChatChannelId(w) === channelId;
    });

    if (!chatWin && mainWin) {
        const others = allWindows.filter(w => !w.isDestroyed() && w !== mainWin);
        if (others.length === 1) {
            chatWin = others[0];
        }
    }

    if (chatWin && !chatWin.isDestroyed()) {
        try {
            const handleBuf = chatWin.getNativeWindowHandle();
            const hwndStr = process.arch === "x64" ? handleBuf.readBigInt64LE().toString() : handleBuf.readInt32LE().toString();
            focusNativeHwnd(hwndStr);
        } catch {}

        makeChatTopmost(chatWin);
        chatWin.show();
        chatWin.focus();
        chatWin.webContents.focus();
        return true;
    }
    return false;
}

export function focusMainWindow(_e?: IpcMainInvokeEvent) {
    const mainWin = getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
        try {
            const handleBuf = mainWin.getNativeWindowHandle();
            const hwndStr = process.arch === "x64" ? handleBuf.readBigInt64LE().toString() : handleBuf.readInt32LE().toString();
            focusNativeHwnd(hwndStr);
        } catch {}

        mainWin.show();
        mainWin.focus();
        mainWin.webContents.focus();
        return true;
    }
    return false;
}

export function unregisterGlobalFocusKeybind() {
    if (currentAccelerator) {
        try {
            globalShortcut.unregister(currentAccelerator);
        } catch {}
        currentAccelerator = null;
    }
    return true;
}
