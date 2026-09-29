/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Menu, Popout, SelectedChannelStore, useEffect, useRef, useState } from "@webpack/common";
import type { PropsWithChildren } from "react";

import { getDiscordThemeBackground, listenToThemeChanges } from "./theme";

import {
    cleanupFloatingChat,
    closeFloatingChat,
    FloatingChatPortal,
    initFloatingChatStore,
    isFloatingChatOpen,
    makeChannelContextMenuPatch,
    makeUserContextMenuPatch,
    openFloatingChat
} from "./floatingChat";
import { settings } from "./settings";

interface FloatingPosition {
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
}

interface FloatingSize {
    width?: number;
    height?: number;
    scale?: number;
}

const BASE_WIDTH = 240;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.5;

const SERVERS_COLLAPSED_KEY = "CollapsibleSidebar_serversCollapsed";
const MESSAGES_COLLAPSED_KEY = "CollapsibleSidebar_messagesCollapsed";
const BOTTOM_PANEL_COLLAPSED_KEY = "CollapsibleSidebar_bottomPanelCollapsed";
const FLOATING_POSITION_KEY = "CollapsibleSidebar_floatingPosition";
const FLOATING_SIZE_KEY = "CollapsibleSidebar_floatingSize";

const STYLE_ID = "vc-collapsible-sidebar";
const GUILDS_CLASS = "vc-collapsible-sidebar-guilds";
const CHANNELS_CLASS = "vc-collapsible-sidebar-channels";
const BOTTOM_PANEL_CLASS = "vc-collapsible-sidebar-bottom-panel";
const BOTTOM_PANEL_COLLAPSED_CLASS = "vc-collapsible-sidebar-bottom-panel-collapsed";
const BOTTOM_PANEL_FLOATING_CLASS = "vc-collapsible-sidebar-bottom-panel-floating";
const DRAGGING_CLASS = "vc-collapsible-sidebar-dragging";
const RESIZING_CLASS = "vc-collapsible-sidebar-resizing";
const DRAG_HANDLE_CLASS = "vc-collapsible-sidebar-drag-handle";
const DRAG_GRIP_CLASS = "vc-collapsible-sidebar-drag-grip";
const CORNER_HANDLE_CLASS = "vc-collapsible-sidebar-corner-handle";
const COLLAPSED_CLASS = "vc-collapsible-sidebar-collapsed";

const DEFAULT_FLOATING_POSITION: FloatingPosition = { left: 16, bottom: 16 };

let style: HTMLStyleElement | undefined;
let serversCollapsed = false;
let messagesCollapsed = false;
let bottomPanelCollapsed = false;
let isStarted = false;
let hasUserChangedState = false;
let appliedGuilds: HTMLElement | null = null;
let appliedChannels: HTMLElement | null = null;
let appliedBottomPanel: HTMLElement | null = null;
let dragHandleElement: HTMLElement | null = null;
let cornerElements: HTMLElement[] = [];
let savedFloatingPosition: FloatingPosition | null = null;
let savedFloatingSize: FloatingSize | null = null;
let isDragging = false;
let isResizing = false;
let activeDragCleanup: (() => void) | null = null;
let activeResizeCleanup: (() => void) | null = null;
let panelResizeObserver: ResizeObserver | null = null;
let themeUnsubscribe: (() => void) | null = null;

const listeners = new Set<() => void>();
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

function findWidthOwner(list: HTMLElement | null, classPattern: RegExp) {
    let current = list?.parentElement ?? null;

    while (current && current !== document.body) {
        const className = typeof current.className === "string" ? current.className : "";
        if (classPattern.test(className)) return current;
        current = current.parentElement;
    }

    return null;
}

function findBottomPanel() {
    const panels = document.querySelector<HTMLElement>('section[class*="panels_"]');
    const parent = panels?.parentElement;
    const parentClasses = typeof parent?.className === "string" ? parent.className : "";

    return parent && /(?:^|\s)sidebar_[^\s]+/.test(parentClasses)
        ? panels
        : null;
}

function findMessagesSidebar() {
    const panels = document.querySelector<HTMLElement>('section[class*="panels_"]');
    const sharedSidebar = panels?.parentElement;
    const sidebarList = [...(sharedSidebar?.children ?? [])].find(child =>
        /(?:^|\s)sidebarList_[^\s]+/.test(typeof child.className === "string" ? child.className : "")
    );

    return sidebarList instanceof HTMLElement
        ? sidebarList
        : document.querySelector<HTMLElement>('[class*="sidebarList_"]');
}

function findSidebarElements() {
    const guildList = document.querySelector<HTMLElement>('[data-list-id="guildsnav"]');
    const bottomPanel = findBottomPanel();

    return {
        guilds: findWidthOwner(guildList, /guilds/i),
        channels: findMessagesSidebar(),
        bottomPanel
    };
}

function shouldFloatBottomPanel(): boolean {
    if (bottomPanelCollapsed) return false;
    // When messages is collapsed, the panel has no message column to sit in (subgrid track is 0-1px)
    if (messagesCollapsed) return true;
    // When both sidebars are expanded, native layout accommodates it
    if (!serversCollapsed) return false;

    // When servers is collapsed but messages is visible:
    // The messages column (channels) is not animated by servers collapsing.
    // Check if it genuinely accommodates the bottom panel (~240px).
    const channels = appliedChannels ?? findMessagesSidebar();
    if (!channels) return true;

    const channelsWidth = channels.offsetWidth || channels.getBoundingClientRect().width;
    return channelsWidth > 0 && channelsWidth < 220;
}

function updateThemeStyles(panel: HTMLElement | null) {
    const themeBg = getDiscordThemeBackground();
    if (themeBg) {
        document.documentElement.style.setProperty("--vc-cs-theme-gradient", themeBg);
        if (panel) {
            panel.style.setProperty("--vc-cs-theme-gradient", themeBg);
        }
    } else {
        document.documentElement.style.removeProperty("--vc-cs-theme-gradient");
        if (panel) {
            panel.style.removeProperty("--vc-cs-theme-gradient");
        }
    }
}

function handleThemeChange() {
    updateThemeStyles(appliedBottomPanel);
}

function applyFloatingPosition(panel: HTMLElement, pos: FloatingPosition | null) {
    updateThemeStyles(panel);
    const position = pos ?? DEFAULT_FLOATING_POSITION;
    const scale = savedFloatingSize?.scale ?? (savedFloatingSize?.width ? savedFloatingSize.width / BASE_WIDTH : 1.0);
    const panelWidth = savedFloatingSize?.width ?? Math.round(BASE_WIDTH * scale);
    const panelHeight = savedFloatingSize?.height ?? (panel.offsetHeight || 60);

    panel.style.width = `${panelWidth}px`;
    if (savedFloatingSize?.height) {
        panel.style.height = `${savedFloatingSize.height}px`;
    } else {
        panel.style.height = "";
    }
    panel.style.setProperty("--vc-cs-scale", `${scale}`);

    if (position.bottom !== undefined) {
        const maxBottom = Math.max(0, window.innerHeight - panelHeight);
        const clampedBottom = Math.max(0, Math.min(maxBottom, position.bottom));
        panel.style.bottom = `${clampedBottom}px`;
        panel.style.top = "auto";
    } else if (position.top !== undefined) {
        const maxTop = Math.max(0, window.innerHeight - panelHeight);
        const clampedTop = Math.max(0, Math.min(maxTop, position.top));
        panel.style.top = `${clampedTop}px`;
        panel.style.bottom = "auto";
    }

    if (position.right !== undefined) {
        const maxRight = Math.max(0, window.innerWidth - panelWidth);
        const clampedRight = Math.max(0, Math.min(maxRight, position.right));
        panel.style.right = `${clampedRight}px`;
        panel.style.left = "auto";
    } else if (position.left !== undefined) {
        const maxLeft = Math.max(0, window.innerWidth - panelWidth);
        const clampedLeft = Math.max(0, Math.min(maxLeft, position.left));
        panel.style.left = `${clampedLeft}px`;
        panel.style.right = "auto";
    }
}

function clearFloatingStyles(panel: HTMLElement) {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.bottom = "";
    panel.style.width = "";
    panel.style.height = "";
    panel.style.removeProperty("--vc-cs-scale");
    panel.style.removeProperty("--vc-cs-theme-gradient");
}

function disconnectPanelResizeObserver() {
    if (panelResizeObserver) {
        panelResizeObserver.disconnect();
        panelResizeObserver = null;
    }
}

function observePanelResize(panel: HTMLElement) {
    if (panelResizeObserver) return;
    if (typeof ResizeObserver === "undefined") return;

    let lastHeight = panel.offsetHeight;
    panelResizeObserver = new ResizeObserver(() => {
        if (!isStarted || isDragging || isResizing || !panel.classList.contains(BOTTOM_PANEL_FLOATING_CLASS)) return;

        const currentHeight = panel.offsetHeight;
        if (currentHeight === lastHeight) return;
        lastHeight = currentHeight;

        if (!savedFloatingSize?.height) {
            applyFloatingPosition(panel, savedFloatingPosition);
        }
    });

    panelResizeObserver.observe(panel);
}

function resetFloatingPosition() {
    savedFloatingPosition = { ...DEFAULT_FLOATING_POSITION };
    savedFloatingSize = null;
    void DataStore.set(FLOATING_POSITION_KEY, savedFloatingPosition);
    void DataStore.set(FLOATING_SIZE_KEY, null);
    if (appliedBottomPanel && appliedBottomPanel.classList.contains(BOTTOM_PANEL_FLOATING_CLASS)) {
        clearFloatingStyles(appliedBottomPanel);
        applyFloatingPosition(appliedBottomPanel, savedFloatingPosition);
    }
}

function removeResizeHandles() {
    if (activeResizeCleanup) {
        activeResizeCleanup();
    }
    cornerElements.forEach(el => el.remove());
    cornerElements = [];
}

function setupResizeHandles(panel: HTMLElement) {
    if (cornerElements.length > 0 && cornerElements[0].parentElement === panel) return;

    removeResizeHandles();

    const corners: Array<{ pos: "tl" | "tr" | "bl" | "br"; title: string }> = [
        { pos: "tl", title: "Resize panel (Top-Left)" },
        { pos: "tr", title: "Resize panel (Top-Right)" },
        { pos: "bl", title: "Resize panel (Bottom-Left)" },
        { pos: "br", title: "Resize panel (Bottom-Right)" },
    ];

    cornerElements = corners.map(({ pos, title }) => {
        const handle = document.createElement("div");
        handle.className = `${CORNER_HANDLE_CLASS} vc-collapsible-sidebar-corner-${pos}`;
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("title", title);

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            const initialRect = panel.getBoundingClientRect();
            const initialWidth = initialRect.width;
            const initialHeight = initialRect.height;
            const initialScale = savedFloatingSize?.scale ?? (initialWidth / BASE_WIDTH || 1.0);
            const baseHeight = Math.max(50, initialHeight / initialScale);

            isResizing = true;
            panel.classList.add(RESIZING_CLASS);
            const prevUserSelect = document.body.style.userSelect;
            document.body.style.userSelect = "none";

            const maxAllowedScale = Math.min(
                MAX_SCALE,
                (window.innerWidth * 0.45) / BASE_WIDTH,
                (window.innerHeight * 0.45) / baseHeight
            );

            let latestScale = initialScale;
            let latestWidth = initialWidth;
            let latestHeight = initialHeight;
            let latestLeft = initialRect.left;
            let latestTop = initialRect.top;

            const onMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;

                let scaleDelta = 0;
                if (pos === "br") {
                    scaleDelta = (deltaX / BASE_WIDTH + deltaY / baseHeight) / 2;
                } else if (pos === "bl") {
                    scaleDelta = (-deltaX / BASE_WIDTH + deltaY / baseHeight) / 2;
                } else if (pos === "tr") {
                    scaleDelta = (deltaX / BASE_WIDTH - deltaY / baseHeight) / 2;
                } else if (pos === "tl") {
                    scaleDelta = (-deltaX / BASE_WIDTH - deltaY / baseHeight) / 2;
                }

                const targetScale = Math.max(MIN_SCALE, Math.min(maxAllowedScale, initialScale + scaleDelta));
                const newWidth = Math.round(BASE_WIDTH * targetScale);
                const newHeight = Math.round(baseHeight * targetScale);

                let newLeft = initialRect.left;
                let newTop = initialRect.top;

                if (pos === "br") {
                    newLeft = initialRect.left;
                    newTop = initialRect.top;
                } else if (pos === "bl") {
                    newLeft = initialRect.right - newWidth;
                    newTop = initialRect.top;
                } else if (pos === "tr") {
                    newLeft = initialRect.left;
                    newTop = initialRect.bottom - newHeight;
                } else if (pos === "tl") {
                    newLeft = initialRect.right - newWidth;
                    newTop = initialRect.bottom - newHeight;
                }

                newLeft = Math.max(16, Math.min(window.innerWidth - newWidth - 16, newLeft));
                newTop = Math.max(16, Math.min(window.innerHeight - newHeight - 16, newTop));

                latestScale = targetScale;
                latestWidth = newWidth;
                latestHeight = newHeight;
                latestLeft = newLeft;
                latestTop = newTop;

                panel.style.width = `${newWidth}px`;
                panel.style.height = `${newHeight}px`;
                panel.style.setProperty("--vc-cs-scale", `${targetScale}`);
                panel.style.left = `${newLeft}px`;
                panel.style.top = `${newTop}px`;
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            };

            const cleanup = () => {
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
                panel.classList.remove(RESIZING_CLASS);
                document.body.style.userSelect = prevUserSelect;
                isResizing = false;
                activeResizeCleanup = null;
            };

            const onMouseUp = () => {
                cleanup();

                const isLowerHalf = latestTop > (window.innerHeight - latestHeight) / 2;
                const isRightHalf = latestLeft > (window.innerWidth - latestWidth) / 2;

                const finalPosition: FloatingPosition = {};
                if (isLowerHalf) {
                    finalPosition.bottom = Math.max(0, Math.round(window.innerHeight - (latestTop + latestHeight)));
                } else {
                    finalPosition.top = Math.max(0, Math.round(latestTop));
                }

                if (isRightHalf) {
                    finalPosition.right = Math.max(0, Math.round(window.innerWidth - (latestLeft + latestWidth)));
                } else {
                    finalPosition.left = Math.max(0, Math.round(latestLeft));
                }

                const finalSize: FloatingSize = {
                    width: latestWidth,
                    height: latestHeight,
                    scale: latestScale
                };

                savedFloatingPosition = finalPosition;
                savedFloatingSize = finalSize;

                void DataStore.set(FLOATING_POSITION_KEY, finalPosition);
                void DataStore.set(FLOATING_SIZE_KEY, finalSize);

                applyFloatingPosition(panel, finalPosition);
            };

            activeResizeCleanup = cleanup;
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        };

        handle.addEventListener("mousedown", onMouseDown);
        panel.appendChild(handle);
        return handle;
    });
}

function removeDragHandle() {
    if (activeDragCleanup) {
        activeDragCleanup();
    }
    if (dragHandleElement) {
        dragHandleElement.remove();
        dragHandleElement = null;
    }
}

function setupDragHandle(panel: HTMLElement) {
    if (dragHandleElement && dragHandleElement.parentElement === panel) return;

    removeDragHandle();

    const handle = document.createElement("div");
    handle.className = DRAG_HANDLE_CLASS;
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", "Drag bottom panel");
    handle.setAttribute("title", "Drag to move panel (Double-click to reset position)");

    const grip = document.createElement("div");
    grip.className = DRAG_GRIP_CLASS;
    handle.appendChild(grip);

    handle.addEventListener("dblclick", e => {
        e.preventDefault();
        e.stopPropagation();
        resetFloatingPosition();
    });

    const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const initialRect = panel.getBoundingClientRect();

        isDragging = true;
        panel.classList.add(DRAGGING_CLASS);
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";

        let latestLeft = initialRect.left;
        let latestTop = initialRect.top;

        const onMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;

            const panelW = panel.offsetWidth;
            const panelH = panel.offsetHeight;

            const maxLeft = Math.max(0, window.innerWidth - panelW);
            const maxTop = Math.max(0, window.innerHeight - panelH);

            latestLeft = Math.max(0, Math.min(maxLeft, initialRect.left + deltaX));
            latestTop = Math.max(0, Math.min(maxTop, initialRect.top + deltaY));

            panel.style.left = `${latestLeft}px`;
            panel.style.top = `${latestTop}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        };

        const cleanup = () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            panel.classList.remove(DRAGGING_CLASS);
            document.body.style.userSelect = prevUserSelect;
            isDragging = false;
            activeDragCleanup = null;
        };

        const onMouseUp = () => {
            cleanup();

            const panelW = panel.offsetWidth;
            const panelH = panel.offsetHeight;
            const isLowerHalf = latestTop > (window.innerHeight - panelH) / 2;
            const isRightHalf = latestLeft > (window.innerWidth - panelW) / 2;

            const finalPosition: FloatingPosition = {};

            if (isLowerHalf) {
                finalPosition.bottom = Math.max(0, Math.round(window.innerHeight - (latestTop + panelH)));
            } else {
                finalPosition.top = Math.max(0, Math.round(latestTop));
            }

            if (isRightHalf) {
                finalPosition.right = Math.max(0, Math.round(window.innerWidth - (latestLeft + panelW)));
            } else {
                finalPosition.left = Math.max(0, Math.round(latestLeft));
            }

            savedFloatingPosition = finalPosition;
            void DataStore.set(FLOATING_POSITION_KEY, finalPosition);
            applyFloatingPosition(panel, finalPosition);
        };

        activeDragCleanup = cleanup;
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    };

    handle.addEventListener("mousedown", onMouseDown);
    panel.prepend(handle);
    dragHandleElement = handle;
}

function handleWindowResize() {
    if (!isStarted || !appliedBottomPanel) return;
    if (appliedBottomPanel.classList.contains(BOTTOM_PANEL_FLOATING_CLASS)) {
        applyFloatingPosition(appliedBottomPanel, savedFloatingPosition);
    }
}

function handleTransitionEnd(e: Event) {
    if (!isStarted) return;
    if (e instanceof TransitionEvent && (e.propertyName === "width" || e.propertyName === "min-width")) {
        applySidebarState();
    }
}

function applySidebarState() {
    if (!isStarted) return;

    const { guilds, channels, bottomPanel } = findSidebarElements();
    if (appliedGuilds && appliedGuilds !== guilds) {
        appliedGuilds.removeEventListener("transitionend", handleTransitionEnd);
        appliedGuilds.classList.remove(GUILDS_CLASS, COLLAPSED_CLASS);
    }
    if (appliedChannels && appliedChannels !== channels) {
        appliedChannels.removeEventListener("transitionend", handleTransitionEnd);
        appliedChannels.classList.remove(CHANNELS_CLASS, COLLAPSED_CLASS);
    }
    if (appliedBottomPanel && appliedBottomPanel !== bottomPanel) {
        disconnectPanelResizeObserver();
        appliedBottomPanel.classList.remove(
            BOTTOM_PANEL_CLASS,
            BOTTOM_PANEL_COLLAPSED_CLASS,
            BOTTOM_PANEL_FLOATING_CLASS,
            DRAGGING_CLASS,
            RESIZING_CLASS,
            COLLAPSED_CLASS
        );
        clearFloatingStyles(appliedBottomPanel);
        removeDragHandle();
        removeResizeHandles();
    }

    if (guilds && guilds !== appliedGuilds) {
        guilds.addEventListener("transitionend", handleTransitionEnd);
    }
    if (channels && channels !== appliedChannels) {
        channels.addEventListener("transitionend", handleTransitionEnd);
    }

    appliedGuilds = guilds;
    appliedChannels = channels;
    appliedBottomPanel = bottomPanel;

    guilds?.classList.add(GUILDS_CLASS);
    channels?.classList.add(CHANNELS_CLASS);
    bottomPanel?.classList.add(BOTTOM_PANEL_CLASS);

    guilds?.classList.toggle(COLLAPSED_CLASS, serversCollapsed);
    channels?.classList.toggle(COLLAPSED_CLASS, messagesCollapsed);

    if (bottomPanel) {
        bottomPanel.classList.remove(COLLAPSED_CLASS);
        bottomPanel.classList.toggle(BOTTOM_PANEL_COLLAPSED_CLASS, bottomPanelCollapsed);

        const isFloating = shouldFloatBottomPanel();
        bottomPanel.classList.toggle(BOTTOM_PANEL_FLOATING_CLASS, isFloating);

        if (isFloating) {
            setupDragHandle(bottomPanel);
            setupResizeHandles(bottomPanel);
            applyFloatingPosition(bottomPanel, savedFloatingPosition);
            observePanelResize(bottomPanel);
        } else {
            disconnectPanelResizeObserver();
            removeDragHandle();
            removeResizeHandles();
            clearFloatingStyles(bottomPanel);
        }
    }
}

function notifyStateChange() {
    listeners.forEach(listener => listener());
}

function subscribeToState(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function persistState() {
    void DataStore.set(SERVERS_COLLAPSED_KEY, serversCollapsed);
    void DataStore.set(MESSAGES_COLLAPSED_KEY, messagesCollapsed);
    void DataStore.set(BOTTOM_PANEL_COLLAPSED_KEY, bottomPanelCollapsed);
}

function setSidebarState(nextServersCollapsed: boolean, nextMessagesCollapsed: boolean, nextBottomPanelCollapsed: boolean) {
    hasUserChangedState = true;
    serversCollapsed = nextServersCollapsed;
    messagesCollapsed = nextMessagesCollapsed;
    bottomPanelCollapsed = nextBottomPanelCollapsed;
    applySidebarState();
    persistState();
    notifyStateChange();
}

function closeAll() {
    setSidebarState(true, true, true);
}

function openAll() {
    setSidebarState(false, false, false);
}

function toggleServers() {
    setSidebarState(!serversCollapsed, messagesCollapsed, bottomPanelCollapsed);
}

function toggleMessages() {
    setSidebarState(serversCollapsed, !messagesCollapsed, bottomPanelCollapsed);
}

function toggleBottomPanel() {
    setSidebarState(serversCollapsed, messagesCollapsed, !bottomPanelCollapsed);
}

async function restorePersistedState() {
    const [storedServersCollapsed, storedMessagesCollapsed, storedBottomPanelCollapsed, storedFloatingPosition, storedFloatingSize] = await Promise.all([
        DataStore.get<boolean>(SERVERS_COLLAPSED_KEY),
        DataStore.get<boolean>(MESSAGES_COLLAPSED_KEY),
        DataStore.get<boolean>(BOTTOM_PANEL_COLLAPSED_KEY),
        DataStore.get<FloatingPosition>(FLOATING_POSITION_KEY),
        DataStore.get<FloatingSize>(FLOATING_SIZE_KEY)
    ]);

    if (!isStarted || hasUserChangedState) return;
    if (storedServersCollapsed !== undefined) serversCollapsed = storedServersCollapsed;
    if (storedMessagesCollapsed !== undefined) messagesCollapsed = storedMessagesCollapsed;
    if (storedBottomPanelCollapsed !== undefined) bottomPanelCollapsed = storedBottomPanelCollapsed;
    if (storedFloatingPosition) savedFloatingPosition = storedFloatingPosition;
    if (storedFloatingSize) savedFloatingSize = storedFloatingSize;
    applySidebarState();
    notifyStateChange();
}

function SidebarIcon() {
    return (
        <svg className="vc-collapsible-sidebar-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M4 4.5A1.5 1.5 0 0 1 5.5 3h13A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-15ZM6 5v14h3V5H6Zm5 0v14h6V5h-6Z" />
            <path fill="currentColor" d="M13 9l3 3-3 3" />
        </svg>
    );
}

function SidebarControlsMenu({ onClose }: { onClose: () => void; }) {
    const allCollapsed = serversCollapsed && messagesCollapsed && bottomPanelCollapsed;

    return (
        <Menu.Menu
            navId="collapsible-sidebar-controls"
            onClose={onClose}
            aria-label="Sidebar controls"
        >
            <Menu.MenuItem
                id="collapsible-sidebar-all"
                label={allCollapsed ? "Open Everything" : "Close All"}
                action={() => {
                    if (allCollapsed) {
                        openAll();
                    } else {
                        closeAll();
                    }
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-servers"
                label={serversCollapsed ? "Open Servers" : "Close Servers"}
                action={() => {
                    toggleServers();
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-messages"
                label={messagesCollapsed ? "Open Messages" : "Close Messages"}
                action={() => {
                    toggleMessages();
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-bottom-panel"
                label={bottomPanelCollapsed ? "Open Bottom Panel" : "Close Bottom Panel"}
                action={() => {
                    toggleBottomPanel();
                    onClose();
                }}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="collapsible-sidebar-popout-current-chat"
                label="Pop Out Current Chat"
                action={() => {
                    const currentId = SelectedChannelStore?.getChannelId?.();
                    if (currentId) {
                        openFloatingChat(currentId);
                    }
                    onClose();
                }}
            />
            {isFloatingChatOpen() && (
                <Menu.MenuItem
                    id="collapsible-sidebar-close-floating-chat"
                    label="Close All Floating Chats"
                    action={() => {
                        closeFloatingChat();
                        onClose();
                    }}
                />
            )}
            <Menu.MenuItem
                id="collapsible-sidebar-reset-position"
                label="Reset Floating Position"
                action={() => {
                    resetFloatingPosition();
                    onClose();
                }}
            />
        </Menu.Menu>
    );
}

function SidebarToggleButton() {
    const [, setRevision] = useState(0);
    const buttonRef = useRef(null);
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        const unsubscribe = subscribeToState(() => setRevision(revision => revision + 1));
        return () => {
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        applySidebarState();
    }, []);

    return (
        <Popout
            position="bottom"
            align="left"
            animation={Popout.Animation.NONE}
            shouldShow={menuOpen}
            onRequestClose={() => setMenuOpen(false)}
            targetElementRef={buttonRef}
            renderPopout={() => <SidebarControlsMenu onClose={() => setMenuOpen(false)} />}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className="vc-collapsible-sidebar-toggle"
                    onClick={() => setMenuOpen(open => !open)}
                    tooltip={isShown ? null : "Sidebar controls"}
                    icon={() => <SidebarIcon />}
                />
            )}
        </Popout>
    );
}

function TrailingWrapper({ children }: PropsWithChildren) {
    return (
        <>
            {children}
            <SidebarToggleButton />
            <FloatingChatPortal />
        </>
    );
}

export default definePlugin({
    name: "CollapsibleSidebar",
    description: "Adds a collapsible sidebar to Discord.",
    authors: [{
        name: "Kathleen",
        id: 0n
    }],
    settings,

    start() {
        isStarted = true;
        window.addEventListener("resize", handleWindowResize);
        style = createAndAppendStyle(STYLE_ID, managedStyleRootNode);
        style.textContent = `
            .vc-collapsible-sidebar-guilds,
            .vc-collapsible-sidebar-channels {
                overflow: hidden;
                transition: width 220ms ease, min-width 220ms ease, max-width 220ms ease, flex-basis 220ms ease, padding 220ms ease, margin 220ms ease;
            }

            .vc-collapsible-sidebar-guilds.vc-collapsible-sidebar-collapsed,
            .vc-collapsible-sidebar-channels.vc-collapsible-sidebar-collapsed {
                width: 0 !important;
                min-width: 0 !important;
                max-width: 0 !important;
                flex: 0 0 0 !important;
                flex-basis: 0 !important;
                padding: 0 !important;
                margin: 0 !important;
            }

            .vc-collapsible-sidebar-bottom-panel.vc-collapsible-sidebar-bottom-panel-collapsed {
                display: none !important;
            }

            .vc-collapsible-sidebar-bottom-panel.vc-collapsible-sidebar-bottom-panel-floating {
                position: fixed !important;
                min-width: 190px !important;
                max-width: min(420px, calc(100vw - 32px)) !important;
                min-height: 48px !important;
                max-height: min(350px, calc(100vh - 32px)) !important;
                z-index: 1000 !important;
                box-sizing: border-box !important;
                border-radius: 8px !important;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1) !important;
                background: var(--vc-cs-theme-gradient, var(--background-floating, var(--bg-base-tertiary, var(--background-secondary, #1e1f22)))) !important;
                backdrop-filter: blur(16px);
                overflow: hidden !important;
                transition: none !important;
            }

            .vc-collapsible-sidebar-bottom-panel-floating > div:not(.vc-collapsible-sidebar-drag-handle):not(.vc-collapsible-sidebar-corner-handle) {
                zoom: var(--vc-cs-scale, 1);
            }

            .vc-collapsible-sidebar-bottom-panel.vc-collapsible-sidebar-bottom-panel-floating.vc-collapsible-sidebar-resizing {
                user-select: none !important;
            }

            .vc-collapsible-sidebar-corner-handle {
                position: absolute;
                width: 16px;
                height: 16px;
                z-index: 1002;
                touch-action: none;
                box-sizing: border-box;
            }

            .vc-collapsible-sidebar-corner-tl {
                top: 0;
                left: 0;
                cursor: nwse-resize !important;
            }

            .vc-collapsible-sidebar-corner-tr {
                top: 0;
                right: 0;
                cursor: nesw-resize !important;
            }

            .vc-collapsible-sidebar-corner-bl {
                bottom: 0;
                left: 0;
                cursor: nesw-resize !important;
            }

            .vc-collapsible-sidebar-corner-br {
                bottom: 0;
                right: 0;
                cursor: nwse-resize !important;
            }

            .vc-collapsible-sidebar-corner-br::after {
                content: "";
                position: absolute;
                right: 4px;
                bottom: 4px;
                width: 6px;
                height: 6px;
                border-right: 2px solid var(--interactive-muted, #80848e);
                border-bottom: 2px solid var(--interactive-muted, #80848e);
                border-bottom-right-radius: 2px;
                opacity: 0.5;
                transition: opacity 150ms ease, border-color 150ms ease;
                pointer-events: none;
            }

            .vc-collapsible-sidebar-bottom-panel-floating:hover .vc-collapsible-sidebar-corner-br::after {
                opacity: 0.9;
                border-color: var(--interactive-active, #ffffff);
            }

            .vc-collapsible-sidebar-drag-handle {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 14px;
                width: 100%;
                cursor: grab;
                background: rgba(0, 0, 0, 0.25);
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
                border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
                user-select: none;
                touch-action: none;
                flex-shrink: 0;
            }

            .vc-collapsible-sidebar-drag-handle:hover {
                background: rgba(0, 0, 0, 0.38);
            }

            .vc-collapsible-sidebar-drag-grip {
                width: 32px;
                height: 4px;
                border-radius: 2px;
                background: var(--interactive-muted, rgba(255, 255, 255, 0.4));
                transition: background 150ms ease, width 150ms ease;
            }

            .vc-collapsible-sidebar-drag-handle:hover .vc-collapsible-sidebar-drag-grip {
                background: var(--interactive-active, #ffffff);
                width: 40px;
            }

            .vc-collapsible-sidebar-bottom-panel-floating.vc-collapsible-sidebar-dragging .vc-collapsible-sidebar-drag-handle {
                cursor: grabbing !important;
                background: rgba(0, 0, 0, 0.45) !important;
            }

            .vc-collapsible-sidebar-bottom-panel-floating.vc-collapsible-sidebar-dragging .vc-collapsible-sidebar-drag-grip {
                background: var(--interactive-active, #ffffff) !important;
                width: 48px;
            }

            @media (prefers-reduced-motion: reduce) {
                .vc-collapsible-sidebar-guilds,
                .vc-collapsible-sidebar-channels {
                    transition-duration: 0.01ms;
                }
            }

            .vc-collapsible-sidebar-toggle {
                margin-left: 6px;
            }

            .vc-collapsible-sidebar-icon {
                width: 20px;
                height: 20px;
            }

            /* Floating Chat Window */
            .vc-floating-chat-window {
                position: fixed;
                z-index: 1001;
                box-sizing: border-box;
                border-radius: 12px;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.1);
                background: var(--vc-cs-theme-gradient, var(--background-floating, var(--bg-base-tertiary, var(--background-secondary, #1e1f22)))) !important;
                backdrop-filter: blur(20px);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                transition: none !important;
            }

            .vc-floating-chat-window.vc-fc-detached {
                position: static !important;
                width: 100vw !important;
                height: 100vh !important;
                border-radius: 0 !important;
                box-shadow: none !important;
            }

            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-header {
                -webkit-app-region: drag !important;
                cursor: grab !important;
            }

            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-header:active {
                cursor: grabbing !important;
            }

            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-header button,
            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-header a,
            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-header input,
            .vc-floating-chat-window.vc-fc-detached .vc-fc-header-actions,
            .vc-floating-chat-window.vc-fc-detached .vc-fc-action-btn {
                -webkit-app-region: no-drag !important;
                cursor: pointer !important;
            }

            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-messages,
            .vc-floating-chat-window.vc-fc-detached .vc-floating-chat-composer,
            .vc-floating-chat-window.vc-fc-detached .vc-fc-composer-container,
            .vc-floating-chat-window.vc-fc-detached .vc-fc-textarea,
            .vc-floating-chat-window.vc-fc-detached .vc-fc-popover {
                -webkit-app-region: no-drag !important;
            }

            .vc-floating-chat-window.vc-fc-resizing {
                user-select: none !important;
            }

            .vc-floating-chat-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                height: calc(38px * var(--vc-fc-scale, 1));
                min-height: 32px;
                padding: 0 calc(12px * var(--vc-fc-scale, 1));
                background: rgba(0, 0, 0, 0.3);
                border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
                cursor: grab;
                user-select: none;
                flex-shrink: 0;
            }

            .vc-floating-chat-window.vc-fc-dragging .vc-floating-chat-header {
                cursor: grabbing !important;
                background: rgba(0, 0, 0, 0.45) !important;
            }

            .vc-fc-header-info {
                display: flex;
                align-items: center;
                gap: calc(8px * var(--vc-fc-scale, 1));
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                font-weight: 600;
                color: var(--header-primary, #ffffff);
                font-size: calc(14px * var(--vc-fc-scale, 1));
            }

            .vc-fc-avatar {
                width: calc(20px * var(--vc-fc-scale, 1));
                height: calc(20px * var(--vc-fc-scale, 1));
                border-radius: 50%;
                object-fit: cover;
                flex-shrink: 0;
            }

            .vc-fc-hash-icon {
                color: var(--interactive-muted, #80848e);
                font-size: calc(16px * var(--vc-fc-scale, 1));
                font-weight: bold;
                flex-shrink: 0;
            }

            .vc-fc-title {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .vc-fc-header-actions {
                display: flex;
                align-items: center;
                gap: 4px;
                flex-shrink: 0;
            }

            .vc-fc-action-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: calc(26px * var(--vc-fc-scale, 1));
                height: calc(26px * var(--vc-fc-scale, 1));
                border: none;
                border-radius: 4px;
                background: transparent;
                color: var(--interactive-normal, #b5bac1);
                cursor: pointer;
                transition: background 150ms ease, color 150ms ease;
            }

            .vc-fc-action-btn svg {
                width: calc(16px * var(--vc-fc-scale, 1));
                height: calc(16px * var(--vc-fc-scale, 1));
            }

            .vc-fc-action-btn:hover {
                background: var(--background-modifier-hover, rgba(255, 255, 255, 0.08));
                color: var(--interactive-hover, #ffffff);
            }

            .vc-fc-action-btn.vc-fc-pin-active {
                color: var(--brand-experiment, #5865f2) !important;
                background: rgba(88, 101, 242, 0.2) !important;
            }

            .vc-fc-close-btn:hover {
                background: var(--button-danger-background, #da373c) !important;
                color: #ffffff !important;
            }

            /* Messages */
            .vc-floating-chat-messages {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                overflow-x: hidden;
                padding: calc(10px * var(--vc-fc-scale, 1)) calc(8px * var(--vc-fc-scale, 1));
                display: flex;
                flex-direction: column;
                gap: calc(8px * var(--vc-fc-scale, 1));
            }

            .vc-fc-empty-state {
                margin: auto;
                text-align: center;
                padding: calc(24px * var(--vc-fc-scale, 1)) calc(16px * var(--vc-fc-scale, 1));
            }

            .vc-fc-empty-icon {
                font-size: calc(36px * var(--vc-fc-scale, 1));
                font-weight: bold;
                color: var(--interactive-muted, #80848e);
                margin-bottom: 8px;
            }

            .vc-fc-empty-title {
                font-size: calc(16px * var(--vc-fc-scale, 1));
                font-weight: 700;
                color: var(--header-primary, #ffffff);
                margin-bottom: 4px;
            }

            .vc-fc-empty-subtitle {
                font-size: calc(13px * var(--vc-fc-scale, 1));
                color: var(--text-muted, #949ba4);
            }

            .vc-fc-msg-item {
                display: flex;
                align-items: flex-start;
                gap: calc(10px * var(--vc-fc-scale, 1));
                padding: calc(3px * var(--vc-fc-scale, 1)) calc(6px * var(--vc-fc-scale, 1));
                border-radius: 6px;
                transition: background 120ms ease;
            }

            .vc-fc-msg-item:hover {
                background: rgba(255, 255, 255, 0.04);
            }

            .vc-fc-msg-avatar-col {
                flex-shrink: 0;
            }

            .vc-fc-msg-avatar {
                width: calc(32px * var(--vc-fc-scale, 1));
                height: calc(32px * var(--vc-fc-scale, 1));
                border-radius: 50%;
                object-fit: cover;
                display: block;
            }

            .vc-fc-msg-avatar-placeholder {
                width: calc(32px * var(--vc-fc-scale, 1));
                height: calc(32px * var(--vc-fc-scale, 1));
                border-radius: 50%;
                background: var(--brand-experiment, #5865f2);
                color: #ffffff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 600;
                font-size: calc(14px * var(--vc-fc-scale, 1));
            }

            .vc-fc-msg-content-col {
                flex: 1 1 auto;
                min-width: 0;
            }

            .vc-fc-msg-meta {
                display: flex;
                align-items: baseline;
                gap: calc(6px * var(--vc-fc-scale, 1));
                margin-bottom: 2px;
            }

            .vc-fc-msg-author {
                font-weight: 600;
                font-size: calc(13px * var(--vc-fc-scale, 1));
                color: var(--header-primary, #ffffff);
            }

            .vc-fc-msg-bot-tag {
                background: var(--brand-experiment, #5865f2);
                color: #ffffff;
                font-size: calc(9px * var(--vc-fc-scale, 1));
                font-weight: 700;
                padding: 1px 4px;
                border-radius: 3px;
                line-height: 1;
                text-transform: uppercase;
            }

            .vc-fc-msg-timestamp {
                font-size: calc(11px * var(--vc-fc-scale, 1));
                color: var(--text-muted, #949ba4);
            }

            .vc-fc-msg-body {
                font-size: calc(13.5px * var(--vc-fc-scale, 1));
                line-height: 1.375;
                color: var(--text-normal, #dbdee1);
                white-space: pre-wrap;
                word-break: break-word;
            }

            .vc-fc-msg-attachments {
                margin-top: calc(6px * var(--vc-fc-scale, 1));
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .vc-fc-msg-attachment-img {
                max-width: 100%;
                max-height: calc(200px * var(--vc-fc-scale, 1));
                border-radius: 6px;
                object-fit: contain;
                border: 1px solid rgba(255, 255, 255, 0.08);
            }

            .vc-fc-msg-attachment-file {
                font-size: calc(12px * var(--vc-fc-scale, 1));
                color: var(--text-link, #00a8fc);
                text-decoration: none;
            }

            .vc-fc-msg-attachment-file:hover {
                text-decoration: underline;
            }

            /* Composer */
            .vc-floating-chat-input-wrapper {
                position: relative;
                flex-shrink: 0;
                padding: calc(8px * var(--vc-fc-scale, 1));
                background: rgba(0, 0, 0, 0.22);
                border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
            }

            .vc-fc-composer-container {
                display: flex;
                align-items: center;
                gap: calc(6px * var(--vc-fc-scale, 1));
                background: var(--input-background-default, rgba(0, 0, 0, 0.3));
                border-radius: calc(8px * var(--vc-fc-scale, 1));
                padding: calc(4px * var(--vc-fc-scale, 1)) calc(8px * var(--vc-fc-scale, 1));
                border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
                box-sizing: border-box;
            }

            .vc-fc-composer-textarea {
                flex: 1 1 auto;
                background: transparent;
                border: none;
                outline: none;
                color: var(--text-normal, #dbdee1);
                font-size: calc(13.5px * var(--vc-fc-scale, 1));
                font-family: inherit;
                line-height: 1.35;
                padding: calc(4px * var(--vc-fc-scale, 1)) 0;
                resize: none;
                min-height: calc(20px * var(--vc-fc-scale, 1));
                max-height: calc(100px * var(--vc-fc-scale, 1));
                overflow-y: auto;
                box-sizing: border-box;
            }

            .vc-fc-composer-textarea::placeholder {
                color: var(--text-muted, #949ba4);
            }

            .vc-fc-composer-actions {
                display: flex;
                align-items: center;
                gap: calc(2px * var(--vc-fc-scale, 1));
                flex-shrink: 0;
            }

            .vc-fc-composer-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: calc(28px * var(--vc-fc-scale, 1));
                height: calc(28px * var(--vc-fc-scale, 1));
                border: none;
                border-radius: 4px;
                background: transparent;
                color: var(--interactive-normal, #b5bac1);
                cursor: pointer;
                transition: color 150ms ease, background 150ms ease;
                padding: 0;
            }

            .vc-fc-composer-btn:hover {
                color: var(--interactive-hover, #ffffff);
                background: rgba(255, 255, 255, 0.08);
            }

            .vc-fc-composer-btn.vc-fc-btn-active {
                color: var(--brand-experiment, #5865f2) !important;
                background: rgba(88, 101, 242, 0.2) !important;
            }

            .vc-fc-btn-label {
                font-size: calc(11px * var(--vc-fc-scale, 1));
                font-weight: 700;
                letter-spacing: 0.5px;
            }

            .vc-fc-composer-btn svg {
                width: calc(18px * var(--vc-fc-scale, 1));
                height: calc(18px * var(--vc-fc-scale, 1));
            }

            .vc-fc-send-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: calc(28px * var(--vc-fc-scale, 1));
                height: calc(28px * var(--vc-fc-scale, 1));
                border: none;
                border-radius: 4px;
                background: transparent;
                color: var(--interactive-muted, #80848e);
                cursor: pointer;
                transition: all 150ms ease;
                padding: 0;
            }

            .vc-fc-send-btn svg {
                width: calc(16px * var(--vc-fc-scale, 1));
                height: calc(16px * var(--vc-fc-scale, 1));
            }

            .vc-fc-send-active {
                color: var(--brand-experiment, #5865f2) !important;
            }

            .vc-fc-send-active:hover {
                background: rgba(88, 101, 242, 0.15) !important;
                color: #ffffff !important;
            }

            .vc-fc-pending-attachments {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                padding: 4px 6px;
                margin-bottom: 4px;
            }

            .vc-fc-attachment-chip {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 4px;
                padding: 3px 8px;
                font-size: calc(11.5px * var(--vc-fc-scale, 1));
                color: var(--text-normal, #dbdee1);
                max-width: 220px;
                box-sizing: border-box;
            }

            .vc-fc-attachment-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .vc-fc-attachment-remove {
                background: none;
                border: none;
                color: var(--interactive-muted, #80848e);
                cursor: pointer;
                padding: 0 2px;
                font-size: 11px;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: color 100ms ease;
            }

            .vc-fc-attachment-remove:hover {
                color: var(--status-danger, #f23f43);
            }

            .vc-fc-uploading-tag {
                font-size: calc(11.5px * var(--vc-fc-scale, 1));
                color: var(--brand-experiment, #5865f2);
                font-weight: 600;
                padding: 3px 6px;
                display: inline-flex;
                align-items: center;
            }

            @keyframes vc-fc-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }

            .vc-fc-spinner {
                animation: vc-fc-spin 1s linear infinite;
            }

            /* Popovers: Emoji, GIF, Sticker */
            .vc-fc-popover {
                position: absolute;
                bottom: calc(100% + 6px);
                left: 6px;
                right: 6px;
                height: 330px;
                background: var(--background-floating, #2b2d31);
                border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
                border-radius: 10px;
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
                z-index: 1010;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                backdrop-filter: blur(20px);
            }

            .vc-fc-popover-header {
                display: flex;
                align-items: center;
                padding: 8px 10px;
                gap: 8px;
                border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
                background: rgba(0, 0, 0, 0.25);
                flex-shrink: 0;
            }

            .vc-fc-popover-search {
                flex: 1 1 auto;
                background: var(--input-background-default, rgba(0, 0, 0, 0.35));
                border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
                border-radius: 6px;
                color: var(--text-normal, #dbdee1);
                padding: 6px 10px;
                font-size: 13px;
                outline: none;
                transition: border-color 120ms ease;
            }

            .vc-fc-popover-search:focus {
                border-color: var(--brand-experiment, #5865f2);
            }

            .vc-fc-popover-title {
                flex: 1 1 auto;
                font-size: 13px;
                font-weight: 600;
                color: var(--header-primary, #ffffff);
            }

            .vc-fc-popover-close {
                background: transparent;
                border: none;
                color: var(--interactive-normal, #b5bac1);
                cursor: pointer;
                font-size: 14px;
                padding: 2px 6px;
                border-radius: 4px;
                transition: background 120ms ease, color 120ms ease;
            }

            .vc-fc-popover-close:hover {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.1);
            }

            /* Layout with Left Navigation Rail */
            .vc-fc-popover-layout {
                display: flex;
                flex: 1 1 auto;
                overflow: hidden;
                min-height: 0;
            }

            .vc-fc-popover-nav {
                width: 44px;
                flex-shrink: 0;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 6px;
                padding: 8px 0;
                background: rgba(0, 0, 0, 0.22);
                border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
                overflow-y: auto;
                overflow-x: hidden;
            }

            .vc-fc-nav-btn {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                border: none;
                background: rgba(255, 255, 255, 0.05);
                color: var(--interactive-normal, #b5bac1);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 120ms ease;
                font-size: 15px;
                padding: 0;
                flex-shrink: 0;
                user-select: none;
            }

            .vc-fc-nav-btn:hover {
                background: var(--background-modifier-hover, rgba(255, 255, 255, 0.15));
                border-radius: 35%;
                color: #ffffff;
            }

            .vc-fc-nav-btn.vc-fc-nav-btn-active {
                background: var(--brand-experiment, #5865f2);
                border-radius: 35%;
                color: #ffffff;
                box-shadow: 0 2px 8px rgba(88, 101, 242, 0.4);
            }

            .vc-fc-nav-guild-icon {
                width: 32px;
                height: 32px;
                border-radius: inherit;
                object-fit: cover;
                pointer-events: none;
            }

            .vc-fc-nav-guild-initials {
                width: 32px;
                height: 32px;
                border-radius: inherit;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                font-weight: 700;
                color: #ffffff;
                background: rgba(255, 255, 255, 0.1);
                pointer-events: none;
            }

            .vc-fc-nav-divider {
                width: 24px;
                height: 1px;
                background: rgba(255, 255, 255, 0.1);
                margin: 2px 0;
                flex-shrink: 0;
            }

            .vc-fc-popover-content {
                flex: 1 1 auto;
                overflow-y: auto;
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                scroll-behavior: smooth;
                min-height: 0;
            }

            .vc-fc-popover-body {
                flex: 1 1 auto;
                overflow-y: auto;
                padding: 8px;
                min-height: 0;
            }

            .vc-fc-section {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .vc-fc-section-header {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: var(--text-muted, #949ba4);
                margin-bottom: 2px;
                padding-left: 2px;
            }

            /* Emoji Grid */
            .vc-fc-emoji-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(32px, 1fr));
                gap: 4px;
            }

            .vc-fc-emoji-item {
                background: transparent;
                border: none;
                border-radius: 4px;
                font-size: 20px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: background 100ms ease, transform 100ms ease;
                user-select: none;
                padding: 0;
            }

            .vc-fc-emoji-item:hover {
                background: var(--background-modifier-hover, rgba(255, 255, 255, 0.1));
                transform: scale(1.15);
            }

            .vc-fc-custom-emoji-img {
                width: 26px;
                height: 26px;
                object-fit: contain;
                pointer-events: none;
            }

            /* GIF tabs & Grid */
            .vc-fc-gif-tabs {
                display: flex;
                gap: 6px;
                padding: 6px 10px;
                overflow-x: auto;
                background: rgba(0, 0, 0, 0.15);
                border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
                flex-shrink: 0;
            }

            .vc-fc-gif-tab-btn {
                background: rgba(255, 255, 255, 0.08);
                border: none;
                border-radius: 14px;
                color: var(--text-normal, #dbdee1);
                font-size: 11px;
                font-weight: 500;
                padding: 4px 10px;
                cursor: pointer;
                white-space: nowrap;
                transition: background 120ms ease, color 120ms ease;
                flex-shrink: 0;
            }

            .vc-fc-gif-tab-btn:hover {
                background: rgba(255, 255, 255, 0.16);
                color: #ffffff;
            }

            .vc-fc-gif-tab-btn.vc-fc-gif-tab-active {
                background: var(--brand-experiment, #5865f2);
                color: #ffffff;
            }

            .vc-fc-gif-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 6px;
            }

            .vc-fc-gif-item {
                width: 100%;
                height: 90px;
                object-fit: cover;
                border-radius: 6px;
                cursor: pointer;
                transition: transform 120ms ease, box-shadow 120ms ease;
            }

            .vc-fc-gif-item:hover {
                transform: scale(1.03);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            }

            /* Sticker Grid */
            .vc-fc-sticker-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
                gap: 8px;
            }

            .vc-fc-sticker-item {
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 6px;
                padding: 6px;
                cursor: pointer;
                background: rgba(255, 255, 255, 0.03);
                transition: background 120ms ease, transform 120ms ease;
            }

            .vc-fc-sticker-item:hover {
                background: var(--background-modifier-hover, rgba(255, 255, 255, 0.1));
                transform: scale(1.08);
            }

            .vc-fc-sticker-img {
                width: 64px;
                height: 64px;
                object-fit: contain;
            }

            .vc-fc-loading,
            .vc-fc-empty {
                text-align: center;
                padding: 24px 12px;
                font-size: 12px;
                color: var(--text-muted, #949ba4);
            }

            /* Floating Chat Corner handles */
            .vc-fc-corner-handle {
                position: absolute;
                width: 16px;
                height: 16px;
                z-index: 1002;
                touch-action: none;
                box-sizing: border-box;
            }

            .vc-fc-corner-tl {
                top: 0;
                left: 0;
                cursor: nwse-resize !important;
            }

            .vc-fc-corner-tr {
                top: 0;
                right: 0;
                cursor: nesw-resize !important;
            }

            .vc-fc-corner-bl {
                bottom: 0;
                left: 0;
                cursor: nesw-resize !important;
            }

            .vc-fc-corner-br {
                bottom: 0;
                right: 0;
                cursor: nwse-resize !important;
            }

            .vc-fc-corner-br::after {
                content: "";
                position: absolute;
                right: 4px;
                bottom: 4px;
                width: 6px;
                height: 6px;
                border-right: 2px solid var(--interactive-muted, #80848e);
                border-bottom: 2px solid var(--interactive-muted, #80848e);
                border-bottom-right-radius: 2px;
                opacity: 0.5;
                transition: opacity 150ms ease, border-color 150ms ease;
                pointer-events: none;
            }

            .vc-floating-chat-window:hover .vc-fc-corner-br::after {
                opacity: 0.9;
                border-color: var(--interactive-active, #ffffff);
            }
        `;
        themeUnsubscribe = listenToThemeChanges(handleThemeChange);
        updateThemeStyles(appliedBottomPanel);
        void initFloatingChatStore();
        applySidebarState();
        void restorePersistedState();
    },

    stop() {
        isStarted = false;
        cleanupFloatingChat();
        window.removeEventListener("resize", handleWindowResize);
        if (themeUnsubscribe) {
            themeUnsubscribe();
            themeUnsubscribe = null;
        }
        if (appliedGuilds) {
            appliedGuilds.removeEventListener("transitionend", handleTransitionEnd);
            appliedGuilds.classList.remove(GUILDS_CLASS, COLLAPSED_CLASS);
        }
        if (appliedChannels) {
            appliedChannels.removeEventListener("transitionend", handleTransitionEnd);
            appliedChannels.classList.remove(CHANNELS_CLASS, COLLAPSED_CLASS);
        }
        document.querySelectorAll<HTMLElement>(`.${GUILDS_CLASS}, .${CHANNELS_CLASS}`).forEach(element => {
            element.classList.remove(GUILDS_CLASS, CHANNELS_CLASS, COLLAPSED_CLASS);
        });
        disconnectPanelResizeObserver();
        removeDragHandle();
        removeResizeHandles();
        document.querySelectorAll<HTMLElement>(`.${BOTTOM_PANEL_CLASS}`).forEach(element => {
            element.classList.remove(
                BOTTOM_PANEL_CLASS,
                BOTTOM_PANEL_COLLAPSED_CLASS,
                BOTTOM_PANEL_FLOATING_CLASS,
                DRAGGING_CLASS,
                RESIZING_CLASS,
                COLLAPSED_CLASS
            );
            clearFloatingStyles(element);
        });
        appliedGuilds = null;
        appliedChannels = null;
        appliedBottomPanel = null;
        dragHandleElement = null;
        savedFloatingPosition = null;
        savedFloatingSize = null;
        serversCollapsed = false;
        messagesCollapsed = false;
        bottomPanelCollapsed = false;
        hasUserChangedState = false;
        listeners.clear();
        style?.remove();
        style = undefined;
    },

    contextMenus: {
        "channel-context": makeChannelContextMenuPatch(),
        "thread-context": makeChannelContextMenuPatch(),
        "gdm-context": makeChannelContextMenuPatch(),
        "user-context": makeUserContextMenuPatch()
    },

    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,50}?)\i\.Fragment,(?=\{children:\[)/,
                replace: "$1$self.TrailingWrapper,"
            }
        }
    ],

    TrailingWrapper
});
