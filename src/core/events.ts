import { EventEmitter } from "events";
import type { Task, AgentType } from "../types/index.js";

/**
 * Orchestra event types
 */
export type OrchestraEventType =
  | "task:completed"
  | "task:failed"
  | "cycle:started"
  | "cycle:ended"
  | "planner:wakeup"
  | "session:paused"
  | "session:resumed";

/**
 * Event payloads
 */
export interface TaskCompletedEvent {
  task: Task;
  agent: AgentType;
  durationMs: number;
}

export interface TaskFailedEvent {
  task: Task;
  agent: AgentType;
  error: string;
}

export interface CycleEvent {
  cycle: number;
  maxCycles: number;
}

export interface PlannerWakeupEvent {
  reason: "task_completed" | "threshold_reached" | "manual";
  completedCount: number;
  pendingCount: number;
}

/**
 * Orchestra Event Bus
 * Enables communication between components
 */
class OrchestraEventBus extends EventEmitter {
  private static instance: OrchestraEventBus;

  private constructor() {
    super();
    this.setMaxListeners(50); // Allow many listeners
  }

  static getInstance(): OrchestraEventBus {
    if (!OrchestraEventBus.instance) {
      OrchestraEventBus.instance = new OrchestraEventBus();
    }
    return OrchestraEventBus.instance;
  }

  /**
   * Emit task completed event
   */
  emitTaskCompleted(event: TaskCompletedEvent): void {
    this.emit("task:completed", event);
  }

  /**
   * Emit task failed event
   */
  emitTaskFailed(event: TaskFailedEvent): void {
    this.emit("task:failed", event);
  }

  /**
   * Emit cycle started event
   */
  emitCycleStarted(event: CycleEvent): void {
    this.emit("cycle:started", event);
  }

  /**
   * Emit cycle ended event
   */
  emitCycleEnded(event: CycleEvent): void {
    this.emit("cycle:ended", event);
  }

  /**
   * Emit planner wakeup event
   */
  emitPlannerWakeup(event: PlannerWakeupEvent): void {
    this.emit("planner:wakeup", event);
  }

  /**
   * Subscribe to task completed events
   */
  onTaskCompleted(handler: (event: TaskCompletedEvent) => void): void {
    this.on("task:completed", handler);
  }

  /**
   * Subscribe to task failed events
   */
  onTaskFailed(handler: (event: TaskFailedEvent) => void): void {
    this.on("task:failed", handler);
  }

  /**
   * Subscribe to planner wakeup events
   */
  onPlannerWakeup(handler: (event: PlannerWakeupEvent) => void): void {
    this.on("planner:wakeup", handler);
  }

  /**
   * Remove all listeners (for cleanup)
   */
  reset(): void {
    this.removeAllListeners();
  }
}

/**
 * Global event bus instance
 */
export const eventBus = OrchestraEventBus.getInstance();

/**
 * Planner wake-up controller
 * Monitors task completions and triggers planner when needed
 */
export class PlannerWakeupController {
  private completedSinceLastWakeup: number = 0;
  private wakeupThreshold: number;
  private enabled: boolean = true;

  constructor(wakeupThreshold: number = 3) {
    this.wakeupThreshold = wakeupThreshold;
    this.setupListeners();
  }

  private setupListeners(): void {
    eventBus.onTaskCompleted(() => {
      if (!this.enabled) return;

      this.completedSinceLastWakeup++;

      // Check if threshold reached
      if (this.completedSinceLastWakeup >= this.wakeupThreshold) {
        this.triggerWakeup("threshold_reached");
      }
    });
  }

  /**
   * Trigger planner wakeup
   */
  triggerWakeup(reason: PlannerWakeupEvent["reason"]): void {
    eventBus.emitPlannerWakeup({
      reason,
      completedCount: this.completedSinceLastWakeup,
      pendingCount: 0, // Would need to be passed in
    });

    // Reset counter
    this.completedSinceLastWakeup = 0;
  }

  /**
   * Enable/disable wake-up
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Set threshold
   */
  setThreshold(threshold: number): void {
    this.wakeupThreshold = threshold;
  }

  /**
   * Reset counter
   */
  reset(): void {
    this.completedSinceLastWakeup = 0;
  }
}

/**
 * Create a planner wake-up controller
 */
export function createWakeupController(threshold?: number): PlannerWakeupController {
  return new PlannerWakeupController(threshold);
}
