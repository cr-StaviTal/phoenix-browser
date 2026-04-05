import { StatusResponse } from '../types/messages';
import { DEFAULT_EDR_ENDPOINT, POLICY_STORAGE_KEY } from '../core/constants';

// ---- Settings shape persisted in chrome.storage.local ----

interface PhoenixSettings {
  agentUrl: string;
  disabledModules: string[];
}

const SETTINGS_KEY = 'phoenix_settings';

// ---- DOM references ----

const agentUrlInput = document.getElementById('agent-url') as HTMLInputElement;
const connectionStatus = document.getElementById('connection-status') as HTMLSpanElement;
const moduleToggles = document.getElementById('module-toggles') as HTMLDivElement;
const policyVersion = document.getElementById('policy-version') as HTMLSpanElement;
const policySync = document.getElementById('policy-sync') as HTMLSpanElement;
const syncPolicyBtn = document.getElementById('sync-policy') as HTMLButtonElement;
const logCount = document.getElementById('log-count') as HTMLSpanElement;
const exportLogsBtn = document.getElementById('export-logs') as HTMLButtonElement;
const clearLogsBtn = document.getElementById('clear-logs') as HTMLButtonElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const saveStatus = document.getElementById('save-status') as HTMLSpanElement;

// ---- State ----

let currentSettings: PhoenixSettings = {
  agentUrl: DEFAULT_EDR_ENDPOINT,
  disabledModules: [],
};

let moduleStatuses: StatusResponse['modules'] = [];

// ---- Load ----

async function loadSettings(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      currentSettings = result[SETTINGS_KEY] as PhoenixSettings;
    }
    agentUrlInput.value = currentSettings.agentUrl;
  } catch {
    // Use defaults
  }
}

async function loadStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-status' });
    if (response && typeof response === 'object' && 'modules' in response) {
      const status = response as StatusResponse;
      moduleStatuses = status.modules;
      policyVersion.textContent = status.policyVersion;
      renderModuleToggles();
    }
  } catch {
    // Service worker not available
  }
}

async function loadPolicyInfo(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(POLICY_STORAGE_KEY);
    const policy = result[POLICY_STORAGE_KEY] as
      | { version?: string; updated_at?: string }
      | undefined;

    if (policy) {
      policyVersion.textContent = policy.version ?? '-';
      policySync.textContent = policy.updated_at
        ? new Date(policy.updated_at).toLocaleString()
        : '-';
    }
  } catch {
    // Ignore
  }
}

async function loadLogCount(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'get-logs',
      limit: 0,
    });
    if (response && typeof response === 'object' && 'totalCount' in response) {
      logCount.textContent = String(
        (response as { totalCount: number }).totalCount,
      );
    }
  } catch {
    logCount.textContent = '-';
  }
}

// ---- Render ----

function renderModuleToggles(): void {
  moduleToggles.innerHTML = '';

  for (const mod of moduleStatuses) {
    const row = document.createElement('div');
    row.className = 'toggle-row';

    const label = document.createElement('label');
    label.className = 'toggle-label';
    label.textContent = formatModuleName(mod.id);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle-input';
    toggle.checked = !currentSettings.disabledModules.includes(mod.id);
    toggle.dataset.moduleId = mod.id;

    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        currentSettings.disabledModules = currentSettings.disabledModules.filter(
          (id) => id !== mod.id,
        );
      } else {
        if (!currentSettings.disabledModules.includes(mod.id)) {
          currentSettings.disabledModules.push(mod.id);
        }
      }
    });

    const info = document.createElement('span');
    info.className = 'toggle-info';
    info.textContent = `${mod.eventCount} events`;

    row.appendChild(label);
    row.appendChild(info);
    row.appendChild(toggle);
    moduleToggles.appendChild(row);
  }
}

function formatModuleName(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---- Connection test ----

async function testConnection(): Promise<void> {
  const url = agentUrlInput.value.trim() || DEFAULT_EDR_ENDPOINT;
  connectionStatus.textContent = 'Checking...';
  connectionStatus.className = 'status';

  try {
    const response = await fetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });

    if (response.ok) {
      connectionStatus.textContent = 'Connected';
      connectionStatus.className = 'status connected';
    } else {
      connectionStatus.textContent = `Error: HTTP ${response.status}`;
      connectionStatus.className = 'status error';
    }
  } catch {
    connectionStatus.textContent = 'Unreachable';
    connectionStatus.className = 'status error';
  }
}

// ---- Actions ----

async function saveSettings(): Promise<void> {
  currentSettings.agentUrl = agentUrlInput.value.trim() || DEFAULT_EDR_ENDPOINT;

  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings });
    saveStatus.textContent = 'Saved';
    saveStatus.className = 'save-ok';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 2_000);
  } catch {
    saveStatus.textContent = 'Failed to save';
    saveStatus.className = 'save-error';
  }
}

async function syncPolicy(): Promise<void> {
  syncPolicyBtn.disabled = true;
  syncPolicyBtn.textContent = 'Syncing...';

  try {
    const url = currentSettings.agentUrl || DEFAULT_EDR_ENDPOINT;
    const response = await fetch(`${url}/policy`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const policy = await response.json();
    await chrome.storage.local.set({ [POLICY_STORAGE_KEY]: policy });

    policyVersion.textContent = policy.version ?? '-';
    policySync.textContent = new Date().toLocaleString();
    syncPolicyBtn.textContent = 'Synced!';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    syncPolicyBtn.textContent = `Failed: ${msg}`;
  } finally {
    setTimeout(() => {
      syncPolicyBtn.disabled = false;
      syncPolicyBtn.textContent = 'Sync Policy Now';
    }, 3_000);
  }
}

async function exportLogs(): Promise<void> {
  exportLogsBtn.disabled = true;
  exportLogsBtn.textContent = 'Exporting...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'get-logs',
      limit: 10_000,
    });

    if (!response || typeof response !== 'object' || !('logs' in response)) {
      throw new Error('Invalid response from service worker');
    }

    const logs = (response as { logs: unknown[] }).logs;
    const blob = new Blob([JSON.stringify(logs, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `phoenix-forensic-logs-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportLogsBtn.textContent = 'Exported!';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    exportLogsBtn.textContent = `Failed: ${msg}`;
  } finally {
    setTimeout(() => {
      exportLogsBtn.disabled = false;
      exportLogsBtn.textContent = 'Export Logs';
    }, 2_000);
  }
}

async function clearLogs(): Promise<void> {
  const confirmed = confirm(
    'Are you sure you want to clear all forensic logs? This cannot be undone.',
  );
  if (!confirmed) return;

  clearLogsBtn.disabled = true;
  clearLogsBtn.textContent = 'Clearing...';

  try {
    // Delete the IndexedDB database to clear all logs
    const deleteRequest = indexedDB.deleteDatabase('phoenix_forensic_logs');

    await new Promise<void>((resolve, reject) => {
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => resolve(); // proceed even if blocked
    });

    logCount.textContent = '0';
    clearLogsBtn.textContent = 'Cleared!';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clearLogsBtn.textContent = `Failed: ${msg}`;
  } finally {
    setTimeout(() => {
      clearLogsBtn.disabled = false;
      clearLogsBtn.textContent = 'Clear Logs';
    }, 2_000);
  }
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await Promise.all([loadStatus(), loadPolicyInfo(), loadLogCount()]);
  testConnection();

  // Event listeners
  saveBtn.addEventListener('click', saveSettings);
  syncPolicyBtn.addEventListener('click', syncPolicy);
  exportLogsBtn.addEventListener('click', exportLogs);
  clearLogsBtn.addEventListener('click', clearLogs);

  // Test connection when URL changes
  agentUrlInput.addEventListener('blur', testConnection);
});
