export interface ContextKeyRow {
  key: string;
  writers: string[];
  readers: string[];
}

export interface DiamondRoutingRow {
  diamond: string;
  covered_states: Array<Record<string, string>>;
  stuck_states: Array<Record<string, string>>;
}

export interface CycleRow {
  scc_nodes: string[];
  convergence_signal: 'iterate' | 'model_ladder' | 'fix_attempt_history' | null;
}

export interface AnalyzerOutput {
  context_keys: ContextKeyRow[];
  diamond_routing: DiamondRoutingRow[];
  cycles: CycleRow[];
}
