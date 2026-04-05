import { ModuleRegistry } from '../core/module-registry';
import { EventBus } from '../core/event-bus';
import {
  ContentMessage,
  ContentResponse,
  StatusResponse,
} from '../types/messages';
import { ForensicLogger } from '../modules/forensic-logger';
import { PolicyEngine } from '../modules/policy-engine';
import { DlpEngine } from '../modules/dlp-engine';
import { RuleEngine } from '../modules/rule-engine';
import { DEFAULT_EDR_ENDPOINT } from '../core/constants';

export interface LogsRequest {
  type: 'get-logs';
  since?: number;
  limit?: number;
}

export interface LogsResponse {
  logs: Array<{
    id: string;
    timestamp: number;
    type: string;
    severity: string;
    source: string;
    payload: Record<string, unknown>;
  }>;
  totalCount: number;
}

/**
 * Routes messages from content scripts, popup, and options page
 * to the appropriate module or handler.
 */
export class MessageRouter {
  private registry: ModuleRegistry;
  private bus: EventBus;

  constructor(registry: ModuleRegistry, bus: EventBus) {
    this.registry = registry;
    this.bus = bus;
  }

  /**
   * Handle an incoming runtime message and return a typed response.
   * Returns undefined if the message type is not recognized.
   */
  async handleMessage(
    message: ContentMessage | { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
  ): Promise<ContentResponse | StatusResponse | LogsResponse | undefined> {
    const msgType = message.type;

    // Content script rules messages
    if (msgType.startsWith('rules:')) {
      return this.routeToRules(message, sender);
    }

    // Content script DLP messages
    if (msgType.startsWith('dlp:')) {
      return this.routeToDlp(message as ContentMessage, sender);
    }

    // Content script form messages
    if (msgType.startsWith('form:')) {
      return this.routeToForm(message as ContentMessage, sender);
    }

    // Popup: get extension status
    if (msgType === 'get-status') {
      return this.handleGetStatus();
    }

    // Options page: get forensic logs
    if (msgType === 'get-logs') {
      const logsMsg = message as unknown as LogsRequest;
      return this.handleGetLogs(logsMsg.since, logsMsg.limit);
    }

    return undefined;
  }

  /**
   * Forward rule-related content script messages to the Rule Engine.
   * The RuleEngine has its own chrome.runtime.onMessage listener,
   * but we route through here for consistency.
   */
  private async routeToRules(
    message: ContentMessage | { type: string; [key: string]: unknown },
    _sender: chrome.runtime.MessageSender,
  ): Promise<ContentResponse | undefined> {
    const ruleEngine = this.registry.getModule<RuleEngine>('rule-engine');
    if (!ruleEngine) {
      return { action: 'allow', message: 'Rule engine not available' };
    }
    // The RuleEngine handles its own messages via chrome.runtime.onMessage listener.
    // Return undefined to let the dedicated listener handle it.
    return undefined;
  }

  /**
   * Forward DLP-related content script messages to the DLP engine.
   */
  private async routeToDlp(
    message: ContentMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<ContentResponse> {
    const dlp = this.registry.getModule<DlpEngine>('dlp-engine');
    if (!dlp) {
      return { action: 'allow', message: 'DLP engine not available' };
    }

    // DLP engine handles its own messages via chrome.runtime.onMessage,
    // but we can also invoke its public scan API if needed.
    // For routed messages, we let the existing listener handle it.
    return { action: 'allow' };
  }

  /**
   * Handle form-related content script messages (password fields, submissions).
   */
  private async routeToForm(
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
  ): Promise<ContentResponse> {
    // Form events are logged via the event bus for forensic purposes.
    // No blocking action needed for form detection events.
    this.bus.publish(
      EventBus.createEvent(
        `form.${message.type.replace('form:', '')}`,
        'message-router',
        {
          url: message.tabUrl,
          ...message.data,
        },
        'info',
      ),
    );

    return { action: 'allow' };
  }

  /**
   * Build a StatusResponse with all module statuses and aggregate stats.
   */
  private async handleGetStatus(): Promise<StatusResponse> {
    const allStatus = this.registry.getAllStatus();

    const modules = allStatus.map((s) => ({
      id: s.id,
      enabled: s.enabled,
      eventCount: s.eventCount,
    }));

    const totalEvents24h = allStatus.reduce((sum, s) => sum + s.eventCount, 0);
    const openAlerts = allStatus.reduce(
      (sum, s) => sum + s.errors.length,
      0,
    );

    // Get policy version from PolicyEngine
    const policyEngine = this.registry.getModule<PolicyEngine>('policy-engine');
    const policyVersion = policyEngine?.getPolicy()?.version ?? 'unknown';

    // Check EDR agent connectivity
    const agentConnected = await this.checkAgentConnection(policyEngine);

    return {
      modules,
      totalEvents24h,
      openAlerts,
      policyVersion,
      agentConnected,
    };
  }

  /**
   * Query forensic logs and return them for the options page.
   */
  private async handleGetLogs(
    since?: number,
    limit?: number,
  ): Promise<LogsResponse> {
    const logger = this.registry.getModule<ForensicLogger>('forensic-logger');
    if (!logger) {
      return { logs: [], totalCount: 0 };
    }

    const logs = await logger.queryLogs({
      since,
      limit: limit ?? 100,
    });

    return {
      logs: logs.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        type: l.type,
        severity: l.severity,
        source: l.source,
        payload: l.payload,
      })),
      totalCount: logs.length,
    };
  }

  /**
   * Test connectivity to the EDR agent.
   */
  private async checkAgentConnection(
    policyEngine: PolicyEngine | undefined,
  ): Promise<boolean> {
    const endpoint =
      policyEngine?.getPolicy()?.edr_reporter?.endpoint ?? DEFAULT_EDR_ENDPOINT;

    try {
      const response = await fetch(`${endpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
