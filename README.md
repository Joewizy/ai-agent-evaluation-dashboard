# AI Agent Evaluation Dashboard

Evaluate AI agents and models, whatever they're built with, and see **what failed, the evidence for it, and what to check next**.

The agent being evaluated can use any model (GPT, Claude, Gemini, Llama, your own) and any framework. It sends us a record of what it did, and we score it.

Built for Citi upStart 2026 (agent evaluation track).

## How it works

```
 Any agent ──POST /runs──► store the run ──► metrics ──► diagnosis ──► GET /runs/{id}
 (plain JSON)              never changed      what failed   what the evidence shows,
                                              + evidence    possible explanations
```

1. **The agent sends a finished run** as plain JSON: the question, the answer, the documents it used (`context`), the steps it took, and optionally tokens, cost and time. No SDK or framework needed.
2. **Every metric runs on it.** Each result has a score from 0 to 1, pass or fail, a reason in plain words, and evidence: for example, each claim in the answer and the source sentence it was checked against.
3. **Diagnosis** looks at the failures. It lists what was observed and how we know it (reported by the agent, checked by code, or judged by AI), offers possible explanations with what to check next and who could look, and says so when the evidence can't explain a failure. It never changes the results.
4. **Human review.** A person marks each failed result, and each explanation, as correct, incorrect or inconclusive, then records the action taken. Reviews are stored next to the results, never over them.

`POST /runs` replies straight away (`202`, status `evaluating`); scoring happens in the background, one run at a time. Runs left waiting when the server stopped are evaluated when it starts again.

The full flow, including where each judge is called: [docs/system-flow.md](docs/system-flow.md).

### Status of a run

```
evaluating ─► passed
          ├─► could_not_run   nothing failed, but a metric couldn't run (e.g. judge down): not a pass
          └─► needs_review ─► confirmed ─► resolved   (action recorded)
                          └─► false_alarm             (a person said every failure was wrong)
```

### Endpoints

| Endpoint | What it's for |
|---|---|
| `POST /runs` | An agent sends a finished run. Poll `GET /runs/{id}` every 5–10 s, or add `?wait=true` to get the full result in one call |
| `GET /runs?since=&agent=&status=` | Runs since this morning (default), e.g. `status=needs_review` is the review queue |
| `GET /runs/{id}` | One run's full lineage: run, results, diagnosis, reviews, resolution |
| `POST /runs/{id}/reviews` | `{"target": "metric_result", "metric_id": "groundedness", "verdict": "correct", "reviewer": "sam"}`, or `"target": "explanation", "explanation": 0` |
| `POST /runs/{id}/resolution` | `{"action": "Raised the tool timeout", "resolved_by": "ana"}`, for confirmed failures |
| `GET /metrics` | Each metric's name, description, and whether code or an AI judge checks it |
| `GET /summary?since=&agent=` | Runs by status and agent, each metric's average (skipped runs left out), failures by cause, pending reviews, and how often people agree with the judge and with the explanations |

We only observe. We never block or change what the agent does.

### Two kinds of run

| Mode | When | Extra field |
|---|---|---|
| `live` (default) | Real traffic | none |
| `testing` | Before a release, on questions with known answers | `expected_output` (required) |

## Metrics

Each metric is one YAML file in `backend/app/metrics/`.

| Metric | Checks | How | Runs on |
|---|---|---|---|
| Execution success | Did every step work? | code | both |
| Speed | Time, scored on a slope from target to limit | code | both |
| Cost | Cost, scored on a slope from target to limit | code | both |
| No data leaked | Card numbers, IBANs, emails, phones in the answer | code (with checksums) | both |
| Backed by sources | Is each claim in the answer supported by what the agent looked up (context, tool and search results)? | AI judge | both |
| Correct answer | Does the answer match the answer key? (F1 over claims) | AI judge | testing |

If a metric can't be scored, it's **skipped**, never failed. `skipped_because` says why: `missing_data` (the run didn't include what it needs) or `could_not_run` (for example, the AI judge was down).

### The AI judge

Some metrics need a model to read the answer, for example to check that each claim is backed by the sources. That model is the **judge**. It's separate from the agent being evaluated, and it's swappable: every judge call goes through one function in `app/judge.py`.

- It checks small yes-or-no questions one claim at a time, not one big score.
- Our code checks that every quote the judge gives really appears in the text, so the judge can't make up a source.
- The judge answers by claim number and our code fills in the claim, so it can't reword one. If it skips a claim, the metric is skipped too.
- Our code also flags answers that don't hold together, such as a quote about something else. These count against any explanation resting on that verdict and appear as caveats.
- **Second opinion:** when a failed run's explanation rests on the judge's opinion, a second model (`gemma3:4b`) re-checks just those claims. If one says a claim is supported and the other doesn't, that explanation is set aside. Every re-check is stored. The first judge is unloaded before the second loads, so they're never in memory together.
- Every result records which judge model and prompt version produced it.
- **During development** the judge is a local model run with Ollama (see [Run it](#run-it)). Hosted judges such as Claude or GPT can be added later.

### Adding a metric

Copy a YAML file and change it. No code is needed when an existing check fits:

```yaml
id: tokens
name: Token usage
description: How many tokens the run used.
area: Agent behaviour
method: code
check: within_limit          # an existing check in app/checks.py
modes: [testing, live]
threshold: 0.5
settings: { field: tokens, unit: tokens, label: Used, target: 2000, limit: 8000 }
```

New files are picked up on the next run, with no restart. A new **kind** of check is one Python function in `app/checks.py`.

## Example

```bash
curl -X POST localhost:8000/runs -H 'Content-Type: application/json' -d '{
  "agent_name": "support-bot",
  "input": "How much is a replacement card?",
  "output": "The replacement card costs €25.",
  "context": ["Fee policy: card replacement €10."],
  "latency_ms": 2100
}'
```

It replies with the run id and status `evaluating`. A moment later, `GET /runs/{id}` has the "Backed by sources" result:

```json
{
  "metric_id": "groundedness",
  "score": 0.0,
  "passed": false,
  "reason": "1 of 1 claims aren't backed by the sources. Contradicted: \"The replacement card costs €25.\" (the sources say \"Fee policy: card replacement €10.\").",
  "judge_model": "qwen3:8b"
}
```

**Try it in the browser:** while the server is running, open http://localhost:8000/docs. FastAPI builds this page automatically from the code. It lists every endpoint and data shape, and **Try it out** lets you send a run without curl.

## Run it

**Backend** (Python 3.12):

```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate        # do this in every new terminal
pip install -r requirements.txt
uvicorn app.main:app --reload    # then open http://localhost:8000/docs
pytest                           # tests use a fake judge, so they don't need Ollama
```

**AI judge (optional, for development).** Two metrics, "Backed by sources" and "Correct answer", need a judge model. We currently use a local one through [Ollama](https://ollama.com):

```bash
ollama pull qwen3:8b     # default judge, about 5 GB
ollama pull gemma3:4b    # second opinion, about 3.4 GB
```

- **No second opinion:** start the server with `SECOND_JUDGE_MODEL= uvicorn app.main:app --reload` (empty turns it off). Without `gemma3:4b` pulled, runs still work; the diagnosis says the second opinion couldn't run.

- **Without it, everything else still works.** Those two metrics are skipped with the reason "couldn't reach Ollama" (`could_not_run`), never marked as passed.
- **Different model:** start the server with `JUDGE_MODEL=llama3.2 uvicorn app.main:app --reload`. Smaller models are faster but less reliable judges.
- **Someone else's Ollama:** start the server with `OLLAMA_URL=http://<their-ip>:11434 uvicorn app.main:app --reload`. Run data is sent to their machine, so only do this on a network you trust.

**Dashboard** (Next.js 16, Tailwind 4):

```bash
cd frontend
npm install
npm run dev                       # http://localhost:3000, with the backend running on :8000
```

- **Today** (`/`): runs since midnight, failures by possible cause, actions taken, checks, reviewer agreement, by agent. Refreshes every 5 s while open.
- **Runs** (`/runs?status=needs_review&agent=`): the review queue and every other status.
- **One run** (`/runs/{id}`): the full lineage, from question to possible explanations, with the review pinned beside it. Refreshes only while the run is being scored.
- The browser calls `/api/*`, which Next.js forwards to the backend (`BACKEND_URL`, default `http://localhost:8000`). Status always comes from the API; the dashboard never works it out itself.

## Project layout

```
backend/
  app/
    main.py            API endpoints
    schemas.py         every data shape (Run, Metric, MetricResult, Diagnosis)
    evaluate.py        loads the metric files and runs them
    checks.py          the Python behind each kind of check
    judge.py           talks to the judge model (one place to swap it)
    personal_data.py   finds and masks card numbers, IBANs, emails, phones
    evidence.py        turns a run and its results into observations
    judge_checks.py    plain-code checks on the judge's own answers
    second_opinion.py  a second model re-checks the claims an explanation rests on
    diagnose.py        possible explanations, what to check, and the outcome
    review.py          run status, the review rules and the summary
    storage.py         SQLite (nothing is ever updated, only added)
    metrics/           one YAML file per metric
  tests/
frontend/
  src/app/             routes: / (Today), /runs, /runs/[id]
  src/components/      the screens and shared pieces (status chips, evidence badges)
  src/lib/             typed API client, labels, polling hook
scripts/compare/       the same sample run evaluated with DeepEval and Arize Phoenix, for comparison
```
