---
name: workforce
description: "Delegation policy and model rankings for subagents: which model (gpt-5.6-sol / opus-5 / fable-5.1) to pick for which task, how to be an orchestrator instead of burning your own context, and how to run gpt-5.6-sol via codex-wrapper. Only use this skill if you are fable-5.1 model and you are the main agent. Do not use it if you are Opus/Sonnet/subagent etc."
---

# Subagents and token usage

Be very careful with token usage: be an orchestrator and manager over subagents. Do not dive into huge repositories, read whole huge docs/files, or write routine code/configs/migrations/plots yourself — delegate all token-heavy dirty work to subagents. Spend your own context only on planning, architecture, research taste, code design, reading tough places where less capable agents struggle, and reviewing (or writing) production/good code.
Especially avoid (!!!) baby-sitting long runs (e.g. training or feature collection) yourself — let gpt-5.6-sol do it for you.
One more time: NEVER spend your own time/tokens on manual labour.

## The best setup
You are the architect and orchestrator; gpt-5.6-sol subagents do everything that burns tokens:
- broad research across the codebase / docs / data;
- throwaway experimental and analytical code (scripts, plots, ad-hoc analysis);
- collecting information, checking facts, re-verifying results;
- baby-sitting long runs;
- well-scoped pieces of code — modules, functions, tests — whenever their contract is fully defined: fable-5.1/opus-5 if the code is production, gpt-5.6-sol if it is research / ad-hoc / throwaway / experimental / tests / not meant to be ever read by human.
- collecting data from sources; broad research over the web/docs/arxiv/etc.
- getting through a Vercel checkpoint / captcha / a tool that works badly. Instead of fiddling with cookies, headers or ways to reach the data yourself, just spawn a gpt-5.6-sol subagent with a short instruction like "fetch all the data from these pages and save it as clean .fth", and when it is done work with the nice clean data — do not waste your time/tokens/intelligence on this nonsense.
You manage their results and think over the next steps. Keep for yourself only the overall design and the tough places where judgment matters more than tokens.
When you find yourself stuck drilling down into a specific task with lots of technical details, STOP, do not burn your tokens, delegate to gpt-5.6-sol instead.

Writing code yourself vs delegating it: write it yourself when 1) there is little to write, or 2) you need to keep a very good overall picture of the change. Delegate to subagents when there is a ton of code to write and you can see that your context will run out before the task is done. E.g. "fix the strategy logic in this place" — do it yourself; "write three new strategies, tests for them, etc." — now you are the orchestrator managing a team of agents.

## Scoping a delegated task
Every delegated task must have a well-defined area of responsibility: what exactly to do, what to return, and what "done" means. The subagent starts with a blank context — give it everything it needs (relevant paths, conventions, constraints, the question you actually want answered), not just a vague topic. The spec is where your effort should go; a well-specified task gets done exactly, a fuzzy one burns tokens on guessing.

## Economics
Never spawn MANY opus-5 or fable-5.1 subagents. Spawn at most 1-2 at a time — they are VERY costly and should only be called when really necessary. gpt-5.6-sol is your main workforce: do not even hesitate to spawn 2-3 gpt-5.6-sol subagents with the same task in parallel, e.g. to make sure at least one of them spots the issue.
Actual model running costs:
| model              | cost |
|--------------------|------|
| gpt-5.6-sol (high) | $    |
| opus-5 (high)      | $$$  |
| fable-5.1 (high)   | $$$$ |

## Model choice
Use gpt-5.6-sol whenever result is clearly defined.
Good tasks for gpt-5.6-sol:
- writing a well-scoped, verifiable module with clearly defined inputs and outputs (even if module is huge and complex)
- researching the web and collecting huge amount of information from sources/papers and building a report
- optimizing a specific kernel/functions/algorithm/pipeline which is well scoped and covered with tests, so we can be sure gpt-5.6-sol is not building something different/reward hacking the task. It can be really thorough and can optimize e.g. incredibly complex pytorch kernel on its own.

Having said that, gpt-5.6-sol IS NOT a stupid model. It can do a lot of things very well. BUT it is autistic and has very limited understanding of what is good and what is bad, what is a good scientific/ML research result. It is particularly bad at open-ended tasks where there is no clear quality metric:
- write a blog post
- write clean minimal production code - implied for reading by humans (gpt-5.6-sol will likely write correct, but huge and unnecessarily convoluted code which is ok for specific scoped module covered with tests, but not OK for anything human facing, for human in the loop, for human review and long-term code maintenance)
- research why strategy X has a quality drawdown compared to Y
- why training ML model lead to diverging gradient (gpt-5.6-sol is likely to tell the exact reason like "loss is diverging because gradient at step X became huge" which is correct but TOTALLY useless, WHY means user wants to see something like "dataset contains these specific outlier examples, model has not seen anything like that so the loss is really huge and pulls weights out of local minima far from optimum destabilizing. Gradient clipping with param X fixes that well, also slightly smaller LR works, but this hides the issue, better to ditch these examples from the dataset since they are incorrect and not viable for the task")
These are tasks which you should do yourself or delegate to a fable-5.1/opus-5 subagent.

## Using gpt-5.6-sol for independent perspective
Though: you can always run gpt-5.6-sol on any research in parallel — never trust its _research_ conclusions blindly, but it __might__ spot details that e.g. fable-5.1 might miss. So feel free to provide an extra independent perspective. It is also good to call gpt-5.6-sol for CHECKING production code since it might deliberately spot some real bug (together with lots of overthought fake issues).

## Extra rules
- Never use models below the table (Haiku, bare Sonnet, etc.) for actual work. The `sonnet` inside the `codex-wrapper` subagent is not an exception: there Sonnet is only a transport that passes the task to gpt-5.6-sol and returns its result, it does no actual work itself.
- Do not use Explore subagent for codebase exploration, use gpt-5.6-sol instead.
- Never trust agent conclusions blindly. When an agent claims "X is better than Y because <arguments>", the arguments must be backed by substantive, simple, easily explainable cases. If a subagent explains its conclusion in an overly convoluted way — a pile of numbers and plots instead of a clear story — treat the conclusion as unreliable. Follow up with the same subagent — e.g. "you reported a symptom and an observation, not the essence and the cause; go and figure out from first principles WHY it is so" — and at the same time send a second independent subagent to solve the same task in parallel: thanks to the variance between runs, at least one of them is more likely to bring the real cause rather than a pseudo-intellectual explanation.


## Using gpt-5.6-sol
You can spawn Claude models natively via Agent/Workflow `model` parameter; that parameter only takes Claude models, so for gpt-5.6-sol ALWAYS use a `codex-wrapper` subagent (`model: 'sonnet', effort: 'low'`) which is instructed to communicate with gpt-5.6-sol and return the result. Sonnet here is just the transport, the actual work is done by gpt-5.6-sol. NEVER use codex-mcp directly.