import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const AGENT = fileURLToPath(
    new URL("../fixtures/background-working-acp-agent.mjs", import.meta.url),
);
const MODEL = "acp/scripted/m1";
const SELECTION = {
    providerId: "scripted",
    modelId: MODEL,
    effort: "medium",
    permissionMode: "workspace_write",
} as const;
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A daemon running a scripted ACP agent that keeps background work going after its turns. */
async function gymWithScriptedHarness(): Promise<AgentGym> {
    const gym = await createAgentGym({
        config: [
            "[harnesses.scripted]",
            'type = "acp"',
            'name = "Scripted Agent"',
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(AGENT)}]`,
            "",
        ].join("\n"),
        liveProviders: ["scripted"],
    });
    running.add(gym);
    // The daemon never asks a test-owned catalog's agents for their models; give it the one.
    const directory = join(gym.happyHome, "agent", "foreign-agents", "scripted");
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "models.json"),
        JSON.stringify([
            {
                id: MODEL,
                name: "Model One",
                effortLevels: ["medium"],
                defaultEffort: "medium",
                contextWindow: 1_000_000,
            },
        ]),
    );
    await gym.restart();
    return gym;
}

/** The running-process counts the agent's `agent.updated` events announced, repeats merged. */
async function announcedProcessCounts(gym: AgentGym): Promise<number[]> {
    const counts: number[] = [];
    for (const event of await gym.sessionEvents()) {
        if (event["type"] !== "agent.updated") continue;
        const payload = event["payload"] as
            | { readonly changes?: { readonly processes?: { readonly running?: unknown } } }
            | undefined;
        const count = payload?.changes?.processes?.running;
        if (typeof count === "number" && counts.at(-1) !== count) counts.push(count);
    }
    return counts;
}

async function processesRunning(gym: AgentGym, count: number): Promise<true | undefined> {
    return (await gym.getSession()).processes.running === count ? true : undefined;
}

it("counts the work a foreign harness keeps running after its turn among the agent's processes", async () => {
    const gym = await gymWithScriptedHarness();

    await gym.send("start two background tasks", SELECTION);
    await gym.waitUntil(
        async () => await processesRunning(gym, 2),
        "the two background tasks to be counted",
    );
    // The turn is over while the work it started goes on.
    expect((await gym.getSession()).status).toBe("idle");

    await gym.send("finish one of them", SELECTION);
    await gym.waitUntil(async () => await processesRunning(gym, 1), "one task to be left");

    await gym.send("finish all of them", SELECTION);
    await gym.waitUntil(async () => await processesRunning(gym, 0), "no task to be left");

    // Each change was announced, so a client following the events holds the same count.
    expect(await announcedProcessCounts(gym)).toEqual([2, 1, 0]);
    expect(gym.errors).toEqual([]);
}, 60_000);
