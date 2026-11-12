// A minimal ACP agent that starts a turn of its own, speaking JSON-RPC over stdio without any SDK.
// A prompt naming "background" is answered at once; a moment after that answer the agent starts a
// turn by itself, announced with "_happy/turn_started" and ended with "_happy/turn_ended", as
// Claude Code does when a background command it started finishes, and says `background:done`.
// Anything else is echoed back.
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

function backgroundTurn(sessionId) {
    send({ method: "_happy/turn_started", params: { sessionId } });
    say(sessionId, "background:done");
    send({
        method: "_happy/turn_ended",
        params: {
            sessionId,
            stopReason: "end_turn",
            usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        },
    });
}

function prompt(params) {
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    if (text.includes("background")) {
        say(params.sessionId, "started");
        setTimeout(() => backgroundTurn(params.sessionId), 300);
        return { stopReason: "end_turn" };
    }
    say(params.sessionId, `echo:${text}`);
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
