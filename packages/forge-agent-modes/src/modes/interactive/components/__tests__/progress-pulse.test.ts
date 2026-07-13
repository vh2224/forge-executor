import assert from "node:assert/strict";
import { test } from "node:test";
import { ProgressPulse, formatElapsed, isShellToolName, PROGRESS_PULSE_THRESHOLD_MS } from "../progress-pulse.js";

class FakeTimers {
	private nextId = 0;
	private callbacks = new Map<number, { callback: () => void; delay: number }>();
	setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
		const id = ++this.nextId;
		this.callbacks.set(id, { callback, delay });
		return id as ReturnType<typeof setTimeout>;
	};
	clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
		this.callbacks.delete(handle as unknown as number);
	};
	fire(delay: number): void {
		const entry = [...this.callbacks.entries()].find(([, timer]) => timer.delay === delay);
		if (!entry) throw new Error(`No timer for ${delay}ms`);
		this.callbacks.delete(entry[0]);
		entry[1].callback();
	}
	get size(): number { return this.callbacks.size; }
}

function makePulse(timers: FakeTimers, now: { value: number }, shells = 0) {
	let renders = 0;
	const pulse = new ProgressPulse(
		{ requestRender: () => { renders += 1; } },
		() => shells,
		() => now.value,
		timers,
	);
	return { pulse, get renders() { return renders; } };
}

test("formatElapsed uses quiet whole-second labels", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(30_999), "30s");
	assert.equal(formatElapsed(61_000), "1m 1s");
});

test("shell names are normalized without counting unrelated tools", () => {
	assert.equal(isShellToolName("bash"), true);
	assert.equal(isShellToolName(" SHELL "), true);
	assert.equal(isShellToolName("execute_bash"), true);
	assert.equal(isShellToolName("read"), false);
	assert.equal(isShellToolName(undefined), false);
});

test("pulse stays hidden until the named threshold", () => {
	const timers = new FakeTimers();
	const { pulse } = makePulse(timers, { value: 0 }, 1);
	pulse.start();
	assert.equal(pulse.isVisible(), false);
	timers.fire(PROGRESS_PULSE_THRESHOLD_MS);
	assert.equal(pulse.isVisible(), true);
	assert.match(pulse.render(100)[0] ?? "", /1 shell\(s\) ainda rodando/);
	pulse.dispose();
});

test("pulse refreshes without blocking and reflects elapsed time", () => {
	const timers = new FakeTimers();
	const now = { value: 0 };
	const result = makePulse(timers, now, 0);
	result.pulse.start();
	timers.fire(PROGRESS_PULSE_THRESHOLD_MS);
	now.value = 32_000;
	timers.fire(1_000);
	assert.match(result.pulse.render(100)[0] ?? "", /trabalhando há 32s/);
	assert.ok(result.renders >= 2);
	result.pulse.dispose();
});

test("recordOutput hides the line and restarts the quiet period", () => {
	const timers = new FakeTimers();
	const now = { value: 0 };
	const { pulse } = makePulse(timers, now, 2);
	pulse.start();
	timers.fire(PROGRESS_PULSE_THRESHOLD_MS);
	assert.equal(pulse.isVisible(), true);
	now.value = 40_000;
	pulse.recordOutput();
	assert.equal(pulse.isVisible(), false);
	assert.equal(timers.size, 1);
	timers.fire(PROGRESS_PULSE_THRESHOLD_MS);
	assert.equal(pulse.isVisible(), true);
	pulse.dispose();
});

test("dispose is idempotent and always cancels timers", () => {
	const timers = new FakeTimers();
	const { pulse } = makePulse(timers, { value: 0 });
	pulse.start();
	pulse.dispose();
	pulse.dispose();
	assert.equal(timers.size, 0);
	assert.deepEqual(pulse.render(100), []);
});
