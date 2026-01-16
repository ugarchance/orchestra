// Orchestra Type Definitions
// Based on PLAN-v3.md

// =============================================================================
// AGENT TYPES
// =============================================================================

export type AgentType = "claude" | "codex" | "opencode";

export type AgentStatus =
  | "available"      // Ready to use
  | "busy"           // Currently executing task
  | "rate_limited"   // Hit limit, in cooldown
  | "errored"        // Error, waiting retry
  | "exhausted"      // Daily limit reached
  | "disabled";      // Manually disabled

export interface AgentStats {
  tasks_completed: number;
  tasks_failed: number;
  total_errors: number;
  last_error: ErrorCategory | null;
  last_error_at: string | null;
}

export interface AgentHealth {
  consecutive_failures: number;
  success_rate: number;
  avg_task_duration_ms: number;
}

export interface AgentState {
  status: AgentStatus;
  available_at: string | null;
  cooldown_minutes: number;
  stats: AgentStats;
  health: AgentHealth;
}

export interface AgentPoolConfig {
  selection_strategy: "round_robin_healthy" | "health_score" | "priority";
  fallback_order: AgentType[];
  min_available_agents: number;
  max_consecutive_failures: number;
  cooldown_multiplier: number;
}

export interface AgentPool {
  agents: Record<AgentType, AgentState>;
  pool_config: AgentPoolConfig;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

export type ErrorCategory =
  | "rate_limit"       // API limit exceeded
  | "timeout"          // Task timeout
  | "crash"            // CLI crash
  | "invalid_output"   // JSON parse failed
  | "git_conflict"     // Git conflict unresolved
  | "permission"       // Permission denied
  | "network"          // Network error
  | "unknown";         // Unknown error

export interface ErrorInfo {
  category: ErrorCategory;
  message: string;
  occurred_at: string;
  agent: AgentType;
  output_snippet: string;
}

export interface ErrorHandler {
  category: ErrorCategory;
  retry: boolean;
  cooldown_minutes: number;
  max_retries: number;
  fallback_to_other_agent: boolean;
  action: "retry" | "reassign" | "fail" | "pause";
}

// =============================================================================
// TASK TYPES
// =============================================================================

export type TaskStatus =
  | "pending"        // Waiting to be picked up
  | "in_progress"    // Currently running
  | "completed"      // Finished successfully
  | "failed"         // Failed after max retries
  | "waiting_agent"; // All agents busy/limited

export type AttemptResult = "completed" | "failed" | "timeout" | "rate_limited";

export interface AgentAttempt {
  agent: AgentType;
  started_at: string;
  ended_at: string;
  result: AttemptResult;
  error?: ErrorInfo;
}

export interface Task {
  // Identity
  id: string;
  title: string;
  description: string;

  // Status
  status: TaskStatus;

  // Assignment
  assigned_agent: AgentType | null;
  worker_id: string | null;

  // Files
  files: string[];

  // Metadata
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;

  // Retry & Error tracking
  attempts: number;
  max_attempts: number;
  last_error: ErrorInfo | null;
  agent_history: AgentAttempt[];
}

// =============================================================================
// SYSTEM STATE TYPES
// =============================================================================

export type SystemStatus =
  | "running"           // Normal operation
  | "paused_manual"     // User paused
  | "paused_no_agents"  // All agents exhausted
  | "paused_error"      // Critical error
  | "completed"         // Goal achieved
  | "aborted";          // Manual abort or max fail

export interface PauseInfo {
  paused_at: string;
  reason: string;
  resume_at: string | null;
  auto_resume: boolean;
}

export interface Checkpoint {
  last_completed_task: string | null;
  pending_tasks: string[];
  in_progress_tasks: string[];
  cycle_started_at: string;
}

export interface SessionStats {
  tasks_created: number;
  tasks_completed: number;
  tasks_failed: number;
  tasks_pending: number;
}

export interface OrchestraState {
  // Session identity
  goal: string;
  session_id: string;
  project_path: string;

  // Status
  status: SystemStatus;
  pause_info: PauseInfo | null;

  // Progress
  current_cycle: number;
  max_cycles: number;
  branch: string;

  // Checkpoint for resume
  checkpoint: Checkpoint;

  // Stats
  stats: SessionStats;

  // Timestamps
  started_at: string;
  updated_at: string;
}

// =============================================================================
// CONFIG TYPES
// =============================================================================

export interface AgentConfig {
  enabled: boolean;
  command: string;
  subcommand?: string;
  flags: string[];
  roles: ("planner" | "worker" | "judge")[];
  priority: number;
  requires_config?: boolean;
}

export interface ResilienceConfig {
  min_agents_required: number;
  max_task_attempts: number;
  max_consecutive_agent_failures: number;
  auto_resume_on_cooldown: boolean;
  rate_limit_cooldowns: Record<AgentType, number>;
}

export interface CycleConfig {
  max: number;
  timeout_minutes: number;
}

export interface GitConfig {
  auto_commit: boolean;
  auto_push: boolean;
  branch_prefix: string;
}

export interface WorkerConfig {
  max_count: number;
}

export interface OrchestraConfig {
  workers: WorkerConfig;
  agents: Record<AgentType, AgentConfig>;
  resilience: ResilienceConfig;
  cycle: CycleConfig;
  git: GitConfig;
}

// =============================================================================
// SELECTION TYPES
// =============================================================================

export type SelectionResult =
  | { type: "selected"; agent: AgentType }
  | { type: "wait"; until: Date; reason: string }
  | { type: "pause"; reason: string };

// =============================================================================
// CLI TYPES
// =============================================================================

export interface StartOptions {
  goal: string;
  projectPath: string;
  maxCycles?: number;
  maxWorkers?: number;
}

export interface StatusInfo {
  session: OrchestraState;
  agents: AgentPool;
  tasks: Task[];
}
