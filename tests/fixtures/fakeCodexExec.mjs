#!/usr/bin/env node
// `codex exec --json …` stand-in: echoes its arguments as the agent message.
const args = process.argv.slice(2);
const resume = args[1] === "resume";
const threadId = resume ? args[args.indexOf("--") - 1] : "0c0c0c0c-0000-4000-8000-000000000003";
const prompt = args.at(-1);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (prompt === "fail") {
  process.stderr.write("model not available\n");
  process.exit(1);
}
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(args) } });
emit({ type: "turn.completed", usage: {} });
