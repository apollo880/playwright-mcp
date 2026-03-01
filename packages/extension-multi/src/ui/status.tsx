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

import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, TabItem  } from './tabItem';

import type { TabInfo } from './tabItem';
import { AuthTokenSection } from './authToken';

interface ConnectionStatus {
  connectedTabs: TabInfo[];
}

const StatusApp: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>({ connectedTabs: [] });

  const loadStatus = useCallback(async () => {
    const { connectedTabIds } = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    if (connectedTabIds && connectedTabIds.length > 0) {
      const tabs: TabInfo[] = [];
      for (const tabId of connectedTabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          tabs.push({
            id: tab.id!,
            windowId: tab.windowId!,
            title: tab.title!,
            url: tab.url!,
            favIconUrl: tab.favIconUrl
          });
        } catch {
          // Tab may have been closed between status query and tab lookup
        }
      }
      setStatus({ connectedTabs: tabs });
    } else {
      setStatus({ connectedTabs: [] });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const openTab = useCallback(async (tabId: number) => {
    await chrome.tabs.update(tabId, { active: true });
  }, []);

  const disconnectTab = useCallback(async (tabId: number) => {
    await chrome.runtime.sendMessage({ type: 'disconnect', tabId });
    await loadStatus();
  }, [loadStatus]);

  const disconnectAll = useCallback(async () => {
    await chrome.runtime.sendMessage({ type: 'disconnectAll' });
    await loadStatus();
  }, [loadStatus]);

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        {status.connectedTabs.length > 0 ? (
          <div>
            <div className='tab-section-title'>
              Pages with connected MCP clients ({status.connectedTabs.length}):
            </div>
            <div>
              {status.connectedTabs.map(tab => (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  button={
                    <Button variant='primary' onClick={() => disconnectTab(tab.id)}>
                      Disconnect
                    </Button>
                  }
                  onClick={() => openTab(tab.id)}
                />
              ))}
            </div>
            {status.connectedTabs.length >= 2 && (
              <div style={{ marginTop: '12px', textAlign: 'right' }}>
                <Button variant='reject' onClick={disconnectAll}>
                  Disconnect All
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className='status-banner'>
            No MCP clients are currently connected.
          </div>
        )}
        <AuthTokenSection />
      </div>
    </div>
  );
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<StatusApp />);
}
