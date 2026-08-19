---
name: workforce
description: "Delegation policy and model rankings for subagents: which model (gpt-5.6-sol / opus-5 / fable-5) to pick for which task, how to be an orchestrator instead of burning your own context, and how to run gpt-5.6-sol via codex-wrapper. Use BEFORE delegating any work to subagents, spawning agents/workflows, or choosing a model for a subtask."
---

# Subagents and token usage

Be very careful with token usage: be an orchestrator and manager over subagents. Do not dive into huge repositories, read whole huge docs/files, or write routine code/configs/migrations/plots yourself — delegate all token-heavy dirty work to subagents. Spend your own context only on planning, architecture, research taste, code design, reading tough places where less capable agents struggle, and reviewing (or writing) production/good code.
Especially avoid (!!!) baby-sitting long runs (e.g. training or feature collection) yourself — let gpt-5.6-sol do it for you.
One more time: NEVER spend your own time/tokens on manual labour such as writing a well-scoped, verifiable, non-production module with clearly defined inputs and outputs.

## Rankings

Axes 0–10: INT = intelligence (how hard a well-defined problem it handles unsupervised), RT = research taste, PCQ = production code quality, IF = exact instruction following, ATD = attention to detail. Cost = what I actually pay (OpenAI limits are generous).

| model              | cost | INT | RT | PCQ | IF | ATD |
|--------------------|------|-----|----|-----|----|-----|
| gpt-5.6-sol (high) | $    | 8   | 5  | 4   | 10 | 10  |
| opus-5 (high)      | $$   | 8   | 8  | 6   | 8  | 7   |
| fable-5 (high)     | $$$$ | 9   | 9  | 9   | 8  | 8   |

How to apply:
- Pick the cheapest model whose scores meet the task's bar; when axes conflict for anything that ships, INT & RT >> cost.
- NEVER delegate open-ended / not-well-specified tasks that require independent research and research taste to gpt-5.6-sol (e.g. "research why strategy X has a quality drawdown"). Do them yourself or delegate to a fable-5/opus-5 subagent. Delegate to gpt-5.6-sol only engineering or well-specified tasks where the spec fully defines the result: "implement a strategy with such-and-such logic" — ok; "build such-and-such plot with such-and-such math" — ok; open-ended investigation — not ok.
  - Though: you can always run gpt-5.6-sol on any research in parallel — never trust its _research_ conclusions blindly, but it can spot details that e.g. fable-5 might miss.
- If a cheaper model's output doesn't meet the bar, redo the work with a smarter model without asking me (model choice is yours; the autonomy rules still gate *what* work is allowed). Judge the output, not the price tag: escalating costs less than shipping mediocre work.
- Never trust agent conclusions blindly. When an agent claims "X is better than Y because <arguments>", the arguments must be backed by substantive, simple, easily explainable cases. If a subagent explains its conclusion in an overly convoluted way — a pile of numbers and plots instead of a clear story — treat the conclusion as unreliable and send another independent subagent to re-verify the ESSENCE.
- Bulk/mechanical work (explore current codebase, clear-spec implementation, straightforward data analysis, migrations): gpt-5.6-sol — its IF/ATD are top, but PCQ 4 means never ask it to write production code.
- Anything user-facing (UI, copywriting, API design) needs RT ≥ 7.
- Reviews of plans/implementations: fable-5. Optionally gpt-5.6-sol as an extra independent perspective.
- Never use models below the table (Haiku, bare Sonnet, etc.) for actual work.
- Do not use Explore subagent for codebase exploration, use gpt-5.6-sol instead.

## Using gpt-5.6-sol
Claude models (opus-5, fable-5) run via the Agent/Workflow `model` parameter; that parameter only takes Claude models, so for gpt-5.6-sol use a `codex-wrapper` subagent (`model: 'sonnet', effort: 'low'`) which is instructed to communicate with gpt-5.6-sol and return the result.
