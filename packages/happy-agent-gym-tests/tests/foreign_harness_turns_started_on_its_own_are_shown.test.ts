import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const AGENT = fileURLToPath(new URL("../fixtures/self-starting-acp-agent.mjs", import.meta.url));
const MODEL = "acp/scripted/m1";
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A daemon running a scripted ACP agent that starts turns of its own. */
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

function agentTexts(history: Awaited<ReturnType<AgentGym["history"]>>): string[] {
    return history.runs
        .flatMap((run) => run.messages)
        .filter((message) => message.role === "agent")
        .flatMap((message) => message.content as readonly { type: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "");
}

it("shows a turn a foreign harness starts on its own after its prompt has ended", async () => {
    const gym = await gymWithScriptedHarness();
    await gym.send("Start the build in the background.", {
        providerId: "scripted",
        modelId: MODEL,
        effort: "medium",
        permissionMode: "workspace_write",
    });
    expect(agentTexts(await gym.history())).toEqual(["started"]);

    await gym.waitUntil(
        async () =>
            agentTexts(await gym.history()).includes("background:done") ? true : undefined,
        "the harness's own turn to be shown",
    );
    const history = await gym.history();
    expect(agentTexts(history)).toEqual(["started", "background:done"]);
    // The notice that woke the agent is not shown to the person as anything they said.
    expect(
        history.runs.flatMap((run) => run.messages).filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(gym.errors).toEqual([]);
}, 60_000);
