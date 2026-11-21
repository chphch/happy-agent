import { afterEach, expect, it, vi } from "vitest";

import { ApiError } from "../../sources/api/ApiError.js";
import { ApiSideQuestions } from "../../sources/api/ApiSideQuestions.js";

afterEach(() => {
    vi.useRealTimers();
});

/** An answer that comes only when `resolve` or `reject` is called, and notes its abort. */
function pendingAnswer() {
    let resolve!: (answer: { response: string | null; synthetic: boolean }) => void;
    let reject!: (error: unknown) => void;
    const state = { signal: undefined as AbortSignal | undefined };
    const answer = (signal: AbortSignal) => {
        state.signal = signal;
        return new Promise<{ response: string | null; synthetic: boolean }>((ok, fail) => {
            resolve = ok;
            reject = fail;
        });
    };
    return {
        answer,
        state,
        resolve: (text: string) => resolve({ response: text, synthetic: false }),
        reject: (error: unknown) => reject(error),
    };
}

it("answers at once when the answer comes within the wait", async () => {
    const questions = new ApiSideQuestions({ waitMs: 1_000 });

    const state = await questions.ask("agent-1", undefined, async () => ({
        response: "The parser.",
        synthetic: false,
    }));

    expect(state).toEqual({
        id: expect.any(String),
        status: "answered",
        response: "The parser.",
        synthetic: false,
    });
    // Collected: the question is gone.
    expect(await questions.wait("agent-1", undefined, state.id)).toBeUndefined();
});

it("reports a question still being answered, and hands its answer to the next wait", async () => {
    const questions = new ApiSideQuestions({ waitMs: 20 });
    const pending = pendingAnswer();

    const first = await questions.ask("agent-1", undefined, pending.answer);
    expect(first).toEqual({ id: expect.any(String), status: "answering" });
    expect(await questions.wait("agent-1", undefined, first.id)).toEqual({
        id: first.id,
        status: "answering",
    });

    const waiting = questions.wait("agent-1", undefined, first.id);
    pending.resolve("Halfway.");
    expect(await waiting).toEqual({
        id: first.id,
        status: "answered",
        response: "Halfway.",
        synthetic: false,
    });
    expect(pending.state.signal?.aborted).toBe(false);
});

it("reports a harness failure as a failed question, and refuses with the error it was refused with", async () => {
    const questions = new ApiSideQuestions({ waitMs: 1_000 });

    expect(
        await questions.ask("agent-1", undefined, async () => {
            throw new Error("Rate limited until 3 pm.");
        }),
    ).toEqual({ id: expect.any(String), status: "failed", error: "Rate limited until 3 pm." });

    const refusal = new ApiError(409, "harness_not_running", "There is no conversation yet.");
    await expect(
        questions.ask("agent-1", undefined, async () => {
            throw refusal;
        }),
    ).rejects.toBe(refusal);
});

it("stops answering a cancelled question and forgets it", async () => {
    const questions = new ApiSideQuestions({ waitMs: 10 });
    const pending = pendingAnswer();
    const { id } = await questions.ask("agent-1", undefined, pending.answer);

    expect(questions.cancel("agent-1", undefined, id)).toBe(true);
    expect(pending.state.signal?.aborted).toBe(true);
    expect(questions.cancel("agent-1", undefined, id)).toBe(false);
    expect(await questions.wait("agent-1", undefined, id)).toBeUndefined();
    // An answer arriving after all goes nowhere.
    pending.resolve("Too late.");
});

it("keeps a question to the agent and the person who asked it", async () => {
    const questions = new ApiSideQuestions({ waitMs: 10 });
    const pending = pendingAnswer();
    const { id } = await questions.ask("agent-1", "user-1", pending.answer);

    expect(await questions.wait("agent-2", "user-1", id)).toBeUndefined();
    expect(await questions.wait("agent-1", "user-2", id)).toBeUndefined();
    expect(await questions.wait("agent-1", undefined, id)).toBeUndefined();
    expect(questions.cancel("agent-1", "user-2", id)).toBe(false);
    expect(pending.state.signal?.aborted).toBe(false);
    expect(await questions.wait("agent-1", "user-1", id)).toEqual({ id, status: "answering" });
});

it("stops and forgets a question nobody collects within ten minutes", async () => {
    vi.useFakeTimers();
    const questions = new ApiSideQuestions({ waitMs: 1_000 });
    const pending = pendingAnswer();
    const asking = questions.ask("agent-1", undefined, pending.answer);
    await vi.advanceTimersByTimeAsync(1_000);
    const { id } = await asking;

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(pending.state.signal?.aborted).toBe(true);
    expect(await questions.wait("agent-1", undefined, id)).toBeUndefined();
});
