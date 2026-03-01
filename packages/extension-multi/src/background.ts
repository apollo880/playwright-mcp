/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { RelayConnection, debugLog } from './relayConnection';

type PageMessage = {
  type: 'connectToMCPRelay';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  tabId?: number;
  windowId?: number;
  mcpRelayUrl: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  tabId?: number;
} | {
  type: 'disconnectAll';
};

class TabShareExtension {
  private _activeConnections = new Map<number, RelayConnection>();
  private _pendingTabSelection = new Map<number, { connection: RelayConnection, timerId?: number }>();

  constructor() {
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));

    // Service Worker keepalive: Manifest V3 service workers are terminated after
    // ~30 seconds of inactivity, which would drop WebSocket connections.
    // Periodic alarms keep the worker alive while connections exist.
    chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // ~24 seconds
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === 'keepalive' && this._activeConnections.size > 0)
        debugLog('Keepalive tick, active connections:', this._activeConnections.size);
    });
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectToMCPRelay':
        this._connectToRelay(sender.tab!.id!, message.mcpRelayUrl).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getTabs':
        this._getTabs().then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        const tabId = message.tabId || sender.tab?.id!;
        const windowId = message.windowId || sender.tab?.windowId!;
        this._connectTab(sender.tab!.id!, tabId, windowId, message.mcpRelayUrl!).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connectedTabIds: [...this._activeConnections.keys()]
        });
        return false;
      case 'disconnect':
        this._disconnect(message.tabId).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'disconnectAll':
        this._disconnectAll().then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
    }
    return false;
  }

  private async _connectToRelay(selectorTabId: number, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting to relay at ${mcpRelayUrl}`);
      const socket = new WebSocket(mcpRelayUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      const connection = new RelayConnection(socket);
      connection.onclose = () => {
        debugLog('Connection closed');
        this._pendingTabSelection.delete(selectorTabId);
        // TODO: show error in the selector tab?
      };
      this._pendingTabSelection.set(selectorTabId, { connection });
      debugLog(`Connected to MCP relay`);
    } catch (error: any) {
      const message = `Failed to connect to MCP relay: ${error.message}`;
      debugLog(message);
      throw new Error(message);
    }
  }

  private async _connectTab(selectorTabId: number, tabId: number, windowId: number, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);

      // Reject duplicate connection to the same tab
      if (this._activeConnections.has(tabId))
        throw new Error(`Tab ${tabId} is already connected to another MCP client`);

      const pending = this._pendingTabSelection.get(selectorTabId);
      if (!pending)
        throw new Error('No active MCP relay connection');
      const connection = pending.connection;
      this._pendingTabSelection.delete(selectorTabId);

      connection.setTabId(tabId);
      connection.onclose = () => {
        debugLog(`MCP connection closed for tab ${tabId}`);
        this._activeConnections.delete(tabId);
        void this._clearBadge(tabId);
      };

      this._activeConnections.set(tabId, connection);
      await Promise.all([
        this._updateBadge(tabId, { text: '✓', color: '#4CAF50', title: 'Connected to MCP client' }),
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(windowId, { focused: true }),
      ]);
      debugLog(`Connected to MCP bridge (tab ${tabId}), total connections: ${this._activeConnections.size}`);
    } catch (error: any) {
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      throw error;
    }
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || '' });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  private async _clearBadge(tabId: number): Promise<void> {
    await this._updateBadge(tabId, { text: '' });
  }

  private async _onTabRemoved(tabId: number): Promise<void> {
    const pendingConnection = this._pendingTabSelection.get(tabId)?.connection;
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.close('Browser tab closed');
      return;
    }
    const connection = this._activeConnections.get(tabId);
    if (!connection)
      return;
    connection.close('Browser tab closed');
    this._activeConnections.delete(tabId);
  }

  private _onTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = undefined;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close('Tab has been inactive for 5 seconds');
            chrome.tabs.sendMessage(tabId, { type: 'connectionTimeout' });
          }
        }, 5000);
        return;
      }
    }
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
    if (this._activeConnections.has(tabId))
      void this._updateBadge(tabId, { text: '✓', color: '#4CAF50', title: 'Connected to MCP client' });
  }

  private async _getTabs(): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => {
      if (!tab.url || ['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme)))
        return false;
      // Exclude tabs that already have an active connection
      if (tab.id && this._activeConnections.has(tab.id))
        return false;
      return true;
    });
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }

  private async _disconnect(tabId?: number): Promise<void> {
    if (tabId !== undefined) {
      const connection = this._activeConnections.get(tabId);
      if (connection) {
        connection.close('User disconnected');
        this._activeConnections.delete(tabId);
        await this._clearBadge(tabId);
      }
    } else {
      await this._disconnectAll();
    }
  }

  private async _disconnectAll(): Promise<void> {
    const tabIds = [...this._activeConnections.keys()];
    for (const [tabId, connection] of this._activeConnections) {
      connection.close('User disconnected');
    }
    this._activeConnections.clear();
    await Promise.all(tabIds.map(tabId => this._clearBadge(tabId)));
  }
}

new TabShareExtension();
