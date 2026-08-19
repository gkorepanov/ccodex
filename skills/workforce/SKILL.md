---
name: workforce
description: "Delegation policy and model rankings for subagents: which model (gpt-5.6-sol / opus-4.8 / fable-5) to pick for which task, how to be an orchestrator instead of burning your own context, and how to run gpt-5.6-sol via codex-wrapper. Use BEFORE delegating any work to subagents, spawning agents/workflows, or choosing a model for a subtask."
---

# Subagents and token usage

Be very careful with token usage: be an orchestrator and manager over subagents. Do not dive into huge repositories, read whole huge docs/files, or write routine code/configs/migrations/plots yourself — delegate all token-heavy dirty work to subagents. Spend your own context only on planning, architecture, research taste, code design, reading tough places where less capable agents struggle, and reviewing (or writing) production/good code.
Especially avoid baby-sitting long runs (e.g. training or feature collection) yourself, let gpt-5.6-sol do it for you.

## Rankings

| model           | cost | intelligence | taste |
|-----------------|------|--------------|-------|
| gpt-5.6-sol     | $    | 8            | 5     |
| opus-4.8 (high) | $$$  | 6            | 7     |
| fable-5 (high)  | $$$$ | 10           | 10    |

Cost reflects what I actually pay (OpenAI has really generous limits). Intelligence is how hard a well-defined problem the model can handle unsupervised. Taste covers research taste, UI/UX, code quality, API design, and copywriting.

How to apply:
- Pick the cheapest model whose intelligence/taste meet the task's bar; when axes conflict for anything that ships, intelligence > taste > cost.
- NEVER delegate open-ended / not-well-specified tasks that require independent research and research taste to gpt-5.6-sol or opus-4.8 (e.g. "research why strategy X has a quality drawdown"). Do them yourself or delegate to a fable-5 subagent. Delegate to gpt-5.6-sol/opus-4.8 only engineering or well-specified tasks where the spec fully defines the result: "implement a strategy with such-and-such logic" — ok; "build such-and-such plot with such-and-such math" — ok; open-ended investigation — not ok.
- If a cheaper model's output doesn't meet the bar, redo the work with a smarter model without asking me (model choice is yours; the autonomy rules still gate *what* work is allowed). Judge the output, not the price tag: escalating costs less than shipping mediocre work.
- Bulk/mechanical work (explore current codebase, clear-spec implementation, straightforward data analysis, migrations): gpt-5.6-sol.
- Anything user-facing (UI, copywriting, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.6-sol as an extra independent perspective.
- Never use models below the table (Haiku, bare Sonnet, etc.) for actual work.
- Do not use Explore subagent for codebase exploration, use gpt-5.6-sol instead.

## Using gpt-5.6-sol
Claude models (opus-4.8, fable-5) run via the Agent/Workflow `model` parameter; that parameter only takes Claude models, so for gpt-5.6-sol use a `codex-wrapper` subagent (`model: 'sonnet', effort: 'low'`) which is instructed to communicate with gpt-5.6-sol and return the result.
