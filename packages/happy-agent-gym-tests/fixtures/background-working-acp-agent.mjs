// A minimal ACP agent that keeps work running after its turns, speaking JSON-RPC over stdio without
// any SDK. It reports how many background tasks it runs with "_happy/background_work", as the
// Claude Code driver does for Claude Code's background commands and subagents: a prompt naming
// "start" leaves two running, "finish one" leaves one and "finish all" leaves none. Each prompt
// says the count it left; anything else is echoed back.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let nextId = 1;

const say = (sessionId, text) =>
    send({
        method: "session/update",
        params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
    });

const MODELS = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "m1",
    options: [{ value: "m1", name: "Model One" }],
};

function prompt(params) {
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const running = text.includes("finish all")
        ? 0
        : text.includes("finish one")
          ? 1
          : text.includes("start")
            ? 2
            : undefined;
    if (running === undefined) {
        say(params.sessionId, `echo:${text}`);
        return { stopReason: "end_turn" };
    }
    send({ method: "_happy/background_work", params: { sessionId: params.sessionId, running } });
    say(params.sessionId, `running:${running}`);
    return { stopReason: "end_turn" };
}

function handle(message) {
    switch (message.method) {
        case "initialize":
            return {
                protocolVersion: 1,
                agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
            };
        case "session/new":
            return { sessionId: `s-${nextId++}`, configOptions: [MODELS] };
        case "session/set_config_option":
            return { configOptions: [MODELS] };
        case "session/prompt":
            return prompt(message.params);
        default:
            throw new Error(`Unhandled ${message.method}`);
    }
}

createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined || message.method === undefined) return;
    try {
        send({ id: message.id, result: handle(message) });
    } catch (error) {
        send({ id: message.id, error: { code: -32601, message: String(error) } });
    }
});
