/** 有依赖、资源锁、重试与取消语义的本地任务调度器。 */

export type TaskState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface TaskResource {
  key: string;
  mode: "read" | "write";
}

export interface ScheduledTask<T = unknown> {
  id: string;
  dependencies?: string[];
  priority?: number;
  resources?: TaskResource[];
  maxAttempts?: number;
  run(context: { signal: AbortSignal; attempt: number }): Promise<T>;
}

export interface TaskExecution<T = unknown> {
  id: string;
  state: TaskState;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  value?: T;
  error?: string;
}

export interface SchedulerEvent {
  taskId: string;
  state: TaskState;
  attempt: number;
  timestamp: string;
  error?: string;
}

export interface TaskSchedulerOptions {
  concurrency?: number;
  onEvent?: (event: SchedulerEvent) => void | Promise<void>;
}

function resourcesConflict(a: readonly TaskResource[], b: readonly TaskResource[]): boolean {
  return a.some((left) =>
    b.some((right) => left.key === right.key && (left.mode === "write" || right.mode === "write")),
  );
}

export class TaskScheduler {
  private readonly concurrency: number;
  private readonly onEvent?: TaskSchedulerOptions["onEvent"];

  constructor(options: TaskSchedulerOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    if (options.onEvent) this.onEvent = options.onEvent;
  }

  private async emit(event: SchedulerEvent): Promise<void> {
    await this.onEvent?.(event);
  }

  async run(tasks: ScheduledTask[], signal: AbortSignal = new AbortController().signal) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (byId.size !== tasks.length) throw new Error("Scheduler task ids must be unique");
    for (const task of tasks) {
      for (const dep of task.dependencies ?? []) {
        if (!byId.has(dep)) throw new Error(`Task ${task.id} depends on unknown task ${dep}`);
      }
    }

    const executions = new Map<string, TaskExecution>();
    for (const task of tasks)
      executions.set(task.id, { id: task.id, state: "pending", attempts: 0 });
    const running = new Map<string, Promise<void>>();
    const activeResources = new Map<string, TaskResource[]>();

    const settle = async (task: ScheduledTask): Promise<void> => {
      const execution = executions.get(task.id)!;
      execution.state = "running";
      execution.startedAt ??= new Date().toISOString();
      const maxAttempts = Math.max(1, Math.floor(task.maxAttempts ?? 1));
      while (execution.attempts < maxAttempts) {
        execution.attempts++;
        await this.emit({
          taskId: task.id,
          state: "running",
          attempt: execution.attempts,
          timestamp: new Date().toISOString(),
        });
        try {
          if (signal.aborted) throw new Error("cancelled");
          execution.value = await task.run({ signal, attempt: execution.attempts });
          execution.state = "succeeded";
          execution.finishedAt = new Date().toISOString();
          await this.emit({
            taskId: task.id,
            state: "succeeded",
            attempt: execution.attempts,
            timestamp: execution.finishedAt,
          });
          return;
        } catch (error) {
          execution.error = error instanceof Error ? error.message : String(error);
          if (signal.aborted) {
            execution.state = "cancelled";
            break;
          }
          if (execution.attempts >= maxAttempts) execution.state = "failed";
        }
      }
      execution.finishedAt = new Date().toISOString();
      await this.emit({
        taskId: task.id,
        state: execution.state,
        attempt: execution.attempts,
        timestamp: execution.finishedAt,
        ...(execution.error ? { error: execution.error } : {}),
      });
    };

    while (
      [...executions.values()].some((execution) => execution.state === "pending") ||
      running.size
    ) {
      if (signal.aborted) {
        for (const execution of executions.values()) {
          if (execution.state === "pending") execution.state = "cancelled";
        }
      }

      let launched = false;
      const pending = tasks
        .filter((task) => executions.get(task.id)!.state === "pending")
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

      for (const task of pending) {
        if (running.size >= this.concurrency || signal.aborted) break;
        const deps = (task.dependencies ?? []).map((id) => executions.get(id)!);
        if (
          deps.some(
            (dep) => dep.state === "failed" || dep.state === "skipped" || dep.state === "cancelled",
          )
        ) {
          const execution = executions.get(task.id)!;
          execution.state = "skipped";
          execution.error = "dependency failed";
          execution.finishedAt = new Date().toISOString();
          await this.emit({
            taskId: task.id,
            state: "skipped",
            attempt: 0,
            timestamp: execution.finishedAt,
            error: execution.error,
          });
          launched = true;
          continue;
        }
        if (!deps.every((dep) => dep.state === "succeeded")) continue;
        const resources = task.resources ?? [];
        if ([...activeResources.values()].some((held) => resourcesConflict(resources, held)))
          continue;

        activeResources.set(task.id, resources);
        const promise = settle(task).finally(() => {
          running.delete(task.id);
          activeResources.delete(task.id);
        });
        running.set(task.id, promise);
        launched = true;
      }

      if (running.size) {
        await Promise.race(running.values());
        continue;
      }
      if (
        !launched &&
        [...executions.values()].some((execution) => execution.state === "pending")
      ) {
        const blocked = [...executions.values()]
          .filter((execution) => execution.state === "pending")
          .map((execution) => execution.id);
        throw new Error(`Scheduler dependency cycle: ${blocked.join(", ")}`);
      }
    }

    return {
      ok: [...executions.values()].every(
        (execution) => execution.state === "succeeded" || execution.state === "skipped",
      ),
      tasks: Object.fromEntries(executions),
    };
  }
}
