export interface RuleTrigger {
  type: 'page_load' | 'dom_mutation' | 'form_submit' | 'click' | 'interval' | 'url_change' | 'clipboard' | 'input_submit';
  selector?: string;
  ms?: number;
  direction?: 'copy' | 'paste' | 'both';
}

export interface DomCondition {
  type: 'element_exists' | 'element_absent' | 'element_count' | 'element_text_matches' | 'element_attr_matches' | 'page_text_matches';
  selector?: string;
  pattern?: string;
  attribute?: string;
  operator?: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  value?: number;
}

export interface RuleMatch {
  domains?: string[];
  url_patterns?: string[];
  url_regex?: string[];
  exclude_domains?: string[];
  trigger: RuleTrigger;
  dom_conditions?: DomCondition[];
}

export type RuleActionType =
  | 'hide_element' | 'remove_element' | 'add_overlay' | 'highlight_element'
  | 'set_attribute' | 'add_class'
  | 'block_form_submit' | 'block_click' | 'block_navigation'
  | 'log_event' | 'alert' | 'extract_data'
  | 'inject_banner' | 'inject_tooltip'
  | 'redirect' | 'close_tab' | 'notify';

export interface RuleAction {
  type: RuleActionType;
  params: Record<string, string | number | boolean>;
}

export interface PhoenixRule {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  severity: string;
  author: string;
  tags: string[];
  match: RuleMatch;
  actions: RuleAction[];
  run_once_per_page: boolean;
  cooldown_ms: number;
  priority: number;
  created_at: string;
  updated_at: string;
}
