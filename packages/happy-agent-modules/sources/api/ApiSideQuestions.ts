import { randomUUID } from "node:crypto";

import type { AcpSideQuestionAnswer } from "@slopus/happy-providers";

import { ApiError } from "./ApiError.js";

/** How long one request waits for an answer: well inside every transport's 30-second limit. */
const WAIT_MS = 20_000;
/** A side question nobody collects within this long of being asked is stopped and forgotten. */
const LIFETIME_MS = 10 * 60_000;
/** The longest failure message a response carries. */
const MAX_ERROR = 2_000;

/** A side question as one response reports it. */
export type ApiSideQuestionState =
    | { readonly id: string; readonly status: "answering" }
    | {
          readonly id: string;
          readonly status: "answered";
          readonly response: string | null;
          readonly synthetic: boolean;
      }
    | { readonly id: string; readonly status: "failed"; readonly error: string };

type Outcome =
    | { readonly answer: AcpSideQuestionAnswer }
    | { readonly refusal: ApiError }
    | { readonly error: string };

interface Question {
    readonly agentId: string;
    /** The team member who asked, who alone may collect or cancel it; none when standalone. */
    readonly owner: string | undefined;
    readonly controller: AbortController;
    readonly outcome: Promise<Outcome>;
    readonly expiry: NodeJS.Timeout;
}

/**
 * @internal The side questions still being answered, or answered and not yet collected.
 *
 * Answering can take longer than one request may wait, so a question is asked once and collected
 * with as many requests as it needs, each waiting at most 20 seconds. A question is forgotten once
 * a response carries its answer or failure, when it is cancelled, and when nobody has collected it
 * within 10 minutes of being asked, which also stops its answer. So only the questions of the last
 * ten minutes are held, and only in memory: they end with the daemon.
 */
export class ApiSideQuestions {
    readonly #questions = new Map<string, Question>();
    readonly #waitMs: number;

    constructor(options: { readonly waitMs?: number } = {}) {
        this.#waitMs = options.waitMs ?? WAIT_MS;
    }

    /**
     * Start answering with `answer`, which runs on beyond this request, and wait for it. An
     * `ApiError` that `answer` throws refuses the question, and is thrown to the asker instead.
     */
    async ask(
        agentId: string,
        owner: string | undefined,
        answer: (signal: AbortSignal) => Promise<AcpSideQuestionAnswer>,
    ): Promise<ApiSideQuestionState> {
        const id = randomUUID();
        const controller = new AbortController();
        const expiry = setTimeout(() => this.#forget(id, true), LIFETIME_MS);
        expiry.unref?.();
        const outcome = answer(controller.signal).then(
            (answered): Outcome => ({ answer: answered }),
            (error: unknown): Outcome =>
                error instanceof ApiError ? { refusal: error } : { error: errorText(error) },
        );
        this.#questions.set(id, { agentId, owner, controller, outcome, expiry });
        return (await this.#wait(id)) ?? { id, status: "failed", error: "It was stopped." };
    }

    /** Wait again for a question asked earlier; `undefined` when it is gone or someone else's. */
    async wait(
        agentId: string,
        owner: string | undefined,
        id: string,
    ): Promise<ApiSideQuestionState | undefined> {
        if (this.#find(agentId, owner, id) === undefined) return undefined;
        return await this.#wait(id);
    }

    /** Stop answering a question and forget it; `false` when it was already gone. */
    cancel(agentId: string, owner: string | undefined, id: string): boolean {
        if (this.#find(agentId, owner, id) === undefined) return false;
        this.#forget(id, true);
        return true;
    }

    #find(agentId: string, owner: string | undefined, id: string): Question | undefined {
        const question = this.#questions.get(id);
        return question?.agentId === agentId && question.owner === owner ? question : undefined;
    }

    async #wait(id: string): Promise<ApiSideQuestionState | undefined> {
        const question = this.#questions.get(id);
        if (question === undefined) return undefined;
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
            question.outcome,
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), this.#waitMs);
            }),
        ]).finally(() => clearTimeout(timer));
        if (outcome === undefined) return { id, status: "answering" };
        // Cancelled, expired, or collected by another request meanwhile.
        if (this.#questions.get(id) !== question) return undefined;
        this.#forget(id, false);
        if ("refusal" in outcome) throw outcome.refusal;
        if ("error" in outcome) return { id, status: "failed", error: outcome.error };
        return {
            id,
            status: "answered",
            response: outcome.answer.response,
            synthetic: outcome.answer.synthetic,
        };
    }

    #forget(id: string, stop: boolean): void {
        const question = this.#questions.get(id);
        if (question === undefined) return;
        clearTimeout(question.expiry);
        this.#questions.delete(id);
        if (stop) question.controller.abort();
    }
}

function errorText(error: unknown): string {
    const text = (error instanceof Error ? error.message : String(error)).trim();
    return (text === "" ? "The harness gave no reason." : text).slice(0, MAX_ERROR);
}
