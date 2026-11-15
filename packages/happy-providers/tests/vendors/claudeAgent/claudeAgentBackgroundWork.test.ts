import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

/**
 * Claude Code's own stream as the Agent SDK delivers it, measured on SDK 0.3.321 with Claude Code
 * 2.1.321: `system/background_tasks_changed` lists every live background task whenever that set
 * changes — a background command and a subagent join it while the turn that started them runs,
 * and leave it as they finish, after that turn's result.
 */
const sdk = vi.hoisted(() => {
    const state = { finish: (): void => undefined };
    const shell = {
        task_id: "bv74hfa93",
        task_type: "local_bash",
        description: "Sleep 25 seconds then echo shell-done",
    };
    const subagent = {
        task_id: "a6d24fa32a569f3ce",
        task_type: "local_agent",
        subagent_type: "general-purpose",
        description: "Background sleep probe",
    };
    const watcher = {
        task_id: "w4kq0d2",
        task_type: "monitor_mcp",
        description: "Watch the session's files",
        ambient: true,
    };
    const changed = (tasks: readonly object[]) => ({
        type: "system",
        subtype: "background_tasks_changed",
        tasks,
    });
    function query(params: { prompt: AsyncIterable<unknown> }) {
        async function* messages() {
            const input = params.prompt[Symbol.asyncIterator]();
            await input.next();
            yield { type: "system", subtype: "init" };
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "started" },
                },
            };
            yield changed([shell]);
            yield changed([shell, subagent, watcher]);
            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "started",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
            };
            await new Promise<void>((resolve) => (state.finish = resolve));
            yield changed([subagent, watcher]);
            yield changed([subagent, watcher]);
            yield changed([watcher]);
            await input.next();
        }
        const iterator = messages();
        return Object.assign(iterator, {
            supportedModels: async () => [],
            setModel: async () => undefined,
            applyFlagSettings: async () => undefined,
            setPermissionMode: async () => undefined,
            interrupt: async () => undefined,
            close: () => undefined,
        });
    }
    return { state, query };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

const open: AcpSession[] = [];
afterEach(() => {
    for (const session of open.splice(0)) session.destroy();
});

/** A Claude Code session whose turn environment records each background-work report. */
async function sessionReporting(reports: number[]): Promise<{
    readonly session: AcpSession;
    readonly run: () => Promise<SessionEvent[]>;
}> {
    const directory = mkdtempSync(join(tmpdir(), "claude-background-work-"));
    const provider = new AcpProvider({
        connect: claudeAgentConnect({}),
        stateDirectory: join(directory, "state"),
        environment: () => ({
            cwd: directory,
            permissionMode: "full_access",
            backgroundWork: (running: number) => reports.push(running),
        }),
    });
    const session = await provider.session("agent-1", { instructions: "Be Happy.", tools: [] });
    open.push(session);
    const messages: SessionMessage[] = [
        { role: "user", content: [{ type: "text", text: "Start both in the background." }] },
    ];
    const run = async (): Promise<SessionEvent[]> => {
        const events: SessionEvent[] = [];
        const ctx = withLifetime(createRootContext().named("test"), new AbortController().signal);
        for await (const event of session.run(ctx, {
            context: { instructions: "Be Happy.", messages },
        })) {
            events.push(event);
            if (event.type === "done") break;
        }
        return events;
    };
    return { session, run };
}

async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

it("reports Claude Code's background tasks while they outlive the turn that started them", async () => {
    const reports: number[] = [];
    const { run } = await sessionReporting(reports);

    const turn = await run();
    expect(turn.at(-1)).toMatchObject({ type: "done", state: "normal", endTurn: true });
    // The command, then the command and the subagent; the ambient watcher is not counted.
    expect(reports).toEqual([1, 2]);

    sdk.state.finish();
    await until(() => reports.at(-1) === 0, "the last background task to end");
    // An unchanged set reports nothing new, and a set holding only ambient tasks is no work.
    expect(reports).toEqual([1, 2, 1, 0]);
}, 30_000);

it("reports no background work once the session that ran it is gone", async () => {
    const reports: number[] = [];
    const { session, run } = await sessionReporting(reports);

    await run();
    expect(reports).toEqual([1, 2]);

    // Closing the session ends the Claude Code process, and its background tasks with it.
    session.destroy();
    expect(reports).toEqual([1, 2, 0]);
}, 30_000);
