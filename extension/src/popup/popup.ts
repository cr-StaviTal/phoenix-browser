import { StatusResponse } from '../types/messages';

// ---- DOM references ----

const statusBadge = document.getElementById('status-badge') as HTMLSpanElement;
const eventCount = document.getElementById('event-count') as HTMLSpanElement;
const alertCount = document.getElementById('alert-count') as HTMLSpanElement;
const moduleCount = document.getElementById('module-count') as HTMLSpanElement;
const moduleList = document.getElementById('module-list') as HTMLDivElement;
const optionsLink = document.getElementById('options-link') as HTMLAnchorElement;

// ---- Refresh interval ----

let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_INTERVAL_MS = 5_000;

// ---- Functions ----

function updateUI(status: StatusResponse): void {
  // Status badge
  const activeModules = status.modules.filter((m) => m.enabled).length;
  const isActive = activeModules > 0;

  statusBadge.textContent = isActive ? 'Active' : 'Inactive';
  statusBadge.classList.toggle('active', isActive);
  statusBadge.classList.toggle('inactive', !isActive);

  // Stats
  eventCount.textContent = formatNumber(status.totalEvents24h);
  alertCount.textContent = formatNumber(status.openAlerts);
  moduleCount.textContent = `${activeModules}/${status.modules.length}`;

  // Module list
  moduleList.innerHTML = '';
  for (const mod of status.modules) {
    const row = document.createElement('div');
    row.className = 'module-row';

    const indicator = document.createElement('span');
    indicator.className = `module-indicator ${mod.enabled ? 'enabled' : 'disabled'}`;

    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = formatModuleName(mod.id);

    const events = document.createElement('span');
    events.className = 'module-events';
    events.textContent = `${mod.eventCount} events`;

    row.appendChild(indicator);
    row.appendChild(name);
    row.appendChild(events);
    moduleList.appendChild(row);
  }
}

function formatModuleName(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function showError(): void {
  statusBadge.textContent = 'Offline';
  statusBadge.classList.remove('active');
  statusBadge.classList.add('inactive');
  eventCount.textContent = '-';
  alertCount.textContent = '-';
  moduleCount.textContent = '-';
  moduleList.innerHTML =
    '<div class="module-row error">Service worker not responding</div>';
}

async function fetchStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-status' });
    if (response && typeof response === 'object' && 'modules' in response) {
      updateUI(response as StatusResponse);
    } else {
      showError();
    }
  } catch {
    showError();
  }
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', () => {
  // Fetch status immediately
  fetchStatus();

  // Refresh every 5 seconds while popup is open
  refreshTimer = setInterval(fetchStatus, REFRESH_INTERVAL_MS);

  // Options link
  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

// Clean up on popup close
window.addEventListener('unload', () => {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
