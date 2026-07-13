import type { Component, TUI } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";

export const PROGRESS_PULSE_THRESHOLD_MS = 30_000;
export const PROGRESS_PULSE_REFRESH_MS = 1_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type PulseTimers = {
	setTimeout: (callback: () => void, delay: number) => TimerHandle;
	clearTimeout: (handle: TimerHandle) => void;
};

export function formatElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** A quiet, detachable indication that the current turn has gone silent. */
export class ProgressPulse implements Component {
	private thresholdTimer: TimerHandle | undefined;
	private refreshTimer: TimerHandle | undefined;
	private startedAt = 0;
	private lastOutputAt = 0;
	private visible = false;
	private disposed = false;

	constructor(
		private readonly ui: Pick<TUI, "requestRender">,
		private readonly getShellCount: () => number,
		private readonly now: () => number = Date.now,
		private readonly timers: PulseTimers = { setTimeout, clearTimeout },
	) {}

	start(): void {
		this.disposeTimers();
		this.disposed = false;
		this.startedAt = this.now();
		this.lastOutputAt = this.startedAt;
		this.armThreshold();
	}

	/** Reset the quiet period after any assistant/tool output. */
	recordOutput(): void {
		if (this.disposed) return;
		this.lastOutputAt = this.now();
		this.visible = false;
		this.disposeTimers();
		this.armThreshold();
		this.ui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.visible = false;
		this.disposeTimers();
		this.ui.requestRender();
	}

	isVisible(): boolean {
		return this.visible;
	}

	invalidate(): void {
		// The line is derived from the clock and is intentionally uncached.
	}

	render(_width: number): string[] {
		if (!this.visible || this.disposed) return [];
		const line = `✳ trabalhando há ${formatElapsed(this.now() - this.lastOutputAt)} · ${this.getShellCount()} shell(s) ainda rodando`;
		try {
			return [theme.fg("muted", line)];
		} catch {
			return [line];
		}
	}

	private armThreshold(): void {
		this.thresholdTimer = this.timers.setTimeout(() => {
			if (this.disposed) return;
			this.thresholdTimer = undefined;
			this.visible = true;
			this.ui.requestRender();
			this.armRefresh();
		}, PROGRESS_PULSE_THRESHOLD_MS);
		this.thresholdTimer.unref?.();
	}

	private armRefresh(): void {
		this.refreshTimer = this.timers.setTimeout(() => {
			if (this.disposed || !this.visible) return;
			this.ui.requestRender();
			this.armRefresh();
		}, PROGRESS_PULSE_REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	private disposeTimers(): void {
		if (this.thresholdTimer) this.timers.clearTimeout(this.thresholdTimer);
		if (this.refreshTimer) this.timers.clearTimeout(this.refreshTimer);
		this.thresholdTimer = undefined;
		this.refreshTimer = undefined;
	}
}

export function isShellToolName(name: unknown): boolean {
	const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
	return normalized === "bash" || normalized === "shell" || normalized === "run_shell" || normalized === "execute_bash";
}
