import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Text } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { ToolPhaseSummaryComponent } from "../components/tool-execution.js";
import { ProgressPulse, PROGRESS_PULSE_THRESHOLD_MS } from "../components/progress-pulse.js";
import {
  isPersistentPauseBanner,
  renderExtensionNotifyInChat,
} from "../interactive-notify-render.js";
import { buildAssistantReplaySegments } from "../interactive-notify-render.js";
import stripAnsi from "strip-ansi";

initTheme("dark", false);

type Timer = { callback: () => void; delay: number; cleared: boolean };

class FakeClock {
  now = 0;
  timers: Timer[] = [];
  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const timer = { callback, delay, cleared: false };
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    (handle as unknown as Timer).cleared = true;
  };
  advance(ms: number): void {
    this.now += ms;
    for (const timer of [...this.timers]) {
      if (!timer.cleared && timer.delay <= ms) {
        timer.cleared = true;
        timer.callback();
      }
    }
  }
}

function transcript(container: Container): string {
  return container.render(100).map(stripAnsi).join("\n");
}

function addCard(container: Container, message: string, type: "info" | "success" | "error" | "warning"): void {
  const result = renderExtensionNotifyInChat(container, message, type);
  assert.equal(result.rendered, true, `${type} card should be rendered`);
}

test("S07 transcript composes loop boundaries, prose, phase rollup, pulse, and final result", () => {
  const chat = new Container();
  const clock = new FakeClock();
  let renders = 0;
  const pulse = new ProgressPulse(
    { requestRender: () => { renders += 1; } },
    () => 2,
    () => clock.now,
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );

  addCard(chat, "▶ S01/T01 · execute-task · claude-fable-5", "info");
  chat.addChild(new Text("O worker encontrou o arquivo e vai validar os dois caminhos.", 1, 0));
  chat.addChild(new ToolPhaseSummaryComponent([
    { label: "Read", count: 2, durationMs: 1200, targets: ["loop.ts", "chat.ts"] },
  ]));
  pulse.start();
  chat.addChild(pulse);
  clock.advance(PROGRESS_PULSE_THRESHOLD_MS);
  addCard(chat, "✓ S01/T01 · done · 1234ms", "success");

  const rendered = transcript(chat);
  const dispatch = rendered.indexOf("▶ S01/T01");
  const prose = rendered.indexOf("O worker encontrou");
  const rollup = rendered.indexOf("Read");
  const pulseIndex = rendered.indexOf("trabalhando há");
  const result = rendered.indexOf("✓ S01/T01");
  assert.ok(dispatch >= 0, "dispatch boundary is visible");
  assert.ok(prose > dispatch, "worker prose follows dispatch");
  assert.ok(rollup > prose, "tool phase summary follows prose");
  assert.ok(pulseIndex > rollup, "long-turn pulse is visible after activity");
  assert.ok(result > pulseIndex, "result boundary closes the turn");
  assert.match(rendered, /2 shell\(s\) ainda rodando/);
  assert.ok(renders > 0, "pulse requested a render at the quiet-turn threshold");

  pulse.dispose();
  assert.equal(pulse.render(100).length, 0, "completed turn removes the pulse");
});

test("pause is the only warning promoted to persistent transcript state", () => {
  const chat = new Container();
  const pause = "⏸ PAUSADO (credencial indisponível) — retome com /forge auto";
  addCard(chat, pause, "warning");
  const warning = renderExtensionNotifyInChat(chat, "advisory warning", "warning");
  assert.equal(warning.rendered, false, "advisory warnings retain their old non-transcript behavior");
  assert.equal(isPersistentPauseBanner(pause), true);
  assert.equal(isPersistentPauseBanner("⏸ PAUSADO sem estrutura"), false);
  const rendered = transcript(chat);
  assert.match(rendered, /PAUSADO/);
  assert.doesNotMatch(rendered, /advisory warning/);
});

test("errors stay expanded and replay keeps prose/tool boundaries", () => {
  const chat = new Container();
  addCard(chat, "tool failed: permission denied", "error");
  const rendered = transcript(chat);
  assert.match(rendered, /Error: tool failed: permission denied/);

  const segments = buildAssistantReplaySegments([
    { type: "text", text: "antes" },
    { type: "toolCall", id: "a", name: "read", arguments: {} },
    { type: "text", text: "depois" },
  ]);
  assert.deepEqual(segments, [
    { kind: "assistant", startIndex: 0, endIndex: 0 },
    { kind: "tool", contentIndex: 1 },
    { kind: "assistant", startIndex: 2, endIndex: 2 },
  ]);
});

test("headless-style containers remain structured and do not mount an interactive pulse", () => {
  const headless = new Container();
  addCard(headless, "▶ S01/T01 · execute-task · model", "info");
  addCard(headless, "✓ S01/T01 · done · 0ms", "success");
  const rendered = transcript(headless);
  assert.match(rendered, /▶ S01\/T01/);
  assert.match(rendered, /✓ S01\/T01/);
  assert.doesNotMatch(rendered, /trabalhando há/);
});
