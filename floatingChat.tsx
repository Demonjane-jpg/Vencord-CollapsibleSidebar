/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { sendMessage } from "@utils/discord";
import {
    ChannelActionCreators,
    ChannelStore,
    Constants,
    DraftType,
    EmojiStore,
    GuildStore,
    IconUtils,
    Menu,
    MessageActions,
    MessageStore,
    Parser,
    ReactDOM,
    RestAPI,
    SnowflakeUtils,
    StickersStore,
    UploadHandler,
    UserSettingsProtoStore,
    UserStore,
    useEffect,
    useRef,
    useState,
    useStateFromStores
} from "@webpack/common";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { matchKeybind, settings } from "./settings";
import { getDiscordThemeBackground, listenToThemeChanges } from "./theme";

const FLOATING_CHATS_POS_KEY = "CollapsibleSidebar_floatingChatsPos";

const BASE_WIDTH = 420;
const BASE_HEIGHT = 540;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.5;

const TENOR_API_KEY = "3Z0688EVWYKH";

interface ChatPosition {
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
    scale?: number;
}

interface OpenChatState {
    channelId: string;
    isDetached: boolean;
    windowObj?: Window | null;
    containerEl?: HTMLElement | null;
    pos?: ChatPosition;
}

const DEFAULT_POSITION: ChatPosition = {
    top: 70,
    right: 24,
    scale: 1.0
};

// Global state for multiple chats
const openChats = new Map<string, OpenChatState>();
let savedChatPositions: Record<string, ChatPosition> = {};
const listeners = new Set<() => void>();
let lastActiveChannelId: string | null = null;
const activeTextareaRefs = new Map<string, HTMLTextAreaElement | null>();
const closingChats = new Set<string>();

let lastBringToFrontTime = 0;
function throttledBringToFront(channelId: string) {
    const now = Date.now();
    if (now - lastBringToFrontTime < 200) return;
    lastBringToFrontTime = now;
    try {
        const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
        Native?.bringToFront?.(channelId);
    } catch {}
}

export function openFloatingChat(channelId: string) {
    lastActiveChannelId = channelId;
    openDetachedChat(channelId);
}

export function openOverlayChat(channelId: string) {
    lastActiveChannelId = channelId;
    const existing = openChats.get(channelId);
    if (existing?.windowObj && !existing.windowObj.closed) {
        try {
            existing.windowObj.close();
        } catch {}
    }

    openChats.set(channelId, {
        channelId,
        isDetached: false
    });
    notifyChange();
}

export function openDetachedChat(channelId: string) {
    lastActiveChannelId = channelId;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    // If already open as detached, focus it
    const existing = openChats.get(channelId);
    if (existing?.isDetached && existing.windowObj && !existing.windowObj.closed) {
        try {
            existing.windowObj.focus();
        } catch {}
        return;
    }

    let title = channel.name || "Discord Chat";
    if (channel.isDM && channel.isDM()) {
        const recipientUser = UserStore.getUser(channel.recipients?.[0]);
        if (recipientUser) {
            title = `@${recipientUser.globalName || recipientUser.username}`;
        }
    }

    const frameName = `DISCORD_vc_chat_${channelId}`;
    const features = "width=440,height=580,alwaysOnTop=yes,resizable=yes,movable=yes";
    let win: Window | null = null;

    // 1. Try about:blank (allowed by patched setWindowOpenHandler)
    try {
        win = window.open("about:blank", frameName, features);
    } catch (e) {
        console.warn("[CollapsibleSidebar] about:blank open error:", e);
    }

    // 2. If null or blocked, try location.origin + "/popout" (allowed by Discord's unmodified setWindowOpenHandler)
    if (!win || win.closed) {
        try {
            const popoutUrl = `${location.origin}/popout`;
            win = window.open(popoutUrl, frameName, features);
            if (win) {
                try { win.stop?.(); } catch {}
            }
        } catch (e) {
            console.warn("[CollapsibleSidebar] popoutUrl open error:", e);
        }
    }

    try {
        if (win && win.document) {
            const doc = win.document;
            doc.title = `${title} [vc_chat_${channelId}]`;

            try {
                (win as any)?.DiscordNative?.window?.setAlwaysOnTop?.(true);
            } catch {}

            try {
                while (doc.body.firstChild) {
                    doc.body.removeChild(doc.body.firstChild);
                }
            } catch {}

            // Batch copy stylesheets from main Discord window to popout window
            const styles = document.querySelectorAll("style, link[rel='stylesheet']");
            const fragment = doc.createDocumentFragment();
            styles.forEach(s => {
                try {
                    fragment.appendChild(s.cloneNode(true));
                } catch {}
            });
            doc.head.appendChild(fragment);

            // Set classes and body styles
            doc.documentElement.className = document.documentElement.className;
            doc.body.className = document.body.className;
            doc.body.style.margin = "0";
            doc.body.style.padding = "0";
            doc.body.style.overflow = "hidden";
            doc.body.style.height = "100vh";
            doc.body.style.width = "100vw";

            const themeBg = getDiscordThemeBackground();
            if (themeBg) {
                doc.documentElement.style.setProperty("--vc-cs-theme-gradient", themeBg);
                doc.body.style.setProperty("--vc-cs-theme-gradient", themeBg);
                doc.body.style.background = themeBg;
            } else {
                doc.body.style.background = "#1e1f22";
            }

            const container = doc.createElement("div");
            container.id = "vc-floating-chat-root";
            container.style.height = "100%";
            container.style.width = "100%";
            doc.body.appendChild(container);

            (win as any).__vcChannelId = channelId;

            // Track active channel and bring to front on focus and pointerdown in detached window
            win.addEventListener("focus", () => {
                lastActiveChannelId = channelId;
                throttledBringToFront(channelId);
            });
            win.addEventListener("pointerdown", () => {
                lastActiveChannelId = channelId;
                throttledBringToFront(channelId);
            }, true);

            // Tag chat window in native helper
            try {
                const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
                Native?.tagChatWindow?.(channelId);
            } catch {}

            // Listen for window close
            win.addEventListener("beforeunload", () => {
                closeFloatingChat(channelId);
            });

            // Listen for keydown in detached window (capture phase)
            win.addEventListener("keydown", handleGlobalKeyDown, true);

            // Register global shortcut via native helper if available
            try {
                const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
                if (Native?.registerGlobalFocusKeybind) {
                    Native.registerGlobalFocusKeybind(getFocusKeybind());
                }
            } catch {}

            openChats.set(channelId, {
                channelId,
                isDetached: true,
                windowObj: win,
                containerEl: container
            });

            notifyChange();
            return;
        }
    } catch (err) {
        console.error("[CollapsibleSidebar] Failed to open detached window:", err);
    }

    // Fallback to in-app overlay only if window.open completely fails
    openOverlayChat(channelId);
}

export function closeFloatingChat(channelId?: string) {
    if (!channelId) {
        closeAllFloatingChats();
        return;
    }
    if (closingChats.has(channelId)) return;
    closingChats.add(channelId);
    try {
        const entry = openChats.get(channelId);
        if (entry?.windowObj && !entry.windowObj.closed) {
            try {
                entry.windowObj.close();
            } catch {}
        }
        openChats.delete(channelId);
        activeTextareaRefs.delete(channelId);
        if (lastActiveChannelId === channelId) {
            lastActiveChannelId = openChats.keys().next().value ?? null;
        }
        notifyChange();
    } finally {
        setTimeout(() => closingChats.delete(channelId), 400);
    }
}

export function closeAllFloatingChats() {
    for (const [, entry] of openChats.entries()) {
        if (entry.windowObj && !entry.windowObj.closed) {
            try {
                entry.windowObj.close();
            } catch {}
        }
    }
    openChats.clear();
    activeTextareaRefs.clear();
    lastActiveChannelId = null;
    notifyChange();
}

export function isFloatingChatOpen(channelId?: string): boolean {
    if (channelId) return openChats.has(channelId);
    return openChats.size > 0;
}

function notifyChange() {
    listeners.forEach(l => l());
}

export function getFocusKeybind(): string {
    try {
        return settings.store?.focusKeybind || "Alt+C";
    } catch {
        return "Alt+C";
    }
}

function getCurrentlyFocusedChatId(): string | null {
    for (const [chId, entry] of openChats.entries()) {
        if (entry.isDetached) {
            if (entry.windowObj && !entry.windowObj.closed) {
                try {
                    if (entry.windowObj.document?.hasFocus?.()) {
                        return chId;
                    }
                } catch {}
            }
        } else {
            const ta = activeTextareaRefs.get(chId);
            if (ta && (document.activeElement === ta || ta.closest(".vc-floating-chat-window")?.contains(document.activeElement))) {
                return chId;
            }
        }
    }
    return null;
}

let lastCycleTimestamp = 0;

export function cycleFloatingChatFocus(fromNative?: string | null) {
    const now = Date.now();
    if (now - lastCycleTimestamp < 250) {
        return;
    }
    lastCycleTimestamp = now;

    const validChatIds: string[] = [];
    for (const [chId, entry] of openChats.entries()) {
        if (entry.isDetached) {
            if (entry.windowObj && !entry.windowObj.closed) {
                validChatIds.push(chId);
            }
        } else {
            validChatIds.push(chId);
        }
    }

    if (validChatIds.length === 0) return;

    let nextIndex = 0;

    if (fromNative === "__EXTERNAL__" || fromNative === "__MAIN_WINDOW__") {
        // Coming into the floating chat list from outside or from main Discord window:
        // Always start with the first floating chat!
        nextIndex = 0;
    } else {
        // User was currently inside a floating chat window (or __DETACHED__):
        // Figure out WHICH chat they were in so we can advance to the next one.
        let currentChatId: string | null = null;

        // 1. Native told us a specific channelId
        if (fromNative && fromNative !== "__DETACHED__" && validChatIds.includes(fromNative)) {
            currentChatId = fromNative;
        }

        // 2. Check lastActiveChannelId (set by focus/pointerdown handlers in the detached window)
        if (!currentChatId && lastActiveChannelId && validChatIds.includes(lastActiveChannelId)) {
            currentChatId = lastActiveChannelId;
        }

        // 3. DOM-based detection (works for in-app overlays)
        if (!currentChatId) {
            const domFocused = getCurrentlyFocusedChatId();
            if (domFocused && validChatIds.includes(domFocused)) {
                currentChatId = domFocused;
            }
        }

        if (currentChatId) {
            const curIdx = validChatIds.indexOf(currentChatId);
            nextIndex = curIdx + 1;
        } else {
            // We know we're in a floating chat but can't identify which one.
            // Advance past ALL chats to trigger restore to external app.
            nextIndex = validChatIds.length;
        }
    }

    // If nextIndex is beyond the last floating chat, cycle back to the non-message window
    if (nextIndex >= validChatIds.length) {
        lastActiveChannelId = null;
        try {
            const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
            if (Native?.restorePreviousFocus) {
                Native.restorePreviousFocus();
            } else {
                Native?.focusMainWindow?.();
                window.focus();
            }
        } catch {
            window.focus();
        }
        return;
    }

    const targetChannelId = validChatIds[nextIndex];
    lastActiveChannelId = targetChannelId;
    const entry = openChats.get(targetChannelId);
    if (!entry) return;

    if (entry.isDetached) {
        try {
            const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
            Native?.focusChatWindow?.(targetChannelId);
        } catch {}

        if (entry.windowObj && !entry.windowObj.closed) {
            try {
                entry.windowObj.focus();
                const ta = entry.windowObj.document?.querySelector<HTMLTextAreaElement>(".vc-fc-composer-textarea");
                if (ta) {
                    ta.focus();
                    ta.setSelectionRange(ta.value.length, ta.value.length);
                }
            } catch {}
        }
    } else {
        const ta = activeTextareaRefs.get(targetChannelId);
        if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    }
}

export async function initFloatingChatStore() {
    // Expose cycle handler globally so native Electron shortcuts can invoke it
    (window as any).__vcCycleFloatingChat = cycleFloatingChatFocus;

    const persisted = await DataStore.get<Record<string, ChatPosition>>(FLOATING_CHATS_POS_KEY);
    if (persisted && typeof persisted === "object") {
        savedChatPositions = { ...persisted };
    }

    // Attach in-app keybind listener on main window
    window.addEventListener("keydown", handleGlobalKeyDown, true);

    // Track clicks on main window so Alt+C knows we are on main window
    window.addEventListener("mousedown", (e) => {
        if (!(e.target as HTMLElement)?.closest?.(".vc-floating-chat-window")) {
            lastActiveChannelId = "MAIN_WINDOW";
        }
    }, true);

    // Register OS-wide global shortcut via native Electron helper
    try {
        const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
        if (Native?.registerGlobalFocusKeybind) {
            Native.registerGlobalFocusKeybind(getFocusKeybind());
        }
    } catch {}
}

export function cleanupFloatingChat() {
    delete (window as any).__vcCycleFloatingChat;
    window.removeEventListener("keydown", handleGlobalKeyDown, true);
    try {
        const Native = (VencordNative?.pluginHelpers as any)?.CollapsibleSidebar;
        Native?.unregisterGlobalFocusKeybind?.();
    } catch {}
    closeAllFloatingChats();
}

function handleGlobalKeyDown(e: KeyboardEvent) {
    const keybind = getFocusKeybind();
    if (!keybind) return;

    if (matchKeybind(e, keybind)) {
        e.preventDefault();
        e.stopPropagation();
        cycleFloatingChatFocus();
    }
}

/**
 * Portal rendering all floating chat windows (In-App Overlay and Detached Desktop Windows)
 */
export function FloatingChatPortal() {
    const [, forceUpdate] = useState({});

    useEffect(() => {
        const update = () => forceUpdate({});
        listeners.add(update);
        return () => void listeners.delete(update);
    }, []);

    const allChats = Array.from(openChats.values());
    if (allChats.length === 0) return null;

    const overlayChats = allChats.filter(c => !c.isDetached);
    const detachedChats = allChats.filter(c => c.isDetached && c.containerEl);

    return (
        <>
            {overlayChats.length > 0 && ReactDOM.createPortal(
                overlayChats.map((entry, index) => {
                    const channel = ChannelStore.getChannel(entry.channelId);
                    if (!channel) return null;
                    return (
                        <ErrorBoundary key={entry.channelId}>
                            <FloatingChatWindow
                                channel={channel}
                                isDetached={false}
                                offsetIndex={index}
                                onClose={() => closeFloatingChat(entry.channelId)}
                            />
                        </ErrorBoundary>
                    );
                }),
                document.body
            )}
            {detachedChats.map(entry => {
                const channel = ChannelStore.getChannel(entry.channelId);
                if (!channel || !entry.containerEl) return null;
                return ReactDOM.createPortal(
                    <ErrorBoundary key={`detached-${entry.channelId}`}>
                        <FloatingChatWindow
                            channel={channel}
                            isDetached={true}
                            windowObj={entry.windowObj}
                            onClose={() => closeFloatingChat(entry.channelId)}
                        />
                    </ErrorBoundary>,
                    entry.containerEl
                );
            })}
        </>
    );
}

interface WindowProps {
    channel: any;
    isDetached: boolean;
    windowObj?: Window | null;
    offsetIndex?: number;
    onClose: () => void;
}

export function FloatingChatWindow({ channel, isDetached, windowObj, offsetIndex = 0, onClose }: WindowProps) {
    const [pos, setPos] = useState<ChatPosition>(() => {
        const saved = savedChatPositions[channel.id];
        if (saved) return saved;
        // Cascade windows so multiple chats don't stack directly on top of each other
        return {
            ...DEFAULT_POSITION,
            top: (DEFAULT_POSITION.top ?? 70) + (offsetIndex % 5) * 35,
            right: (DEFAULT_POSITION.right ?? 24) + (offsetIndex % 5) * 35
        };
    });

    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [themeBg, setThemeBg] = useState<string | null>(() => getDiscordThemeBackground());
    const windowRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Live theme updates
    useEffect(() => {
        const updateTheme = () => setThemeBg(getDiscordThemeBackground());
        return listenToThemeChanges(updateTheme);
    }, []);

    // Set last active channel when interacting with this window and bring to front
    const markActive = () => {
        lastActiveChannelId = channel.id;
        throttledBringToFront(channel.id);
    };

    const scale = pos.scale ?? 1.0;
    const currentWidth = Math.round(BASE_WIDTH * scale);
    const currentHeight = Math.round(BASE_HEIGHT * scale);

    // Messages subscription
    const messages = useStateFromStores([MessageStore], () => {
        try {
            return MessageStore.getMessages(channel.id)?._array ?? [];
        } catch {
            return [];
        }
    });

    // Auto-fetch messages if empty
    useEffect(() => {
        const msgs = MessageStore.getMessages(channel.id);
        if (!msgs?.hasFetched || (msgs._array && msgs._array.length === 0)) {
            try {
                MessageActions.fetchMessages({ channelId: channel.id, limit: 50 });
            } catch {}
        }
    }, [channel.id]);

    // Scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages.length]);

    // Dragging (for in-app overlay fallback)
    const handleDragStart = (e: ReactMouseEvent) => {
        if (isDetached) return; // Native desktop window has OS window dragging
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest("button") || target.closest(".vc-fc-action-btn")) return;

        markActive();
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const initialRect = windowRef.current?.getBoundingClientRect();
        if (!initialRect) return;

        setIsDragging(true);
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";

        let latestLeft = initialRect.left;
        let latestTop = initialRect.top;

        const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;

            const minLeft = -(currentWidth - 80);
            const maxLeft = window.innerWidth - 80;
            const minTop = 0;
            const maxTop = window.innerHeight - 40;

            latestLeft = Math.max(minLeft, Math.min(maxLeft, initialRect.left + deltaX));
            latestTop = Math.max(minTop, Math.min(maxTop, initialRect.top + deltaY));

            if (windowRef.current) {
                windowRef.current.style.left = `${latestLeft}px`;
                windowRef.current.style.top = `${latestTop}px`;
                windowRef.current.style.right = "auto";
                windowRef.current.style.bottom = "auto";
            }
        };

        const onMouseUp = () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            document.body.style.userSelect = prevUserSelect;
            setIsDragging(false);

            const newPos: ChatPosition = {
                scale,
                left: Math.round(latestLeft),
                top: Math.round(latestTop)
            };

            setPos(newPos);
            savedChatPositions[channel.id] = newPos;
            void DataStore.set(FLOATING_CHATS_POS_KEY, savedChatPositions);
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    };

    // Resizing (for in-app overlay)
    const handleResizeStart = (corner: "tl" | "tr" | "bl" | "br", e: ReactMouseEvent) => {
        if (isDetached) return; // Native desktop window has OS corner resizing
        if (e.button !== 0) return;
        markActive();
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const initialRect = windowRef.current?.getBoundingClientRect();
        if (!initialRect) return;

        const initialScale = scale;
        setIsResizing(true);
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";

        const maxAllowedScale = Math.min(
            MAX_SCALE,
            (window.innerWidth * 0.7) / BASE_WIDTH,
            (window.innerHeight * 0.75) / BASE_HEIGHT
        );

        let latestScale = initialScale;
        let latestLeft = initialRect.left;
        let latestTop = initialRect.top;

        const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;

            let scaleDelta = 0;
            if (corner === "br") {
                scaleDelta = (deltaX / BASE_WIDTH + deltaY / BASE_HEIGHT) / 2;
            } else if (corner === "bl") {
                scaleDelta = (-deltaX / BASE_WIDTH + deltaY / BASE_HEIGHT) / 2;
            } else if (corner === "tr") {
                scaleDelta = (deltaX / BASE_WIDTH - deltaY / BASE_HEIGHT) / 2;
            } else if (corner === "tl") {
                scaleDelta = (-deltaX / BASE_WIDTH - deltaY / BASE_HEIGHT) / 2;
            }

            const targetScale = Math.max(MIN_SCALE, Math.min(maxAllowedScale, initialScale + scaleDelta));
            const newW = Math.round(BASE_WIDTH * targetScale);
            const newH = Math.round(BASE_HEIGHT * targetScale);

            let newLeft = initialRect.left;
            let newTop = initialRect.top;

            if (corner === "tl") {
                newLeft = initialRect.right - newW;
                newTop = initialRect.bottom - newH;
            } else if (corner === "tr") {
                newLeft = initialRect.left;
                newTop = initialRect.bottom - newH;
            } else if (corner === "bl") {
                newLeft = initialRect.right - newW;
                newTop = initialRect.top;
            } else if (corner === "br") {
                newLeft = initialRect.left;
                newTop = initialRect.top;
            }

            const maxLeftBound = Math.max(0, window.innerWidth - newW);
            const maxTopBound = Math.max(0, window.innerHeight - newH);
            newLeft = Math.max(0, Math.min(maxLeftBound, newLeft));
            newTop = Math.max(0, Math.min(maxTopBound, newTop));

            latestScale = targetScale;
            latestLeft = newLeft;
            latestTop = newTop;

            if (windowRef.current) {
                windowRef.current.style.width = `${newW}px`;
                windowRef.current.style.height = `${newH}px`;
                windowRef.current.style.left = `${newLeft}px`;
                windowRef.current.style.top = `${newTop}px`;
                windowRef.current.style.right = "auto";
                windowRef.current.style.bottom = "auto";
                windowRef.current.style.setProperty("--vc-fc-scale", `${targetScale}`);
            }
        };

        const onMouseUp = () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            document.body.style.userSelect = prevUserSelect;
            setIsResizing(false);

            const finalW = Math.round(BASE_WIDTH * latestScale);
            const finalH = Math.round(BASE_HEIGHT * latestScale);
            const isLowerHalf = latestTop > (window.innerHeight - finalH) / 2;
            const isRightHalf = latestLeft > (window.innerWidth - finalW) / 2;

            const newPos: ChatPosition = { scale: latestScale };
            if (isLowerHalf) {
                newPos.bottom = Math.max(0, Math.round(window.innerHeight - (latestTop + finalH)));
            } else {
                newPos.top = Math.max(0, Math.round(latestTop));
            }

            if (isRightHalf) {
                newPos.right = Math.max(0, Math.round(window.innerWidth - (latestLeft + finalW)));
            } else {
                newPos.left = Math.max(0, Math.round(latestLeft));
            }

            setPos(newPos);
            savedChatPositions[channel.id] = newPos;
            void DataStore.set(FLOATING_CHATS_POS_KEY, savedChatPositions);
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    };

    // Reset position & size
    const handleReset = () => {
        if (isDetached) {
            windowObj?.resizeTo?.(440, 580);
            return;
        }
        const resetPos: ChatPosition = { ...DEFAULT_POSITION };
        setPos(resetPos);
        savedChatPositions[channel.id] = resetPos;
        void DataStore.set(FLOATING_CHATS_POS_KEY, savedChatPositions);
    };

    // Style coordinates
    const styleObj: Record<string, string | number> = {
        width: isDetached ? "100%" : `${currentWidth}px`,
        height: isDetached ? "100%" : `${currentHeight}px`,
        "--vc-fc-scale": scale,
    };

    if (!isDetached) {
        const maxLeft = Math.max(10, window.innerWidth - currentWidth - 10);
        const maxTop = Math.max(10, window.innerHeight - currentHeight - 10);

        if (pos.left !== undefined) {
            styleObj.left = `${Math.min(maxLeft, Math.max(10, pos.left))}px`;
        } else if (pos.right !== undefined) {
            styleObj.right = `${Math.max(10, pos.right)}px`;
        }

        if (pos.top !== undefined) {
            styleObj.top = `${Math.min(maxTop, Math.max(10, pos.top))}px`;
        } else if (pos.bottom !== undefined) {
            styleObj.bottom = `${Math.max(10, pos.bottom)}px`;
        }
    }

    if (themeBg) {
        styleObj["--vc-cs-theme-gradient"] = themeBg;
    }

    // Channel metadata
    let title = channel.name ?? "Chat";
    let iconUrl: string | null = null;
    let isDM = false;

    if (channel.isDM && channel.isDM()) {
        isDM = true;
        const recipientUser = UserStore.getUser(channel.recipients?.[0]);
        if (recipientUser) {
            title = recipientUser.globalName || recipientUser.username;
            iconUrl = IconUtils.getUserAvatarURL(recipientUser);
        }
    } else if (channel.isGroupDM && channel.isGroupDM()) {
        iconUrl = IconUtils.getChannelIconURL(channel) ?? null;
    }

    return (
        <div
            ref={windowRef}
            className={`vc-floating-chat-window ${isDetached ? "vc-fc-detached" : ""} ${isDragging ? "vc-fc-dragging" : ""} ${isResizing ? "vc-fc-resizing" : ""}`}
            style={styleObj as any}
            onMouseDown={markActive}
        >
            {/* Header bar */}
            <div
                className="vc-floating-chat-header"
                onMouseDown={handleDragStart}
                onDoubleClick={handleReset}
                title={isDetached ? "Double-click to reset size (1.0x)" : "Drag to move chat (Double-click to reset size and position)"}
            >
                <div className="vc-fc-header-info">
                    {iconUrl ? (
                        <img src={iconUrl} alt="" className="vc-fc-avatar" />
                    ) : (
                        <span className="vc-fc-hash-icon">{isDM ? "@" : "#"}</span>
                    )}
                    <span className="vc-fc-title">{title}</span>
                </div>
                <div className="vc-fc-header-actions">
                    {/* Reset size button */}
                    <button
                        className="vc-fc-action-btn"
                        onClick={handleReset}
                        title="Reset size (1.0x)"
                        type="button"
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                        </svg>
                    </button>

                    {/* Close window */}
                    <button
                        className="vc-fc-action-btn vc-fc-close-btn"
                        onClick={onClose}
                        title="Close floating chat"
                        type="button"
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M18.4 4L12 10.4 5.6 4 4 5.6l6.4 6.4L4 18.4 5.6 20l6.4-6.4 6.4 6.4 1.6-1.6-6.4-6.4L20 5.6z" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Messages list */}
            <div className="vc-floating-chat-messages">
                {messages.length === 0 ? (
                    <div className="vc-fc-empty-state">
                        <div className="vc-fc-empty-icon">{isDM ? "@" : "#"}</div>
                        <div className="vc-fc-empty-title">Welcome to {isDM ? `@${title}` : `#${title}`}!</div>
                        <div className="vc-fc-empty-subtitle">This is the start of the {title} channel.</div>
                    </div>
                ) : (
                    messages.map((msg: any) => (
                        <FloatingChatMessage key={msg.id} message={msg} />
                    ))
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Feature-rich Composer with working Emojis, GIFs, Stickers & Uploads */}
            <FloatingChatComposer
                channel={channel}
                placeholder={`Message ${isDM ? `@${title}` : `#${title}`}`}
                onFocusTextarea={markActive}
            />

            {/* Corner Resize Handles for In-App Overlay */}
            {!isDetached && (
                <>
                    <div
                        className="vc-fc-corner-handle vc-fc-corner-tl"
                        onMouseDown={e => handleResizeStart("tl", e)}
                        title="Resize window (Top-Left)"
                    />
                    <div
                        className="vc-fc-corner-handle vc-fc-corner-tr"
                        onMouseDown={e => handleResizeStart("tr", e)}
                        title="Resize window (Top-Right)"
                    />
                    <div
                        className="vc-fc-corner-handle vc-fc-corner-bl"
                        onMouseDown={e => handleResizeStart("bl", e)}
                        title="Resize window (Bottom-Left)"
                    />
                    <div
                        className="vc-fc-corner-handle vc-fc-corner-br"
                        onMouseDown={e => handleResizeStart("br", e)}
                        title="Resize window (Bottom-Right)"
                    />
                </>
            )}
        </div>
    );
}

function FloatingChatMessage({ message }: { message: any; }) {
    let authorName = message.author?.globalName || message.author?.username || "Unknown";
    let avatarUrl = "";
    try {
        if (message.author) {
            avatarUrl = IconUtils.getUserAvatarURL(message.author);
        }
    } catch {}

    let timeStr = "";
    try {
        if (message.timestamp) {
            const date = new Date(message.timestamp);
            timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        }
    } catch {}

    let renderedContent: any = message.content;
    try {
        if (Parser?.parse && typeof message.content === "string") {
            renderedContent = Parser.parse(message.content);
        }
    } catch {
        renderedContent = message.content;
    }

    const attachments = Array.isArray(message.attachments) ? message.attachments : [];

    return (
        <div className="vc-fc-msg-item">
            <div className="vc-fc-msg-avatar-col">
                {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="vc-fc-msg-avatar" />
                ) : (
                    <div className="vc-fc-msg-avatar-placeholder">
                        {authorName.charAt(0).toUpperCase()}
                    </div>
                )}
            </div>
            <div className="vc-fc-msg-content-col">
                <div className="vc-fc-msg-meta">
                    <span className="vc-fc-msg-author">{authorName}</span>
                    {message.author?.bot && <span className="vc-fc-msg-bot-tag">BOT</span>}
                    {timeStr && <span className="vc-fc-msg-timestamp">{timeStr}</span>}
                </div>
                <div className="vc-fc-msg-body">{renderedContent}</div>
                {attachments.length > 0 && (
                    <div className="vc-fc-msg-attachments">
                        {attachments.map((att: any) => {
                            const isImg = att.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(att.url);
                            return isImg ? (
                                <img
                                    key={att.id}
                                    src={att.url}
                                    alt={att.filename || "Attachment"}
                                    className="vc-fc-msg-attachment-img"
                                />
                            ) : (
                                <a
                                    key={att.id}
                                    href={att.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="vc-fc-msg-attachment-file"
                                >
                                    📎 {att.filename || "Attachment"}
                                </a>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

interface EmojiItem {
    id?: string;
    name: string;
    surrogates?: string;
    animated?: boolean;
    url?: string;
}

interface EmojiSection {
    id: string;
    title: string;
    icon?: string;
    iconUrl?: string | null;
    initials?: string;
    emojis: EmojiItem[];
}

interface StickerItem {
    id: string;
    name: string;
    url: string;
}

interface StickerSection {
    id: string;
    title: string;
    iconUrl?: string | null;
    initials?: string;
    stickers: StickerItem[];
}

const UNICODE_EMOJI_CATEGORIES = [
    {
        id: "smileys",
        name: "Smileys & People",
        icon: "😀",
        emojis: [
            "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗",
            "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄",
            "😬", "🤥", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🤧", "🥵", "🥶", "🥴", "😵", "🤯",
            "🤠", "🥳", "😎", "🤓", "🧐", "😕", "😟", "🙁", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥",
            "😢", "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "😈", "👿", "💀", "☠️",
            "💩", "🤡", "👹", "👺", "👻", "👽", "👾", "🤖", "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤏", "✌️", "🤞", "🤟",
            "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲",
            "🤝", "🙏", "💪"
        ]
    },
    {
        id: "animals",
        name: "Animals & Nature",
        icon: "🐶",
        emojis: [
            "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦",
            "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🐛", "🦋", "🐌", "🐞", "🐜", "🦟", "🐢", "🐍",
            "🦎", "🐙", "🦑", "🦐", "🦞", "🦀", "🐡", "🐠", "🐟", "🐬", "🐳", "🦈", "🐊", "🐅", "🐆", "🦓", "🦍", "🐘",
            "🦛", "🦏", "🐪", "🐫", "🦒", "🦘", "🐃", "🐂", "🐄", "🐎", "🐖", "🐏", "🐑", "🦙", "🐐", "🦌", "🐕", "🐩",
            "🐈", "🐓", "🦃", "🦚", "🦜", "🦢", "🦩", "🕊️", "🐇", "🦝", "🦨", "🦡", "🦦", "🦥", "🐁", "🐀", "🐿️", "🦔",
            "🌲", "🌳", "🌴", "🌱", "🌿", "☘️", "🍀", "🎍", "🪴", "🎋", "🍃", "🍂", "🍁", "🍄", "🌾", "💐", "🌷", "🌹",
            "🥀", "🌺", "🌸", "🌼", "🌻", "🌞", "🌝", "🌛", "🌜", "🌚", "🌕", "🌖", "🌗", "🌘", "🌑", "🌒", "🌓", "🌔",
            "🌙", "🌎", "🌍", "🌏", "🪐", "💫", "⭐", "🌟", "✨", "⚡", "☄️", "💥", "🔥", "🌪️", "🌈", "☀️", "🌤️", "⛅",
            "🌥️", "☁️", "🌦️", "🌧️", "🌨️", "🌩️", "❄️", "☃️", "⛄", "🌬️", "💨", "💧", "💦", "🫧", "☔", "☂️", "🌊"
        ]
    },
    {
        id: "food",
        name: "Food & Drink",
        icon: "🍔",
        emojis: [
            "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅",
            "🍆", "🥑", "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🫒", "🧄", "🧅", "🥔", "🍠", "🥐", "🥯", "🍞", "🥖",
            "🥨", "🧀", "🥚", "🍳", "🧈", "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🦴", "🌭", "🍔", "🍟", "🍕", "🫓", "🥪",
            "🥙", "🧆", "🌮", "🌯", "🫔", "🥗", "🥘", "🫕", "🥫", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟", "🦪", "🍤",
            "🍙", "🍚", "🍘", "🍢", "🥠", "🥮", "🍧", "🍨", "🍦", "🥧", "🧁", "🍰", "🎂", "🍮", "🍭", "🍬", "🍫", "🍿",
            "🍩", "🍪", "🌰", "🥜", "🍯", "🥛", "🍼", "🫖", "☕", "🍵", "🧃", "🥤", "🧋", "🍶", "🍺", "🍻", "🥂", "🍷"
        ]
    },
    {
        id: "activities",
        name: "Activities & Gaming",
        icon: "🎮",
        emojis: [
            "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🪀", "🏓", "🏸", "🏒", "🏑", "🥍", "🏏", "🪃",
            "🥅", "⛳", "🪁", "🏹", "🎣", "🤿", "🥊", "🥋", "🎽", "🛹", "🛼", "🛷", "⛸️", "🥌", "🎿", "⛷️", "🏂", "🪂",
            "🏋️", "🤼", "🤸", "🤺", "⛹️", "🤾", "🧗", "🏌️", "🏇", "🧘", "🏄", "🏊", "🤽", "🚣", "🧗", "🚵", "🚴", "🏆",
            "🥇", "🥈", "🥉", "🏅", "🎖️", "🏵️", "🎗️", "🎫", "🎟️", "🎪", "🤹", "🎭", "🩰", "🎨", "🎬", "🎤", "🎧", "🎼",
            "🎹", "🥁", "🎷", "🎺", "🎸", "🪕", "🎻", "🎲", "♟️", "🎯", "🎳", "🎮", "🎰", "🧩"
        ]
    },
    {
        id: "objects",
        name: "Objects & Symbols",
        icon: "💡",
        emojis: [
            "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝",
            "💟", "💌", "💤", "💢", "💣", "💬", "👁️‍🗨️", "🗨️", "🗯️", "💭", "💯", "♨️", "🛑", "🔔", "🔕", "📢", "📣",
            "🔍", "🔎", "💡", "🔦", "🏮", "🪔", "📦", "📫", "📬", "📮", "📝", "📁", "📂", "📅", "📆", "📈", "📉", "📊",
            "📋", "📌", "📍", "📎", "🖇️", "📏", "📐", "✂️", "🔒", "🔓", "🔏", "🔐", "🔑", "🗝️", "🔨", "🪓", "🔧", "🪛",
            "⚙️", "🔗", "🧲", "🔫", "🛡️", "🔮", "🧿", "💎", "⏳", "⌛", "⏰", "⏱️", "⏲️", "🕰️"
        ]
    }
];

function getFavoriteGifs(): string[] {
    const urls: string[] = [];
    try {
        const favs = (UserSettingsProtoStore as any)?.frecencyWithoutFetchingLatest?.favoriteGifs;
        if (favs?.gifs) {
            if (Array.isArray(favs.gifs)) {
                for (const g of favs.gifs) {
                    const u = typeof g === "string" ? g : (g?.src || g?.url || g?.gif);
                    if (u && typeof u === "string") urls.push(u);
                }
            } else if (typeof favs.gifs === "object") {
                const entries = Object.entries(favs.gifs);
                entries.sort((a: any, b: any) => (b[1]?.order ?? 0) - (a[1]?.order ?? 0));
                for (const [key, val] of entries) {
                    const u = (val as any)?.src || (val as any)?.url || (typeof key === "string" && key.startsWith("http") ? key : null);
                    if (u && typeof u === "string") urls.push(u);
                }
            }
        }
    } catch {}
    return urls;
}

function getFavoriteStickers(): StickerItem[] {
    const list: StickerItem[] = [];
    try {
        const favs = (UserSettingsProtoStore as any)?.frecencyWithoutFetchingLatest?.favoriteStickers;
        const stickerIds = favs?.stickerIds || (Array.isArray(favs) ? favs : []);
        if (Array.isArray(stickerIds)) {
            for (const id of stickerIds) {
                const s = StickersStore?.getStickerById?.(id);
                list.push({
                    id: String(id),
                    name: s?.name || "Favorite Sticker",
                    url: `https://cdn.discordapp.com/stickers/${id}.png?size=160`
                });
            }
        }
    } catch {}
    return list;
}

function getGuildStickerSections(currentGuildId?: string): StickerSection[] {
    const sections: StickerSection[] = [];
    const seenGuildIds = new Set<string>();

    try {
        const allGuildStickers = StickersStore?.getAllGuildStickers?.();
        if (allGuildStickers && typeof allGuildStickers.entries === "function") {
            for (const [guildId, stickers] of allGuildStickers.entries()) {
                if (!stickers || stickers.length === 0) continue;
                seenGuildIds.add(guildId);
                const guild = GuildStore?.getGuild?.(guildId);
                const guildName = guild?.name || "Server Stickers";
                let iconUrl: string | null = null;
                try {
                    if (guild) iconUrl = IconUtils.getGuildIconURL(guild) ?? null;
                } catch {}
                const initials = guildName.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3).toUpperCase();

                sections.push({
                    id: guildId,
                    title: guildName,
                    iconUrl,
                    initials,
                    stickers: stickers.map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        url: `https://cdn.discordapp.com/stickers/${s.id}.png?size=160`
                    }))
                });
            }
        }
    } catch {}

    // Check all guilds from GuildStore to ensure every server's stickers are found
    try {
        const guilds = GuildStore?.getGuilds?.();
        if (guilds && typeof guilds === "object") {
            for (const [guildId, guild] of Object.entries(guilds)) {
                if (seenGuildIds.has(guildId) || !guild) continue;
                const stickers = StickersStore?.getStickersByGuildId?.(guildId);
                if (Array.isArray(stickers) && stickers.length > 0) {
                    seenGuildIds.add(guildId);
                    const guildName = (guild as any).name || "Server Stickers";
                    let iconUrl: string | null = null;
                    try {
                        iconUrl = IconUtils.getGuildIconURL(guild as any) ?? null;
                    } catch {}
                    const initials = guildName.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3).toUpperCase();

                    sections.push({
                        id: guildId,
                        title: guildName,
                        iconUrl,
                        initials,
                        stickers: stickers.map((s: any) => ({
                            id: s.id,
                            name: s.name,
                            url: `https://cdn.discordapp.com/stickers/${s.id}.png?size=160`
                        }))
                    });
                }
            }
        }
    } catch {}

    if (currentGuildId) {
        sections.sort((a, b) => {
            if (a.id === currentGuildId) return -1;
            if (b.id === currentGuildId) return 1;
            return a.title.localeCompare(b.title);
        });
    } else {
        sections.sort((a, b) => a.title.localeCompare(b.title));
    }

    return sections;
}

function getFavoriteEmojis(guildId?: string): EmojiItem[] {
    const list: EmojiItem[] = [];
    try {
        const emojiContext = EmojiStore?.getDisambiguatedEmojiContext?.(guildId);
        const favs = emojiContext?.favoriteEmojisWithoutFetchingLatest;
        if (Array.isArray(favs)) {
            for (const e of favs) {
                if (e.id) {
                    list.push({
                        id: e.id,
                        name: e.name,
                        animated: !!e.animated,
                        url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48&quality=lossless`
                    });
                } else if ((e as any).surrogates || e.name) {
                    list.push({
                        name: e.name,
                        surrogates: (e as any).surrogates || e.name
                    });
                }
            }
        }
    } catch {}
    return list;
}

function getFrequentEmojis(guildId?: string): EmojiItem[] {
    const list: EmojiItem[] = [];
    try {
        const emojiContext = EmojiStore?.getDisambiguatedEmojiContext?.(guildId);
        const freqs = emojiContext?.getFrequentlyUsedEmojisWithoutFetchingLatest?.();
        if (Array.isArray(freqs)) {
            for (const e of freqs) {
                if (e.id) {
                    list.push({
                        id: e.id,
                        name: e.name,
                        animated: !!e.animated,
                        url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48&quality=lossless`
                    });
                } else if ((e as any).surrogates || e.name) {
                    list.push({
                        name: e.name,
                        surrogates: (e as any).surrogates || e.name
                    });
                }
            }
        }
    } catch {}
    return list;
}

function getGuildEmojiSections(currentGuildId?: string): EmojiSection[] {
    const sections: EmojiSection[] = [];
    const seenGuildIds = new Set<string>();

    // 1. Check EmojiStore.getGuilds() which holds all guilds with custom emojis
    try {
        const allGuilds = (EmojiStore as any)?.getGuilds?.();
        if (allGuilds && typeof allGuilds === "object") {
            for (const [guildId, val] of Object.entries(allGuilds)) {
                if (!val) continue;
                const emojis = (val as any).emojis || (val as any)._emojis || (Array.isArray(val) ? val : null);
                if (!Array.isArray(emojis) || emojis.length === 0) continue;
                seenGuildIds.add(guildId);

                const guild = GuildStore?.getGuild?.(guildId);
                const guildName = guild?.name || (val as any).name || "Server Emojis";
                let iconUrl: string | null = null;
                try {
                    if (guild) iconUrl = IconUtils.getGuildIconURL(guild) ?? null;
                } catch {}
                const initials = guildName.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3).toUpperCase();

                sections.push({
                    id: guildId,
                    title: guildName,
                    iconUrl,
                    initials,
                    emojis: emojis.map((e: any) => ({
                        id: e.id,
                        name: e.name,
                        animated: !!e.animated,
                        url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48&quality=lossless`
                    }))
                });
            }
        }
    } catch (e) {
        console.warn("[CollapsibleSidebar] getGuilds error:", e);
    }

    // 2. Iterate all guilds from GuildStore to ensure every single server is covered
    try {
        const guilds = GuildStore?.getGuilds?.();
        if (guilds && typeof guilds === "object") {
            for (const [guildId, guild] of Object.entries(guilds)) {
                if (seenGuildIds.has(guildId) || !guild) continue;
                const guildEmojis = (EmojiStore as any)?.getGuildEmoji?.(guildId) || (EmojiStore as any)?.getUsableGuildEmoji?.(guildId);
                if (Array.isArray(guildEmojis) && guildEmojis.length > 0) {
                    seenGuildIds.add(guildId);
                    const guildName = (guild as any).name || "Server Emojis";
                    let iconUrl: string | null = null;
                    try {
                        iconUrl = IconUtils.getGuildIconURL(guild as any) ?? null;
                    } catch {}
                    const initials = guildName.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3).toUpperCase();

                    sections.push({
                        id: guildId,
                        title: guildName,
                        iconUrl,
                        initials,
                        emojis: guildEmojis.map((e: any) => ({
                            id: e.id,
                            name: e.name,
                            animated: !!e.animated,
                            url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48&quality=lossless`
                        }))
                    });
                }
            }
        }
    } catch (e) {
        console.warn("[CollapsibleSidebar] GuildStore iteration error:", e);
    }

    // 3. Fallback to disambiguated context grouped emojis
    try {
        const emojiContext = (EmojiStore as any)?.getDisambiguatedEmojiContext?.(currentGuildId);
        const grouped = emojiContext?.getGroupedCustomEmoji?.();
        if (grouped && typeof grouped === "object") {
            for (const [guildId, emojis] of Object.entries(grouped)) {
                if (seenGuildIds.has(guildId) || !Array.isArray(emojis) || emojis.length === 0) continue;
                seenGuildIds.add(guildId);
                const guild = GuildStore?.getGuild?.(guildId);
                const guildName = guild?.name || "Server Emojis";
                let iconUrl: string | null = null;
                try {
                    if (guild) iconUrl = IconUtils.getGuildIconURL(guild) ?? null;
                } catch {}
                const initials = guildName.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3).toUpperCase();

                sections.push({
                    id: guildId,
                    title: guildName,
                    iconUrl,
                    initials,
                    emojis: emojis.map((e: any) => ({
                        id: e.id,
                        name: e.name,
                        animated: !!e.animated,
                        url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48&quality=lossless`
                    }))
                });
            }
        }
    } catch {}

    if (currentGuildId) {
        sections.sort((a, b) => {
            if (a.id === currentGuildId) return -1;
            if (b.id === currentGuildId) return 1;
            return a.title.localeCompare(b.title);
        });
    } else {
        sections.sort((a, b) => a.title.localeCompare(b.title));
    }

    return sections;
}

async function uploadAndSendMessage(channelId: string, content: string, files: File[]): Promise<boolean> {
    try {
        const fileReqs = files.map((f, i) => ({
            filename: f.name,
            file_size: f.size,
            id: String(i),
            is_clip: false
        }));

        const attachRes = await RestAPI.post({
            url: `/channels/${channelId}/attachments`,
            body: { files: fileReqs }
        });

        const attachments = attachRes?.body?.attachments;
        if (!attachments || !Array.isArray(attachments)) {
            throw new Error("No attachments returned from Discord attachments endpoint");
        }

        const attachmentsPayload: any[] = [];
        for (let i = 0; i < files.length; i++) {
            const item = attachments[i];
            const file = files[i];
            if (!item || !item.upload_url) continue;

            await fetch(item.upload_url, {
                method: "PUT",
                body: file,
                headers: {
                    "Content-Type": file.type || "application/octet-stream"
                }
            });

            attachmentsPayload.push({
                id: String(i),
                filename: file.name,
                uploaded_filename: item.upload_filename
            });
        }

        const nonce = SnowflakeUtils?.fromTimestamp?.(Date.now()) ?? Date.now().toString();

        await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content: content || "",
                nonce,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: [],
                attachments: attachmentsPayload
            }
        });

        return true;
    } catch (err) {
        console.error("[CollapsibleSidebar] Direct file upload failed:", err);
        return false;
    }
}

function FloatingChatComposer({ channel, placeholder, onFocusTextarea }: { channel: any; placeholder: string; onFocusTextarea: () => void; }) {
    const [text, setText] = useState("");
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [activePopover, setActivePopover] = useState<"emoji" | "gif" | "sticker" | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Register textarea ref for global keybind focus
    useEffect(() => {
        activeTextareaRefs.set(channel.id, textareaRef.current);
        return () => {
            activeTextareaRefs.delete(channel.id);
        };
    }, [channel.id]);

    const handleSend = async () => {
        if (isUploading) return;
        const trimmed = text.trim();
        if (!trimmed && pendingFiles.length === 0) return;

        if (pendingFiles.length > 0) {
            setIsUploading(true);
            try {
                const filesToSend = [...pendingFiles];
                const ok = await uploadAndSendMessage(channel.id, trimmed, filesToSend);
                if (ok) {
                    setPendingFiles([]);
                    setText("");
                    setActivePopover(null);
                    if (textareaRef.current) {
                        textareaRef.current.style.height = "auto";
                        textareaRef.current.focus();
                    }
                }
            } finally {
                setIsUploading(false);
            }
            return;
        }

        try {
            sendMessage(channel.id, { content: trimmed });
            setText("");
            setActivePopover(null);
            if (textareaRef.current) {
                textareaRef.current.style.height = "auto";
                textareaRef.current.focus();
            }
        } catch (e) {
            console.error("[CollapsibleSidebar] Failed to send message:", e);
        }
    };

    const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        } else if (e.key === "Escape" && activePopover) {
            e.preventDefault();
            setActivePopover(null);
        }
    };

    const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
        setText(e.target.value);
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
        }
    };

    // Insert emoji at cursor position
    const handleInsertEmoji = (emoji: string) => {
        const textarea = textareaRef.current;
        if (textarea) {
            const start = textarea.selectionStart ?? text.length;
            const end = textarea.selectionEnd ?? text.length;
            const nextText = text.substring(0, start) + emoji + text.substring(end);
            setText(nextText);
            setTimeout(() => {
                textarea.focus();
                textarea.setSelectionRange(start + emoji.length, start + emoji.length);
            }, 0);
        } else {
            setText(prev => prev + emoji);
        }
    };

    // Send GIF immediately
    const handleSendGif = (gifUrl: string) => {
        try {
            sendMessage(channel.id, { content: gifUrl });
            setActivePopover(null);
            textareaRef.current?.focus();
        } catch {}
    };

    // Send Sticker
    const handleSendSticker = (stickerId: string, stickerUrl: string) => {
        try {
            sendMessage(channel.id, { content: "" }, false, { stickerIds: [stickerId] });
            setActivePopover(null);
            textareaRef.current?.focus();
        } catch {
            // Fallback to sending sticker image link
            try {
                sendMessage(channel.id, { content: stickerUrl });
                setActivePopover(null);
                textareaRef.current?.focus();
            } catch {}
        }
    };

    // Attach file locally in floating chat window
    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        setPendingFiles(prev => [...prev, ...Array.from(files)]);
        e.target.value = "";
    };

    return (
        <div className="vc-floating-chat-input-wrapper">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={handleFileChange}
            />

            {/* Popovers: Emoji, GIF, Sticker */}
            {activePopover === "emoji" && (
                <EmojiPickerPopover
                    channel={channel}
                    onSelectEmoji={handleInsertEmoji}
                    onClose={() => setActivePopover(null)}
                />
            )}
            {activePopover === "gif" && (
                <GifPickerPopover
                    onSelectGif={handleSendGif}
                    onClose={() => setActivePopover(null)}
                />
            )}
            {activePopover === "sticker" && (
                <StickerPickerPopover
                    channel={channel}
                    onSelectSticker={handleSendSticker}
                    onClose={() => setActivePopover(null)}
                />
            )}

            {/* Attached file chips */}
            {pendingFiles.length > 0 && (
                <div className="vc-fc-pending-attachments">
                    {pendingFiles.map((file, i) => (
                        <div key={`${file.name}-${i}`} className="vc-fc-attachment-chip" title={`${file.name} (${Math.round(file.size / 1024)} KB)`}>
                            <span className="vc-fc-attachment-name">📎 {file.name}</span>
                            {!isUploading && (
                                <button
                                    type="button"
                                    className="vc-fc-attachment-remove"
                                    onClick={() => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                                    title="Remove attachment"
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    ))}
                    {isUploading && <span className="vc-fc-uploading-tag">Uploading...</span>}
                </div>
            )}

            <div className="vc-fc-composer-container">
                {/* Upload attachment button */}
                <button
                    className="vc-fc-composer-btn vc-fc-composer-upload"
                    onClick={() => fileInputRef.current?.click()}
                    title="Attach files to message"
                    type="button"
                    disabled={isUploading}
                >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 11h3a1 1 0 0 1 0 2h-3v3a1 1 0 0 1-2 0v-3H8a1 1 0 0 1 0-2h3V8a1 1 0 0 1 2 0z" />
                    </svg>
                </button>

                {/* Expanding text input */}
                <textarea
                    ref={textareaRef}
                    className="vc-fc-composer-textarea"
                    placeholder={placeholder}
                    value={text}
                    rows={1}
                    onFocus={onFocusTextarea}
                    onChange={handleInput}
                    onKeyDown={handleKeyDown}
                    disabled={isUploading}
                />

                {/* Expression buttons: GIF, Sticker, Emoji */}
                <div className="vc-fc-composer-actions">
                    <button
                        className={`vc-fc-composer-btn ${activePopover === "gif" ? "vc-fc-btn-active" : ""}`}
                        onClick={() => setActivePopover(activePopover === "gif" ? null : "gif")}
                        title="Search and send GIFs"
                        type="button"
                    >
                        <span className="vc-fc-btn-label">GIF</span>
                    </button>
                    <button
                        className={`vc-fc-composer-btn ${activePopover === "sticker" ? "vc-fc-btn-active" : ""}`}
                        onClick={() => setActivePopover(activePopover === "sticker" ? null : "sticker")}
                        title="Send stickers"
                        type="button"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M12 2a10 10 0 0 0-10 10c0 5.52 4.48 10 10 10s10-4.48 10-10A10 10 0 0 0 12 2zm5 12.5a5.5 5.5 0 0 1-5 3.5 5.5 5.5 0 0 1-5-3.5 1 1 0 0 1 1.88-.67c.6 1.7 2 2.17 3.12 2.17s2.52-.47 3.12-2.17a1 1 0 0 1 1.88.67zM8.5 10a1.5 1.5 0 1 1 1.5-1.5A1.5 1.5 0 0 1 8.5 10zm7 0a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5z" />
                        </svg>
                    </button>
                    <button
                        className={`vc-fc-composer-btn ${activePopover === "emoji" ? "vc-fc-btn-active" : ""}`}
                        onClick={() => setActivePopover(activePopover === "emoji" ? null : "emoji")}
                        title="Select emojis"
                        type="button"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-3.5 7a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 8.5 9zm7 0a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 15.5 9zm-7 6.5a4.5 4.5 0 0 0 7 0 1 1 0 1 1 1.6 1.2 6.5 6.5 0 0 1-10.2 0 1 1 0 0 1 1.6-1.2z" />
                        </svg>
                    </button>
                    <button
                        className={`vc-fc-send-btn ${((text.trim() || pendingFiles.length > 0) && !isUploading) ? "vc-fc-send-active" : ""}`}
                        onClick={handleSend}
                        title={isUploading ? "Uploading..." : "Send message"}
                        type="button"
                        disabled={isUploading}
                    >
                        {isUploading ? (
                            <svg className="vc-fc-spinner" viewBox="0 0 24 24" width="16" height="16">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="30 60" />
                            </svg>
                        ) : (
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                            </svg>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * Built-in Emoji Picker with Favorites, Frequent, Server icons, and Categories
 */
function EmojiPickerPopover({
    channel,
    onSelectEmoji,
    onClose
}: {
    channel: any;
    onSelectEmoji: (emoji: string) => void;
    onClose: () => void;
}) {
    const [search, setSearch] = useState("");
    const [activeNav, setActiveNav] = useState<string>("favorites");
    const contentRef = useRef<HTMLDivElement>(null);

    const guildId = channel?.guild_id;
    const favoriteEmojis = useRef<EmojiItem[]>(getFavoriteEmojis(guildId)).current;
    const frequentEmojis = useRef<EmojiItem[]>(getFrequentEmojis(guildId)).current;
    const guildSections = useRef<EmojiSection[]>(getGuildEmojiSections(guildId)).current;

    const scrollToSection = (secId: string) => {
        setActiveNav(secId);
        const el = contentRef.current?.querySelector(`#vc-emoji-sec-${secId}`);
        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    const handleEmojiClick = (item: EmojiItem | string) => {
        if (typeof item === "string") {
            onSelectEmoji(item);
        } else if (item.id) {
            const tag = item.animated ? `<a:${item.name}:${item.id}> ` : `<:${item.name}:${item.id}> `;
            onSelectEmoji(tag);
        } else {
            onSelectEmoji(item.surrogates || item.name || "");
        }
    };

    const searchLower = search.trim().toLowerCase();

    return (
        <div className="vc-fc-popover vc-fc-emoji-popover">
            <div className="vc-fc-popover-header">
                <input
                    type="text"
                    className="vc-fc-popover-search"
                    placeholder="Search emojis..."
                    value={search}
                    autoFocus
                    onChange={e => setSearch(e.target.value)}
                />
                <button className="vc-fc-popover-close" onClick={onClose} type="button">✕</button>
            </div>

            <div className="vc-fc-popover-layout">
                {/* Left Navigation Rail */}
                {!searchLower && (
                    <div className="vc-fc-popover-nav">
                        {favoriteEmojis.length > 0 && (
                            <button
                                className={`vc-fc-nav-btn ${activeNav === "favorites" ? "vc-fc-nav-btn-active" : ""}`}
                                onClick={() => scrollToSection("favorites")}
                                title="Favorites"
                                type="button"
                            >
                                ⭐
                            </button>
                        )}
                        {frequentEmojis.length > 0 && (
                            <button
                                className={`vc-fc-nav-btn ${activeNav === "frequent" ? "vc-fc-nav-btn-active" : ""}`}
                                onClick={() => scrollToSection("frequent")}
                                title="Frequently Used"
                                type="button"
                            >
                                🕒
                            </button>
                        )}

                        {guildSections.length > 0 && <div className="vc-fc-nav-divider" />}

                        {/* Server Icons */}
                        {guildSections.map(sec => (
                            <button
                                key={sec.id}
                                className={`vc-fc-nav-btn ${activeNav === sec.id ? "vc-fc-nav-btn-active" : ""}`}
                                onClick={() => scrollToSection(sec.id)}
                                title={sec.title}
                                type="button"
                            >
                                {sec.iconUrl ? (
                                    <img src={sec.iconUrl} alt={sec.title} className="vc-fc-nav-guild-icon" />
                                ) : (
                                    <div className="vc-fc-nav-guild-initials">{sec.initials}</div>
                                )}
                            </button>
                        ))}

                        <div className="vc-fc-nav-divider" />

                        {/* Unicode categories */}
                        {UNICODE_EMOJI_CATEGORIES.map(cat => (
                            <button
                                key={cat.id}
                                className={`vc-fc-nav-btn ${activeNav === cat.id ? "vc-fc-nav-btn-active" : ""}`}
                                onClick={() => scrollToSection(cat.id)}
                                title={cat.name}
                                type="button"
                            >
                                {cat.icon}
                            </button>
                        ))}
                    </div>
                )}

                {/* Right Scrollable Content Container */}
                <div ref={contentRef} className="vc-fc-popover-content">
                    {searchLower ? (
                        <div>
                            <div className="vc-fc-section-header">Search Results</div>
                            <div className="vc-fc-emoji-grid">
                                {guildSections
                                    .flatMap(s => s.emojis)
                                    .concat(favoriteEmojis)
                                    .concat(frequentEmojis)
                                    .filter((item, idx, self) => item.id && self.findIndex(t => t.id === item.id) === idx)
                                    .filter(item => item.name.toLowerCase().includes(searchLower))
                                    .map((item, i) => (
                                        <button
                                            key={`s-${item.id}-${i}`}
                                            className="vc-fc-emoji-item"
                                            title={`:${item.name}:`}
                                            onClick={() => handleEmojiClick(item)}
                                            type="button"
                                        >
                                            <img src={item.url} alt={item.name} className="vc-fc-custom-emoji-img" />
                                        </button>
                                    ))}

                                {UNICODE_EMOJI_CATEGORIES
                                    .flatMap(c => c.emojis)
                                    .filter(e => e.includes(searchLower))
                                    .map((e, i) => (
                                        <button
                                            key={`su-${i}`}
                                            className="vc-fc-emoji-item"
                                            onClick={() => handleEmojiClick(e)}
                                            type="button"
                                        >
                                            {e}
                                        </button>
                                    ))}
                            </div>
                        </div>
                    ) : (
                        <>
                            {favoriteEmojis.length > 0 && (
                                <div id="vc-emoji-sec-favorites" className="vc-fc-section">
                                    <div className="vc-fc-section-header">⭐ Favorites</div>
                                    <div className="vc-fc-emoji-grid">
                                        {favoriteEmojis.map((e, i) => (
                                            <button
                                                key={`fav-${e.id || i}`}
                                                className="vc-fc-emoji-item"
                                                title={e.name}
                                                onClick={() => handleEmojiClick(e)}
                                                type="button"
                                            >
                                                {e.url ? (
                                                    <img src={e.url} alt={e.name} className="vc-fc-custom-emoji-img" />
                                                ) : (
                                                    e.surrogates || e.name
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {frequentEmojis.length > 0 && (
                                <div id="vc-emoji-sec-frequent" className="vc-fc-section">
                                    <div className="vc-fc-section-header">🕒 Frequently Used</div>
                                    <div className="vc-fc-emoji-grid">
                                        {frequentEmojis.map((e, i) => (
                                            <button
                                                key={`freq-${e.id || i}`}
                                                className="vc-fc-emoji-item"
                                                title={e.name}
                                                onClick={() => handleEmojiClick(e)}
                                                type="button"
                                            >
                                                {e.url ? (
                                                    <img src={e.url} alt={e.name} className="vc-fc-custom-emoji-img" />
                                                ) : (
                                                    e.surrogates || e.name
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {guildSections.map(sec => (
                                <div key={sec.id} id={`vc-emoji-sec-${sec.id}`} className="vc-fc-section">
                                    <div className="vc-fc-section-header">{sec.title}</div>
                                    <div className="vc-fc-emoji-grid">
                                        {sec.emojis.map((e, i) => (
                                            <button
                                                key={`${sec.id}-${e.id || i}`}
                                                className="vc-fc-emoji-item"
                                                title={`:${e.name}:`}
                                                onClick={() => handleEmojiClick(e)}
                                                type="button"
                                            >
                                                <img src={e.url} alt={e.name} className="vc-fc-custom-emoji-img" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}

                            {UNICODE_EMOJI_CATEGORIES.map(cat => (
                                <div key={cat.id} id={`vc-emoji-sec-${cat.id}`} className="vc-fc-section">
                                    <div className="vc-fc-section-header">{cat.icon} {cat.name}</div>
                                    <div className="vc-fc-emoji-grid">
                                        {cat.emojis.map((emoji, i) => (
                                            <button
                                                key={`${cat.id}-${i}`}
                                                className="vc-fc-emoji-item"
                                                onClick={() => handleEmojiClick(emoji)}
                                                type="button"
                                            >
                                                {emoji}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

const GIF_CATEGORIES = [
    { id: "favorites", label: "⭐ Favorites" },
    { id: "trending", label: "🔥 Trending" },
    { id: "anime", label: "🐱 Anime" },
    { id: "memes", label: "😹 Memes" },
    { id: "animals", label: "🐶 Animals" },
    { id: "dance", label: "💃 Dance" },
    { id: "gaming", label: "🎮 Gaming" },
    { id: "cry", label: "😭 Cry" },
    { id: "love", label: "❤️ Love" },
    { id: "happy", label: "😄 Happy" }
];

/**
 * Built-in GIF Picker powered by Tenor API with Favorites tab
 */
function GifPickerPopover({ onSelectGif, onClose }: { onSelectGif: (url: string) => void; onClose: () => void; }) {
    const [query, setQuery] = useState("");
    const [activeTab, setActiveTab] = useState<string>("favorites");
    const [gifs, setGifs] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);

    const favoriteGifs = useRef<string[]>(getFavoriteGifs()).current;

    const fetchGifs = async (searchTerm: string) => {
        setLoading(true);
        try {
            const url = searchTerm.trim()
                ? `https://api.tenor.com/v1/search?q=${encodeURIComponent(searchTerm)}&key=${TENOR_API_KEY}&limit=30`
                : `https://api.tenor.com/v1/trending?key=${TENOR_API_KEY}&limit=30`;
            const res = await fetch(url);
            const data = await res.json();
            if (data?.results && Array.isArray(data.results)) {
                const urls = data.results
                    .map((item: any) => item.media?.[0]?.gif?.url || item.url)
                    .filter(Boolean);
                setGifs(urls);
            }
        } catch {
            setGifs([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === "favorites") {
            setGifs(favoriteGifs);
        } else if (activeTab === "trending") {
            void fetchGifs("");
        } else if (activeTab) {
            void fetchGifs(activeTab);
        }
    }, [activeTab]);

    const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            setActiveTab("");
            void fetchGifs(query);
        }
    };

    return (
        <div className="vc-fc-popover vc-fc-gif-popover">
            <div className="vc-fc-popover-header">
                <input
                    type="text"
                    className="vc-fc-popover-search"
                    placeholder="Search Tenor GIFs (press Enter)..."
                    value={query}
                    autoFocus
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                />
                <button className="vc-fc-popover-close" onClick={onClose} type="button">✕</button>
            </div>

            {/* Quick category pills */}
            <div className="vc-fc-gif-tabs">
                {GIF_CATEGORIES.map(cat => (
                    <button
                        key={cat.id}
                        className={`vc-fc-gif-tab-btn ${activeTab === cat.id ? "vc-fc-gif-tab-active" : ""}`}
                        onClick={() => {
                            setQuery("");
                            setActiveTab(cat.id);
                        }}
                        type="button"
                    >
                        {cat.label}
                    </button>
                ))}
            </div>

            <div className="vc-fc-popover-body vc-fc-gif-grid">
                {loading && <div className="vc-fc-loading">Loading GIFs...</div>}
                {!loading && activeTab === "favorites" && gifs.length === 0 && (
                    <div className="vc-fc-empty">No favorite GIFs found. Star GIFs on Discord to see them here!</div>
                )}
                {!loading && activeTab !== "favorites" && gifs.length === 0 && (
                    <div className="vc-fc-empty">No GIFs found.</div>
                )}
                {!loading && gifs.map((url, i) => (
                    <img
                        key={i}
                        src={url}
                        alt="GIF"
                        className="vc-fc-gif-item"
                        onClick={() => onSelectGif(url)}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * Built-in Sticker Picker with Favorites and Server icon navigation rail
 */
function StickerPickerPopover({
    channel,
    onSelectSticker,
    onClose
}: {
    channel: any;
    onSelectSticker: (id: string, url: string) => void;
    onClose: () => void;
}) {
    const [search, setSearch] = useState("");
    const [activeNav, setActiveNav] = useState<string>("favorites");
    const contentRef = useRef<HTMLDivElement>(null);

    const guildId = channel?.guild_id;
    const favoriteStickers = useRef<StickerItem[]>(getFavoriteStickers()).current;
    const guildSections = useRef<StickerSection[]>(getGuildStickerSections(guildId)).current;

    const scrollToSection = (secId: string) => {
        setActiveNav(secId);
        const el = contentRef.current?.querySelector(`#vc-sticker-sec-${secId}`);
        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    const searchLower = search.trim().toLowerCase();

    return (
        <div className="vc-fc-popover vc-fc-sticker-popover">
            <div className="vc-fc-popover-header">
                <input
                    type="text"
                    className="vc-fc-popover-search"
                    placeholder="Search stickers..."
                    value={search}
                    autoFocus
                    onChange={e => setSearch(e.target.value)}
                />
                <button className="vc-fc-popover-close" onClick={onClose} type="button">✕</button>
            </div>

            <div className="vc-fc-popover-layout">
                {/* Left Navigation Rail */}
                {!searchLower && (
                    <div className="vc-fc-popover-nav">
                        <button
                            className={`vc-fc-nav-btn ${activeNav === "favorites" ? "vc-fc-nav-btn-active" : ""}`}
                            onClick={() => scrollToSection("favorites")}
                            title="Favorites"
                            type="button"
                        >
                            ⭐
                        </button>

                        {guildSections.length > 0 && <div className="vc-fc-nav-divider" />}

                        {/* Server Icons */}
                        {guildSections.map(sec => (
                            <button
                                key={sec.id}
                                className={`vc-fc-nav-btn ${activeNav === sec.id ? "vc-fc-nav-btn-active" : ""}`}
                                onClick={() => scrollToSection(sec.id)}
                                title={sec.title}
                                type="button"
                            >
                                {sec.iconUrl ? (
                                    <img src={sec.iconUrl} alt={sec.title} className="vc-fc-nav-guild-icon" />
                                ) : (
                                    <div className="vc-fc-nav-guild-initials">{sec.initials}</div>
                                )}
                            </button>
                        ))}
                    </div>
                )}

                {/* Right Scrollable Content Container */}
                <div ref={contentRef} className="vc-fc-popover-content">
                    {searchLower ? (
                        <div>
                            <div className="vc-fc-section-header">Matching Stickers</div>
                            <div className="vc-fc-sticker-grid">
                                {guildSections
                                    .flatMap(s => s.stickers)
                                    .concat(favoriteStickers)
                                    .filter((s, idx, self) => self.findIndex(t => t.id === s.id) === idx)
                                    .filter(s => s.name.toLowerCase().includes(searchLower))
                                    .map(s => (
                                        <div
                                            key={`search-${s.id}`}
                                            className="vc-fc-sticker-item"
                                            title={s.name}
                                            onClick={() => onSelectSticker(s.id, s.url)}
                                        >
                                            <img src={s.url} alt={s.name} className="vc-fc-sticker-img" />
                                        </div>
                                    ))}
                            </div>
                        </div>
                    ) : (
                        <>
                            <div id="vc-sticker-sec-favorites" className="vc-fc-section">
                                <div className="vc-fc-section-header">⭐ Favorites</div>
                                {favoriteStickers.length === 0 ? (
                                    <div className="vc-fc-empty">No favorite stickers found.</div>
                                ) : (
                                    <div className="vc-fc-sticker-grid">
                                        {favoriteStickers.map(s => (
                                            <div
                                                key={`fav-${s.id}`}
                                                className="vc-fc-sticker-item"
                                                title={s.name}
                                                onClick={() => onSelectSticker(s.id, s.url)}
                                            >
                                                <img src={s.url} alt={s.name} className="vc-fc-sticker-img" />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {guildSections.map(sec => (
                                <div key={sec.id} id={`vc-sticker-sec-${sec.id}`} className="vc-fc-section">
                                    <div className="vc-fc-section-header">{sec.title}</div>
                                    <div className="vc-fc-sticker-grid">
                                        {sec.stickers.map(s => (
                                            <div
                                                key={`${sec.id}-${s.id}`}
                                                className="vc-fc-sticker-item"
                                                title={s.name}
                                                onClick={() => onSelectSticker(s.id, s.url)}
                                            >
                                                <img src={s.url} alt={s.name} className="vc-fc-sticker-img" />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

const PopoutIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
    </svg>
);

export function makeChannelContextMenuPatch() {
    return (children: any[], props: any) => {
        const channel = props?.channel;
        if (!channel) return;

        children.push(
            <Menu.MenuItem
                id="collapsible-sidebar-popout-chat"
                label="Open in Floating Window"
                icon={PopoutIcon}
                action={() => openFloatingChat(channel.id)}
            />
        );
    };
}

export function makeUserContextMenuPatch() {
    return (children: any[], props: any) => {
        const user = props?.user;
        if (!user || user.bot) return;

        children.push(
            <Menu.MenuItem
                id="collapsible-sidebar-popout-chat-user"
                label="Open in Floating Window"
                icon={PopoutIcon}
                action={async () => {
                    const dmChannelId = ChannelStore.getDMFromUserId(user.id);
                    if (dmChannelId) {
                        openFloatingChat(dmChannelId);
                        return;
                    }
                    if (ChannelActionCreators?.openPrivateChannel) {
                        try {
                            const res: any = await ChannelActionCreators.openPrivateChannel(user.id);
                            const channelId = typeof res === "string" ? res : res?.id;
                            if (channelId) {
                                openFloatingChat(channelId);
                            }
                        } catch {}
                    }
                }}
            />
        );
    };
}
