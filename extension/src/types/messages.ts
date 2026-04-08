// Messages from content scripts to service worker
export interface ContentMessage {
  type: ContentMessageType;
  tabUrl: string;
  data: Record<string, unknown>;
}

export type ContentMessageType =
  | 'dlp:file-input-detected'
  | 'dlp:paste-detected'
  | 'dlp:sensitive-data-found'
  | 'form:submission-detected'
  | 'form:password-field-detected'
  | 'clipboard-bridge:copy-detected';

// Response from service worker to content script
export interface ContentResponse {
  action: 'allow' | 'block' | 'warn';
  message?: string;
}

// Internal messages between service worker components
export interface StatusRequest {
  type: 'get-status';
}

export interface StatusResponse {
  modules: Array<{
    id: string;
    enabled: boolean;
    eventCount: number;
  }>;
  totalEvents24h: number;
  openAlerts: number;
  policyVersion: string;
  agentConnected: boolean;
}
