# How the system works

From the moment an agent sends a run to the moment a person records what was done about it.

`◆` = a call to an AI judge. Everything else is plain code.

```
 ┌──────────────┐
 │  Any agent   │  sends a finished run as JSON (question, answer, context, steps, tokens, time)
 └──────┬───────┘
        │ POST /runs            (POST /runs?wait=true waits and returns the full result instead)
        ▼
 ┌──────────────────────┐        ┌──────────────────────────────────┐
 │ Store the run        │──────► │ Reply 202 "evaluating" (~3 ms)   │──► agent carries on
 │ (never changed)      │        └──────────────────────────────────┘
 └──────┬───────────────┘
        │ background, ONE run at a time (one lock; also catches up after a restart)
        ▼
╔═════════════════════════════════════ STAGE 1: METRICS (what failed) ═══════════════════════════╗
║                                                                                                ║
║   Code only                                AI judge: qwen3:8b                                  ║
║   ┌──────────────────────┐                 ┌──────────────────────────────────────────────┐    ║
║   │ Execution success    │                 │ Backed by sources  (any run with sources)    │    ║
║   │ Speed                │                 │   ◆ split answer into claims                 │    ║
║   │ Cost                 │                 │   ◆ check each claim vs the sources          │    ║
║   │ No data leaked       │                 ├──────────────────────────────────────────────┤    ║
║   └──────────────────────┘                 │ Correct answer  (testing runs only)          │    ║
║                                            │   ◆ split answer   ◆ split answer key        │    ║
║                                            │   ◆ answer vs key  ◆ key vs answer           │    ║
║                                            └──────────────────────────────────────────────┘    ║
║   Each metric → score, pass/fail, reason, evidence ── or SKIPPED:                              ║
║      missing_data (run lacked what it needs)   could_not_run (judge down / bad answer)         ║
╚════════════════════════════════════════════════╤═══════════════════════════════════════════════╝
                                                 ▼
╔═════════════════════════════════ STAGE 2: EVIDENCE (what we saw, how we know) ═════════════════╗
║   recorded  = the agent said so (a step error)                                                 ║
║   computed  = our code checked it (is the judge's quote really in the sources? on-topic?       ║
║               does a "supported" quote contain the claim's numbers?)                           ║
║   judged    = the judge's opinion, could be wrong                                              ║
╚════════════════════════════════════════════════╤═══════════════════════════════════════════════╝
                                                 ▼
╔═════════════════════════════════════ STAGE 3: DIAGNOSIS (why, maybe) ══════════════════════════╗
║                                                                                                ║
║                         ┌──────────────────┐   no    outcome: not_needed                       ║
║                         │ Anything failed? │──────►  (or insufficient_evidence if something    ║
║                         └────────┬─────────┘          couldn't run)                            ║
║                                  │ yes                                                         ║
║                                  ▼                                                             ║
║          ┌───────────────────────────────────────────┐                                         ║
║          │ Correct answer failed?                    │ yes ► ◆ qwen: are the facts the answer  ║
║          └───────────────────────────────────────────┘         missed in the sources at all?   ║
║                                  ▼                                                             ║
║          ┌───────────────────────────────────────────┐                                         ║
║          │ Rules build possible explanations (leads) │  tool_failure, answer_contradicts_...,  ║
║          │ each with supported_by / weakened_by,     │  claim_not_in_context, fact_missing..., ║
║          │ how_to_check, who_could_look              │  context_disagrees_with_answer_key      ║
║          └───────────────────┬───────────────────────┘                                         ║
║                              ▼                                                                 ║
║          ┌───────────────────────────────────────────┐  no                                     ║
║          │ Does a lead rest on a JUDGED observation? │─────► keep leads as they are            ║
║          └───────────────────┬───────────────────────┘                                         ║
║                              │ yes                                                             ║
║                              ▼                                                                 ║
║          unload qwen ► ◆ gemma3:4b re-checks ONLY those claims ► unload gemma                  ║
║                              │                                                                 ║
║               ┌──────────────┼────────────────────────────┐                                    ║
║               ▼              ▼                            ▼                                    ║
║            agree      one says "supported",       both "not backed", differ on                 ║
║          keep lead     the other doesn't          contradicted vs not mentioned                ║
║                       → set lead aside +           → keep lead + caveat                        ║
║                         caveat                                                                 ║
║                                                                                                ║
║   outcome: explanations_found  |  insufficient_evidence (failed, but nothing explains it)      ║
╚════════════════════════════════════════════════╤═══════════════════════════════════════════════╝
                                                 ▼
                      ┌────────────────────────────────────────────────┐
                      │ Save results + diagnosis together (one write)  │
                      └────────────────────────┬───────────────────────┘
                                               ▼
╔═════════════════════════════════════ HUMAN REVIEW ═════════════════════════════════════════════╗
║                                                                                                ║
║   evaluating ─┬─► passed                                                                       ║
║               ├─► could_not_run   (judge was down: not a pass, not a fail, not in the queue)   ║
║               └─► needs_review ──── person reviews each failed metric ────┐                    ║
║                        ▲                                                  │                    ║
║                        └──── "inconclusive" ◄─────────────────────────────┤                    ║
║                                                                           ├─► confirmed ─► resolved
║                                                                           │   (≥1 real)    (action
║                                                                           │                 recorded)
║                                                                           └─► false_alarm          ║
║                                                                               (all wrong)          ║
║   Reviews of explanations and of passed results don't move the status;                       ║
║   they feed the accuracy numbers below.                                                        ║
╚════════════════════════════════════════════════╤═══════════════════════════════════════════════╝
                                                 ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ GET /runs?status=needs_review   → the review queue                                          │
 │ GET /runs/{id}                  → full lineage: question → steps → answer → evidence →      │
 │                                   diagnosis → reviews → action taken                        │
 │ GET /summary                    → since midnight: runs by status and agent, failed runs and │
 │                                   their possible causes (a run can have several), metric    │
 │                                   averages (skipped left out), pending reviews,             │
 │                                   judge vs humans, explanation usefulness                   │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Judge calls per run

| Run | qwen3:8b | gemma3:4b |
|---|---|---|
| Live, passes | 2 | 0 |
| Live, answer contradicts the sources | 2 | 1 |
| Testing, passes | 6 | 0 |
| Testing, wrong answer | up to 7 | up to 3 |

Code metrics, quote checks, rules, status and the summary never call a judge.

## Rules worth knowing

- **Nothing is ever changed.** Results, diagnoses, reviews and resolutions are stored next to the run.
- **Skipped isn't passed.** `could_not_run` is counted separately and left out of averages.
- **Causes overlap.** A run where the tool failed *and* the answer contradicts the sources counts under both possible causes, because they are leads, not a verdict. `failed_runs` is the real total; `runs_with_several_causes` says how big the overlap is.
- **Only one judge in memory.** Runs are evaluated one at a time and each judge is unloaded after use.
- **Status is worked out, not stored.** It always matches the results and reviews.
