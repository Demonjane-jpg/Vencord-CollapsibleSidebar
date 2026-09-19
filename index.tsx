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
import { Menu, Popout, useEffect, useRef, useState } from "@webpack/common";
import type { PropsWithChildren } from "react";

interface FloatingPosition {
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
}

const SERVERS_COLLAPSED_KEY = "CollapsibleSidebar_serversCollapsed";
const MESSAGES_COLLAPSED_KEY = "CollapsibleSidebar_messagesCollapsed";
const BOTTOM_PANEL_COLLAPSED_KEY = "CollapsibleSidebar_bottomPanelCollapsed";
const FLOATING_POSITION_KEY = "CollapsibleSidebar_floatingPosition";

const STYLE_ID = "vc-collapsible-sidebar";
const GUILDS_CLASS = "vc-collapsible-sidebar-guilds";
const CHANNELS_CLASS = "vc-collapsible-sidebar-channels";
const BOTTOM_PANEL_CLASS = "vc-collapsible-sidebar-bottom-panel";
const BOTTOM_PANEL_COLLAPSED_CLASS = "vc-collapsible-sidebar-bottom-panel-collapsed";
const BOTTOM_PANEL_FLOATING_CLASS = "vc-collapsible-sidebar-bottom-panel-floating";
const DRAGGING_CLASS = "vc-collapsible-sidebar-dragging";
const DRAG_HANDLE_CLASS = "vc-collapsible-sidebar-drag-handle";
const DRAG_GRIP_CLASS = "vc-collapsible-sidebar-drag-grip";
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
let savedFloatingPosition: FloatingPosition | null = null;
let isDragging = false;
let activeDragCleanup: (() => void) | null = null;
let panelResizeObserver: ResizeObserver | null = null;

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

function applyFloatingPosition(panel: HTMLElement, pos: FloatingPosition | null) {
    const position = pos ?? DEFAULT_FLOATING_POSITION;
    const panelWidth = 240;
    const panelHeight = panel.offsetHeight || 60;

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
        if (!isStarted || isDragging || !panel.classList.contains(BOTTOM_PANEL_FLOATING_CLASS)) return;

        const currentHeight = panel.offsetHeight;
        if (currentHeight === lastHeight) return;
        lastHeight = currentHeight;

        applyFloatingPosition(panel, savedFloatingPosition);
    });

    panelResizeObserver.observe(panel);
}

function resetFloatingPosition() {
    savedFloatingPosition = { ...DEFAULT_FLOATING_POSITION };
    void DataStore.set(FLOATING_POSITION_KEY, savedFloatingPosition);
    if (appliedBottomPanel && appliedBottomPanel.classList.contains(BOTTOM_PANEL_FLOATING_CLASS)) {
        applyFloatingPosition(appliedBottomPanel, savedFloatingPosition);
    }
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
            COLLAPSED_CLASS
        );
        clearFloatingStyles(appliedBottomPanel);
        removeDragHandle();
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
            applyFloatingPosition(bottomPanel, savedFloatingPosition);
            observePanelResize(bottomPanel);
        } else {
            disconnectPanelResizeObserver();
            removeDragHandle();
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

function collapseEverything() {
    setSidebarState(true, true, true);
}

function expandEverything() {
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
    const [storedServersCollapsed, storedMessagesCollapsed, storedBottomPanelCollapsed, storedFloatingPosition] = await Promise.all([
        DataStore.get<boolean>(SERVERS_COLLAPSED_KEY),
        DataStore.get<boolean>(MESSAGES_COLLAPSED_KEY),
        DataStore.get<boolean>(BOTTOM_PANEL_COLLAPSED_KEY),
        DataStore.get<FloatingPosition>(FLOATING_POSITION_KEY)
    ]);

    if (!isStarted || hasUserChangedState) return;
    if (storedServersCollapsed !== undefined) serversCollapsed = storedServersCollapsed;
    if (storedMessagesCollapsed !== undefined) messagesCollapsed = storedMessagesCollapsed;
    if (storedBottomPanelCollapsed !== undefined) bottomPanelCollapsed = storedBottomPanelCollapsed;
    if (storedFloatingPosition) savedFloatingPosition = storedFloatingPosition;
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
    return (
        <Menu.Menu
            navId="collapsible-sidebar-controls"
            onClose={onClose}
            aria-label="Sidebar controls"
        >
            <Menu.MenuItem
                id="collapsible-sidebar-collapse-everything"
                label="Collapse Everything"
                action={() => {
                    collapseEverything();
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-expand-everything"
                label="Expand Everything"
                action={() => {
                    expandEverything();
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-servers"
                label={serversCollapsed ? "Expand Servers" : "Collapse Servers"}
                action={() => {
                    toggleServers();
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-messages"
                label={messagesCollapsed ? "Expand Messages" : "Collapse Messages"}
                action={() => {
                    toggleMessages();
                    onClose();
                }}
            />
            <Menu.MenuItem
                id="collapsible-sidebar-bottom-panel"
                label={bottomPanelCollapsed ? "Expand Bottom Panel" : "Collapse Bottom Panel"}
                action={() => {
                    toggleBottomPanel();
                    onClose();
                }}
            />
            <Menu.MenuSeparator />
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
                width: 240px !important;
                min-width: 240px !important;
                max-width: calc(100vw - 32px) !important;
                max-height: calc(100vh - 32px) !important;
                z-index: 1000 !important;
                box-sizing: border-box !important;
                border-radius: 8px !important;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08) !important;
                background: var(--bg-overlay-3, var(--background-secondary, #2f3136)) !important;
                overflow: hidden !important;
                transition: none !important;
            }

            .vc-collapsible-sidebar-drag-handle {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 14px;
                width: 100%;
                cursor: grab;
                background: var(--background-secondary-alt, #1e1f22);
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
                border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
                user-select: none;
                touch-action: none;
                flex-shrink: 0;
            }

            .vc-collapsible-sidebar-drag-handle:hover {
                background: var(--background-modifier-hover, #2b2d31);
            }

            .vc-collapsible-sidebar-drag-grip {
                width: 32px;
                height: 4px;
                border-radius: 2px;
                background: var(--interactive-muted, #80848e);
                transition: background 150ms ease, width 150ms ease;
            }

            .vc-collapsible-sidebar-drag-handle:hover .vc-collapsible-sidebar-drag-grip {
                background: var(--interactive-active, #ffffff);
                width: 40px;
            }

            .vc-collapsible-sidebar-bottom-panel-floating.vc-collapsible-sidebar-dragging .vc-collapsible-sidebar-drag-handle {
                cursor: grabbing !important;
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
        `;
        applySidebarState();
        void restorePersistedState();
    },

    stop() {
        isStarted = false;
        window.removeEventListener("resize", handleWindowResize);
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
        document.querySelectorAll<HTMLElement>(`.${BOTTOM_PANEL_CLASS}`).forEach(element => {
            element.classList.remove(
                BOTTOM_PANEL_CLASS,
                BOTTOM_PANEL_COLLAPSED_CLASS,
                BOTTOM_PANEL_FLOATING_CLASS,
                DRAGGING_CLASS,
                COLLAPSED_CLASS
            );
            clearFloatingStyles(element);
        });
        appliedGuilds = null;
        appliedChannels = null;
        appliedBottomPanel = null;
        dragHandleElement = null;
        savedFloatingPosition = null;
        serversCollapsed = false;
        messagesCollapsed = false;
        bottomPanelCollapsed = false;
        hasUserChangedState = false;
        listeners.clear();
        style?.remove();
        style = undefined;
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
