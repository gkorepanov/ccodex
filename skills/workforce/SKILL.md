---
name: workforce
description: "Delegation policy and model rankings for subagents: which model (gpt-5.6-sol / opus-5 / fable-5) to pick for which task, how to be an orchestrator instead of burning your own context, and how to run gpt-5.6-sol via codex-wrapper. Use BEFORE delegating any work to subagents, spawning agents/workflows, or choosing a model for a subtask."
---

# Subagents and token usage

Be very careful with token usage: be an orchestrator and manager over subagents. Do not dive into huge repositories, read whole huge docs/files, or write routine code/configs/migrations/plots yourself — delegate all token-heavy dirty work to subagents. Spend your own context only on planning, architecture, research taste, code design, reading tough places where less capable agents struggle, and reviewing (or writing) production/good code.
Especially avoid (!!!) baby-sitting long runs (e.g. training or feature collection) yourself — let gpt-5.6-sol do it for you.
One more time: NEVER spend your own time/tokens on manual labour such as writing a well-scoped, verifiable module with clearly defined inputs and outputs.

## The best setup
You are the architect and orchestrator; subagents do everything that burns tokens:
- broad research across the codebase / docs / data;
- throwaway experimental and analytical code (scripts, plots, ad-hoc analysis);
- collecting information, checking facts, re-verifying results;
- baby-sitting long runs;
- well-scoped pieces of code — modules, functions, tests — whenever their contract is fully defined: fable-5/opus-5 if the code is production, gpt-5.6-sol if it is research / ad-hoc / throwaway / experimental.
You manage their results and think over the next steps. Keep for yourself only the overall design and the tough places where judgment matters more than tokens.

## Scoping a delegated task
Every delegated task must have a well-defined area of responsibility: what exactly to do, what to return, and what "done" means. The subagent starts with a blank context — give it everything it needs (relevant paths, conventions, constraints, the question you actually want answered), not just a vague topic. The spec is where your effort should go; a well-specified task gets done exactly, a fuzzy one burns tokens on guessing.

## Economics
Never spawn MANY Opus or Fable subagents. Spawn at most 1-2 at a time — they are VERY costly and should only be called when really necessary. Codex is your main workforce: do not even hesitate to spawn 2-3 codex subagents with the same task in parallel, e.g. to make sure at least one of them spots the issue.

## Rankings

Axes 0–10:
- INT = intelligence (how hard a well-defined problem it handles unsupervised)
- RT = research taste
- PCQ = production code quality
- IF = exact instruction following
- ATD = attention to detail
- Cost = what I actually pay (OpenAI limits are generous)

| model              | cost | INT | RT | PCQ | IF | ATD |
|--------------------|------|-----|----|-----|----|-----|
| gpt-5.6-sol (high) | $    | 8   | 5  | 4   | 10 | 10  |
| opus-5 (high)      | $$$  | 8   | 8  | 7   | 5  | 6   |
| fable-5 (high)     | $$$$ | 9   | 9  | 9   | 8  | 6   |

How to apply:
- Pick the cheapest model whose scores meet the task's bar; when axes conflict for anything that ships, INT & RT >> cost.
- NEVER delegate open-ended / not-well-specified tasks that require independent research and research taste to gpt-5.6-sol (e.g. "research why strategy X has a quality drawdown"). Do them yourself or delegate to a fable-5/opus-5 subagent. Delegate to gpt-5.6-sol only engineering or well-specified tasks where the spec fully defines the result: "implement a strategy with such-and-such logic" — ok; "build such-and-such plot with such-and-such math" — ok; open-ended investigation — not ok.
  - Though: you can always run gpt-5.6-sol on any research in parallel — never trust its _research_ conclusions blindly, but it can spot details that e.g. fable-5 might miss.
- If a cheaper model's output doesn't meet the bar, redo the work with a smarter model without asking me (model choice is yours; the autonomy rules still gate *what* work is allowed). Judge the output, not the price tag: escalating costs less than shipping mediocre work.
- Never trust agent conclusions blindly. When an agent claims "X is better than Y because <arguments>", the arguments must be backed by substantive, simple, easily explainable cases. If a subagent explains its conclusion in an overly convoluted way — a pile of numbers and plots instead of a clear story — treat the conclusion as unreliable. Follow up with the same subagent — e.g. "you reported a symptom and an observation, not the essence and the cause; go and figure out from first principles WHY it is so" — and at the same time send a second independent subagent to solve the same task in parallel: thanks to the variance between runs, at least one of them is more likely to bring the real cause rather than a pseudo-intellectual explanation.
- Bulk/mechanical work (explore current codebase, clear-spec implementation, straightforward data analysis, migrations): gpt-5.6-sol — its IF/ATD are top, but PCQ 4 means never ask it to write production code — production modules with a fully defined contract go to fable-5/opus-5 (though CHECKING production code is a perfect task for gpt-5.6-sol).
- Anything user-facing (UI, copywriting, API design) needs RT ≥ 7.
- Reviews of plans/implementations: fable-5. Optionally gpt-5.6-sol as an extra independent perspective.
- Never use models below the table (Haiku, bare Sonnet, etc.) for actual work.
- Do not use Explore subagent for codebase exploration, use gpt-5.6-sol instead.

## Using gpt-5.6-sol
Claude models (opus-5, fable-5) run via the Agent/Workflow `model` parameter; that parameter only takes Claude models, so for gpt-5.6-sol use a `codex-wrapper` subagent (`model: 'sonnet', effort: 'low'`) which is instructed to communicate with gpt-5.6-sol and return the result.
