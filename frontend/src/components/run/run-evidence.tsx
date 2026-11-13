"use client";

import { type ReactNode, useState } from "react";
import type { Evidence as EvidenceItem, MetricInfo, MetricResult, Observation, Ref, RunReport, SecondOpinion } from "@/lib/api";
import { CLAIM_VERDICT, type ClaimLook, claimLook, INSTRUCTIONS_SOURCE, judgeVerdictLabel, metricName, patternLabel } from "@/lib/labels";
import { isLimit, readableMs } from "@/lib/metrics";
import { shorten } from "@/lib/run-text";
import { BasisBadge, CodeBadge, Icon, JudgeBadge, RecordedBadge } from "../ui";
import { Section } from "./section";

// ---------- Grouping observations by claim ----------

type Verdict = EvidenceItem["verdict"];

/** One claim the judge checked, with what our code found about the quote it used. */
interface ClaimObservations {
  main: Observation;
  quote?: Observation;
  problems: Observation[];
  evidence?: EvidenceItem;
  text: string;
  verdict: Verdict;
  metric: string;
}

interface ClaimGroup {
  metric: string;
  claims: ClaimObservations[];
}

const CLAIM_ID = /^(.+)-claim-(\d+)$/;
const ISSUES_FIRST: Record<Verdict, number> = { failed: 0, key_contradicted: 0, missing: 1, left_out: 1, passed: 2 };
const REFERENCE: Record<string, string> = { groundedness: "the sources", correctness: "the answer key", "key-facts": "the sources" };
const GROUP_TITLE: Record<string, string> = {
  groundedness: "Claims in the answer, checked against the sources",
  correctness: "Claims in the answer, checked against the answer key",
  "key-facts": "Answer key facts, checked against what the agent looked up",
};

/** A short description of the judge's procedure for each metric, shown above its claim list. */
const HOW_IT_WORKS: Record<string, (n: number) => string> = {
  groundedness: (n) =>
    `The AI judge rewrote the answer as ${n} short claim${n === 1 ? "" : "s"} and looked for each one in the sources. ` +
    "Where it calls a claim backed or contradicted it must quote the source, and our code then checks that the quote really exists. " +
    "The verdict itself is the judge’s opinion.",
  correctness: (n) =>
    `The AI judge rewrote the answer as ${n} short claim${n === 1 ? "" : "s"} and compared each one with the answer key, quoting the key where it could. ` +
    "Our code checks that each quote really is in the key. The verdict itself is the judge’s opinion.",
  "key-facts": (n) =>
    `The answer missed facts from the answer key, so the AI judge looked for ${n === 1 ? "that fact" : `those ${n} facts`} in what the agent looked up.`,
};

/** Claim observations ("<metric>-claim-<n>") collect their quote check and problems; the rest are plain facts. */
function groupObservations(observations: Observation[], results: MetricResult[]) {
  const facts: Observation[] = [];
  const groups: ClaimGroup[] = [];
  const byId = new Map<string, ClaimObservations>();
  for (const o of observations) {
    const match = CLAIM_ID.exec(o.id);
    if (match) {
      const [, metric, number] = match;
      let group = groups.find((g) => g.metric === metric);
      if (!group) {
        group = { metric, claims: [] };
        groups.push(group);
      }
      const evidence = results.find((r) => r.metric_id === metric)?.evidence[Number(number) - 1];
      const parsed = parseClaim(o.text);
      const claim: ClaimObservations = {
        main: o,
        problems: [],
        evidence,
        text: evidence?.item ?? parsed.text,
        verdict: evidence?.verdict ?? parsed.verdict,
        metric,
      };
      group.claims.push(claim);
      byId.set(o.id, claim);
      continue;
    }
    const owner = [...byId.keys()].find((id) => o.id.startsWith(`${id}-`));
    const claim = owner ? byId.get(owner) : undefined;
    if (!claim) facts.push(o);
    else if (o.id.endsWith("-quote-found") || o.id.endsWith("-quote-not-found")) claim.quote = o;
    else claim.problems.push(o);
  }
  for (const group of groups) group.claims.sort((a, b) => ISSUES_FIRST[a.verdict] - ISSUES_FIRST[b.verdict]);
  return { facts, groups, byId };
}

/** For claims with no stored evidence (the answer key's facts): read the claim and verdict from the sentence. */
function parseClaim(text: string): { text: string; verdict: Verdict } {
  const found = /"(.+)" (supported by|contradicted by|not mentioned in|left out of)/.exec(text);
  if (!found) return { text, verdict: "missing" };
  if (text.endsWith("contradicted by the answer.")) return { text: found[1], verdict: "key_contradicted" };
  const verdict = ({ "supported by": "passed", "contradicted by": "failed", "not mentioned in": "missing", "left out of": "left_out" } as const)[
    found[2] as "supported by"
  ];
  return { text: found[1], verdict };
}

function countVerdicts(claims: ClaimObservations[]): string {
  const backed = claims.filter((c) => c.verdict === "passed").length;
  const against = claims.filter((c) => c.verdict === "failed" || c.verdict === "key_contradicted").length;
  const missing = claims.length - backed - against;
  return [
    `${claims.length} checked`,
    backed ? `${backed} backed` : null,
    against ? `${against} contradicted` : null,
    missing ? `${missing} not found` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function verdictLook(metric: string, claim: ClaimObservations): ClaimLook {
  const reference = REFERENCE[metric] ?? "the sources";
  switch (claim.verdict) {
    case "passed":
      return claim.evidence?.found_in === INSTRUCTIONS_SOURCE
        ? claimLook({ verdict: "passed", found_in: INSTRUCTIONS_SOURCE })
        : { ...CLAIM_VERDICT.passed, label: `Supported by ${reference}` };
    case "failed":
      return { ...CLAIM_VERDICT.failed, label: `Contradicts ${reference}` };
    case "key_contradicted":
      return { ...CLAIM_VERDICT.failed, label: "The answer says otherwise" };
    case "left_out":
      return { ...CLAIM_VERDICT.missing, label: "Left out of the answer" };
    default:
      return { ...CLAIM_VERDICT.missing, label: `Not in ${reference}` };
  }
}

function placeName(ref: Ref | undefined): string {
  if (!ref) return "the sources";
  if (ref.kind === "instructions") return "the agent’s instructions";
  if (ref.kind === "context") return `Context ${ref.id}`;
  if (ref.kind === "step") return `${ref.detail ?? "a step"} · ${ref.id}`;
  return "the answer key";
}

// ---------- One line each for what the judge said and what the code found ----------

export type Tone = "ok" | "weak" | "bad" | "warn";

/** What our code found about the quote the judge gave, in one sentence. */
export function quoteCheck(observation: Observation, reference: string): { tone: Tone; text: string } {
  if (observation.id.endsWith("-quote-not-found")) {
    return { tone: "bad", text: `The quote isn’t in ${reference}. The judge may have made it up.` };
  }
  // Runs diagnosed before `match` was stored say "reworded" or "as one record" in the text.
  const reworded = (observation.match ?? (/reworded|as one record/.test(observation.text) ? "record" : "exact")) === "record";
  const where = placeName(observation.refs[1]);
  return reworded
    ? { tone: "weak", text: `The quote is in ${where}, but not in these words: the judge reworded it, and the names and numbers match. Weaker than word for word.` }
    : { tone: "ok", text: `The quote is in ${where}, word for word.` };
}

const TONE_ICON: Record<Tone, ReactNode> = {
  ok: (
    <span className="text-s-pass">
      <Icon.Check size={13} />
    </span>
  ),
  weak: (
    <span className="text-ink-3">
      <Icon.Check size={13} />
    </span>
  ),
  bad: (
    <span className="text-s-conf">
      <Icon.Warning />
    </span>
  ),
  warn: (
    <span className="text-s-need-fg">
      <Icon.Warning />
    </span>
  ),
};

/** Who is speaking on a line: the AI judge (an opinion), a second judge re-checking it, or our code (a check). */
function Who({ who, second = false }: { who: "judge" | "code"; second?: boolean }) {
  return who === "judge" ? (
    <span className="inline-flex h-[22px] flex-none items-center gap-1 rounded border border-dashed border-ink-3 px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-ink-2">
      <Icon.Speech />
      {second ? "Second AI judge" : "AI judge"}
    </span>
  ) : (
    <span className="inline-flex h-[22px] flex-none items-center rounded bg-ink px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-canvas">Code</span>
  );
}

function Line({
  id,
  who,
  second,
  tone,
  tag,
  points,
  mark,
  children,
}: {
  id?: string;
  who: "judge" | "code";
  second?: boolean;
  tone?: Tone;
  tag: (id: string | undefined) => ReactNode;
  points: (id: string) => ReactNode;
  mark: (id: string) => string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-md px-1 py-1 ${id ? mark(id) : ""}`}>
      {tag(id)}
      <Who who={who} second={second} />
      <span className="min-w-0 flex-[1_1_260px] text-[13px] leading-normal text-ink-2">
        {tone ? <span className="mr-1.5 inline-flex align-[-2px]">{TONE_ICON[tone]}</span> : null}
        {children}
      </span>
      {id ? points(id) : null}
    </div>
  );
}

function ClaimCard({
  claim,
  second,
  tag,
  points,
  mark,
}: {
  claim: ClaimObservations;
  second?: SecondOpinion;
  tag: (id: string | undefined) => ReactNode;
  points: (id: string) => ReactNode;
  mark: (id: string) => string;
}) {
  const look = verdictLook(claim.metric, claim);
  const reference = REFERENCE[claim.metric] ?? "the sources";
  const quote = claim.evidence?.source ?? (claim.quote ? /quote "(.+)" (?:is in|appears in|was not found)/.exec(claim.quote.text)?.[1] : undefined);
  const checkedAgainstText = claim.verdict === "passed" || claim.verdict === "failed" || claim.verdict === "missing";
  const check = claim.quote ? quoteCheck(claim.quote, reference) : null;
  return (
    <li className={`flex flex-col gap-1 rounded-lg border px-2 py-2 ${claim.verdict === "passed" ? "border-line-2" : "border-line"}`}>
      <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1.5 rounded-md px-1 py-1 ${mark(claim.main.id)}`}>
        {tag(claim.main.id)}
        <span className="min-w-0 flex-[1_1_280px] text-sm leading-normal font-medium">“{claim.text}”</span>
        <span
          className="inline-flex h-6 flex-none items-center rounded-full px-[9px] text-xs font-semibold"
          style={{ background: look.bg, color: look.fg, boxShadow: `inset 0 -2px 0 ${look.line}` }}
        >
          {look.label}
        </span>
        {points(claim.main.id)}
      </div>
      {quote ? (
        <Line who="judge" tag={tag} points={points} mark={mark}>
          Quoted: <span className="text-ink">“{shorten(quote, 240)}”</span>
        </Line>
      ) : checkedAgainstText ? (
        <Line who="judge" tag={tag} points={points} mark={mark}>
          {claim.verdict === "missing" ? `Found nothing about this in ${reference}, so there is no quote.` : "Gave no quote."}
        </Line>
      ) : null}
      {claim.quote && check ? (
        <Line id={claim.quote.id} who="code" tone={check.tone} tag={tag} points={points} mark={mark}>
          {check.text}
        </Line>
      ) : null}
      {claim.problems.map((p) => (
        <Line key={p.id} id={p.id} who="code" tone="warn" tag={tag} points={points} mark={mark}>
          {p.text}
        </Line>
      ))}
      {second ? (
        <Line who="judge" second tag={tag} points={points} mark={mark}>
          Re-checked this claim and {second.agreed ? "agrees" : "disagrees"}: {judgeVerdictLabel(second.verdict)}.
        </Line>
      ) : null}
    </li>
  );
}

// ---------- Describing the observations an explanation rests on ----------

interface BasisLine {
  text: string;
  ids: string[];
}

/** "4 claims the judge found not in the sources." One sentence for a set of claims with the same verdict. */
function claimPhrase(claims: ClaimObservations[]): string {
  const { metric, verdict } = claims[0];
  const reference = REFERENCE[metric] ?? "the sources";
  const fact = metric === "key-facts" || verdict === "left_out" || verdict === "key_contradicted";
  const what: Record<Verdict, string> = {
    passed: `supported by ${reference}`,
    failed: `contradicted by ${reference}`,
    missing: `not in ${reference}`,
    left_out: "left out of the answer",
    key_contradicted: "contradicted by the answer",
  };
  if (claims.length === 1) {
    return `The judge found ${fact ? "the answer key’s fact" : "the claim"} “${shorten(claims[0].text, 90)}” ${what[verdict]}.`;
  }
  return `${claims.length} ${fact ? "answer key facts" : "claims"} the judge found ${what[verdict]}.`;
}

/** The observations behind an explanation, folded into a few plain sentences, each with the ids it stands for. */
function basisLines(ids: string[], observations: Observation[], byId: Map<string, ClaimObservations>): BasisLine[] {
  const lines: BasisLine[] = [];
  const claims = new Map<string, ClaimObservations[]>();
  const found: string[] = [];
  const notFound: string[] = [];
  const rest: string[] = [];
  for (const id of ids) {
    const claim = byId.get(id);
    if (claim) {
      const key = `${claim.metric}|${claim.verdict}`;
      claims.set(key, [...(claims.get(key) ?? []), claim]);
    } else if (id.endsWith("-quote-found")) found.push(id);
    else if (id.endsWith("-quote-not-found")) notFound.push(id);
    else rest.push(id);
  }
  for (const group of claims.values()) lines.push({ text: claimPhrase(group), ids: group.map((c) => c.main.id) });
  if (found.length) {
    lines.push({
      text: found.length === 1 ? "Our code confirmed the judge’s quote is really in the sources." : `Our code confirmed ${found.length} of the judge’s quotes are really in the sources.`,
      ids: found,
    });
  }
  if (notFound.length) {
    lines.push({
      text:
        notFound.length === 1
          ? "Our code couldn’t find the judge’s quote, so the judge may have made it up."
          : `Our code couldn’t find ${notFound.length} of the judge’s quotes, so the judge may have made them up.`,
      ids: notFound,
    });
  }
  for (const id of rest) {
    const o = observations.find((x) => x.id === id);
    lines.push({ text: o ? (id.includes("-problem-") ? `Our code saw a problem with the judge’s answer: ${o.text}` : o.text) : id, ids: [id] });
  }
  return lines;
}

/**
 * Caveats come from the backend with metric ids in quotes and one "Judge check:" line per problem our code
 * caught in the judge's answer. Metric ids become names, and the judge problems (already shown line by line
 * under What we observed) fold into a count.
 */
function plainCaveats(caveats: string[], metrics?: MetricInfo[]): string[] {
  const judge = caveats.filter((c) => c.startsWith("Judge check: "));
  const quotesMissing = judge.filter((c) => / was not found in /.test(c)).length;
  const otherProblems = judge.length - quotesMissing;
  const lines = caveats
    .filter((c) => !c.startsWith("Judge check: "))
    .map((c) =>
      c
        .replace(/^'([a-z_]+)' skipped, missing data: /, (_, id: string) => `${metricName(id, metrics)} wasn’t checked: `)
        .replace(/^'([a-z_]+)' couldn't run: /, (_, id: string) => `${metricName(id, metrics)} couldn’t run: `),
    );
  if (quotesMissing) {
    lines.push(
      `Our code couldn’t find ${quotesMissing === 1 ? "one of the judge’s quotes" : `${quotesMissing} of the judge’s quotes`} in the sources, so ${
        quotesMissing === 1 ? "that verdict is" : "those verdicts are"
      } doubtful. Each is marked under What we observed.`,
    );
  }
  if (otherProblems) {
    lines.push(`Our code saw ${otherProblems === 1 ? "a problem" : `${otherProblems} problems`} with the judge’s answers, marked under What we observed.`);
  }
  return lines;
}

/** Long quoted claims inside a "how to check" line are shortened, so the list stays scannable. */
function shortenQuotes(text: string): string {
  return text.replace(/"([^"]{80,})"/g, (_, quoted: string) => `"${shorten(quoted, 70)}"`);
}

function Group({ title, sub, note, children }: { title: string; sub?: ReactNode; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 border-b border-line-2 px-[18px] py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <h3 className="m-0 text-[14.5px] font-semibold">{title}</h3>
        {sub ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">{sub}</div> : null}
      </div>
      {note ? <p className="m-0 max-w-[80ch] text-[13px] leading-normal text-ink-2">{note}</p> : null}
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="m-0 text-xs font-semibold text-ink-3 sm:pt-[3px]">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

/** Sections 2 and 3: what we observed, and the possible explanations that rest on it. */
export function Evidence({ report, failed, metrics }: { report: RunReport; failed: boolean; metrics?: MetricInfo[] }) {
  const diagnosis = report.diagnosis;
  const observations = diagnosis?.observations ?? [];
  const explanations = diagnosis?.explanations ?? [];
  const [shown, setShown] = useState<number | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [backedOpen, setBackedOpen] = useState<Record<string, boolean>>({});

  // Observations get short labels (#1, #2…) in the order the diagnosis lists them.
  const label = new Map(observations.map((o, i) => [o.id, `#${i + 1}`]));
  const highlighted = shown === null ? null : explanations[shown];
  const { facts, groups, byId } = groupObservations(observations, report.results);
  const secondOpinions = diagnosis?.second_opinions ?? [];
  const inlined = new Set<SecondOpinion>();

  // Selecting "Show in evidence" lights up what supports (accent) or weakens (amber) that possibility.
  const mark = (id: string) =>
    highlighted?.supported_by.includes(id)
      ? "bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]"
      : highlighted?.weakened_by.includes(id)
        ? "bg-s-need-bg shadow-[inset_0_0_0_1.5px_var(--s-need)]"
        : "";
  const tag = (id: string | undefined) => <span className="mono w-7 flex-none text-xs text-ink-3">{id ? label.get(id) : ""}</span>;
  const points = (id: string) => {
    const supports = highlighted?.supported_by.includes(id);
    if (!supports && !highlighted?.weakened_by.includes(id)) return null;
    return (
      <span className={`text-xs font-semibold whitespace-nowrap ${supports ? "text-accent" : "text-s-need-fg"}`}>
        {supports ? "Supports" : "Weakens"} possibility {(shown ?? 0) + 1}
      </span>
    );
  };

  const toggle = (i: number) => {
    const next = shown === i ? null : i;
    setShown(next);
    if (next !== null) document.getElementById("sec-observed")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const couldNotRun = report.results.filter((r) => r.skipped_because === "could_not_run").map((r) => metricName(r.metric_id, metrics));
  // When only limit checks (time, cost) were breached there is no failure to explain: the measurement is the whole story.
  const failedResults = report.results.filter((r) => r.passed === false);
  const onlyLimits = failedResults.length > 0 && failedResults.every(isLimit);
  const limitNames = failedResults.map((r) => metricName(r.metric_id, metrics)).join(", ");

  return (
    <>
      <Section n={2} id="sec-observed" title="What we observed">
        <div className="rounded-[4px] border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-x-[22px] gap-y-2 border-b border-line-2 px-[18px] py-3.5 text-[12.5px] text-ink-3">
            <span className="text-[13.5px] text-ink-2">Each line says how we know it:</span>
            <span className="inline-flex items-center gap-2">
              <RecordedBadge />
              the agent reported it
            </span>
            <span className="inline-flex items-center gap-2">
              <CodeBadge label="Code" />
              our code checked it
            </span>
            <span className="inline-flex items-center gap-2">
              <JudgeBadge />
              an opinion that could be wrong
            </span>
          </div>

          {observations.length === 0 ? <p className="m-0 px-[18px] py-3.5 text-sm text-ink-3">No observations.</p> : null}

          {facts.length > 0 ? (
            <Group title="From the run and our checks">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {facts.map((o) => (
                  <li key={o.id} className={`flex flex-wrap items-baseline gap-x-3 gap-y-1.5 rounded-lg px-2.5 py-2 ${mark(o.id)}`}>
                    {tag(o.id)}
                    <BasisBadge basis={o.basis} />
                    <span className="min-w-0 flex-[1_1_320px] text-sm leading-normal">{readableMs(o.text)}</span>
                    {points(o.id)}
                  </li>
                ))}
              </ul>
            </Group>
          ) : null}

          {groups.map((group) => {
            const counts = countVerdicts(group.claims);
            // Backed claims fold away unless the selected possibility rests on one of them.
            const mentioned = (c: ClaimObservations) =>
              !!highlighted &&
              [c.main.id, c.quote?.id ?? "", ...c.problems.map((p) => p.id)].some((id) => highlighted.supported_by.includes(id) || highlighted.weakened_by.includes(id));
            const issues = group.claims.filter((c) => c.verdict !== "passed" || mentioned(c));
            const backed = group.claims.filter((c) => !issues.includes(c));
            const open = !!backedOpen[group.metric];
            const secondFor = (c: ClaimObservations) => {
              const s = secondOpinions.find((o) => o.claim === c.text);
              if (s) inlined.add(s);
              return s;
            };
            return (
              <Group
                key={group.metric}
                title={GROUP_TITLE[group.metric] ?? `Claims checked for ${metricName(group.metric, metrics)}`}
                sub={<span>{counts}</span>}
                note={HOW_IT_WORKS[group.metric]?.(group.claims.length)}
              >
                {issues.length > 0 || open ? (
                  <ol className="m-0 flex list-none flex-col gap-2 p-0">
                    {[...issues, ...(open ? backed : [])].map((c) => (
                      <ClaimCard key={c.main.id} claim={c} second={secondFor(c)} tag={tag} points={points} mark={mark} />
                    ))}
                  </ol>
                ) : (
                  <p className="m-0 text-[13px] text-ink-3">Every claim was supported.</p>
                )}
                {backed.length > 0 ? (
                  <button
                    onClick={() => setBackedOpen((s) => ({ ...s, [group.metric]: !open }))}
                    aria-expanded={open}
                    className="h-9 self-start rounded-lg border border-line px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2"
                  >
                    {open ? "Hide" : "Show"} {backed.length} supported claim{backed.length === 1 ? "" : "s"}
                  </button>
                ) : null}
              </Group>
            );
          })}

          {secondOpinions.some((s) => !inlined.has(s)) ? (
            <div className="flex flex-col gap-2 border-t border-line-2 px-[18px] py-3.5">
              <span className="text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase">Second opinion</span>
              {secondOpinions
                .filter((s) => !inlined.has(s))
                .map((s, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13.5px]">
                    <span className="text-ink-2">Claim “{s.claim}”</span>
                    <span>
                      First judge: <strong>{judgeVerdictLabel(s.original_verdict)}</strong>
                    </span>
                    <span aria-hidden="true" className="text-ink-3">
                      ·
                    </span>
                    <span>
                      Second judge: <strong>{judgeVerdictLabel(s.verdict)}</strong>
                    </span>
                    {s.agreed ? (
                      <span className="inline-flex h-6 items-center gap-[5px] rounded-full border border-line px-[9px] text-[12.5px] font-semibold">
                        <Icon.Check size={13} />
                        Agree
                      </span>
                    ) : (
                      <span className="inline-flex h-6 items-center gap-[5px] rounded-full bg-s-need-bg px-[9px] text-[12.5px] font-semibold text-s-need-fg">
                        <Icon.Cross />
                        Disagree
                      </span>
                    )}
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      </Section>

      <Section n={3} id="sec-explain" title="Possible explanations" last>
        <div className="flex flex-col gap-3">
          {explanations.length > 0 ? (
            <p className="m-0 text-[13.5px] text-ink-2">Possibilities, not a verdict. Each says what it rests on, what counts against it, and how to check.</p>
          ) : null}
          {explanations.map((e, i) => {
            const on = shown === i;
            const chip = (id: string, kind: "sup" | "weak") => (
              <button
                key={id}
                onClick={() => toggle(i)}
                title="Show in What we observed"
                className={`mono h-[22px] min-w-8 rounded border px-1.5 text-[11.5px] font-medium ${
                  kind === "weak" ? "border-dashed border-s-need text-s-need-fg" : "border-accent text-accent"
                } ${on ? (kind === "weak" ? "bg-s-need-bg" : "bg-accent-soft") : "bg-surface"}`}
              >
                {label.get(id) ?? id}
              </button>
            );
            const basis = (ids: string[], kind: "sup" | "weak") => {
              const lines = basisLines(ids, observations, byId);
              if (lines.length === 0) return <span className="text-[13.5px] text-ink-3">Nothing found against it.</span>;
              return (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {lines.map((line, j) => (
                    <li key={j} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13.5px] leading-normal">
                      <span>{line.text}</span>
                      <span className="inline-flex flex-wrap gap-1">{line.ids.map((id) => chip(id, kind))}</span>
                    </li>
                  ))}
                </ul>
              );
            };
            return (
              <article key={i} className={`m-0 rounded-[4px] border bg-surface px-5 py-[18px] ${on ? "border-accent" : "border-line"}`}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-xs font-semibold text-ink-3">Possibility {i + 1}</span>
                    <span className="inline-flex h-[22px] items-center rounded bg-surface-2 px-2 text-xs font-medium text-ink-2">{patternLabel(e.pattern)}</span>
                  </div>
                  <button
                    onClick={() => toggle(i)}
                    aria-pressed={on}
                    className={`h-9 rounded-lg border px-3 text-[13px] font-medium hover:bg-surface-2 ${on ? "border-accent text-accent" : "border-line text-ink-2"}`}
                  >
                    {on ? "Hide in evidence" : "Show in evidence"}
                  </button>
                </div>
                <h3 className="mt-2.5 mb-3.5 text-[17px] leading-[1.4] font-semibold">{e.summary}</h3>
                <dl className="m-0 grid gap-x-4 gap-y-2.5 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:112px_minmax(0,1fr)]">
                  <Row label="Rests on">{basis(e.supported_by, "sup")}</Row>
                  <Row label="Against it">{basis(e.weakened_by, "weak")}</Row>
                  <Row label="Who could look">
                    <span className="text-[13.5px] leading-normal">{e.who_could_look ?? "—"}</span>
                  </Row>
                </dl>
                {e.how_to_check.length > 0 ? (
                  <div className="mt-3.5 border-t border-line-2 pt-3">
                    <span className="text-xs font-semibold text-ink-3">How to check</span>
                    <ul className="mt-1 mb-0 flex list-none flex-col p-0">
                      {e.how_to_check.map((text, j) => {
                        const key = `${i}:${j}`;
                        const done = !!checked[key];
                        const id = `check-${i}-${j}`;
                        return (
                          <li key={key} className="flex items-start gap-2.5 py-[5px]">
                            <input
                              type="checkbox"
                              id={id}
                              checked={done}
                              onChange={() => setChecked((c) => ({ ...c, [key]: !c[key] }))}
                              className="mt-px size-[18px] flex-none accent-[var(--accent)]"
                            />
                            <label htmlFor={id} title={text} className={`cursor-pointer text-sm leading-[1.45] ${done ? "text-ink-3 line-through" : "text-ink"}`}>
                              {shortenQuotes(text)}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </article>
            );
          })}

          {failed && explanations.length === 0 && onlyLimits ? (
            <div className="flex flex-col gap-2.5 rounded-[4px] border border-line bg-surface p-5">
              <div className="flex items-center gap-2.5">
                <Icon.Info />
                <h3 className="m-0 text-[17px] font-semibold">Nothing to explain</h3>
              </div>
              <p className="m-0 text-sm leading-[1.55] text-ink-2">
                {limitNames} {failedResults.length === 1 ? "is" : "are"} over the limit and no other check failed. The measurement at the top of the page is the
                whole story: what to do about it is a decision, not a diagnosis.
              </p>
            </div>
          ) : failed && explanations.length === 0 ? (
            <div className="flex flex-col gap-2.5 rounded-[4px] border border-line bg-surface p-5">
              <div className="flex items-center gap-2.5">
                <Icon.Question />
                <h3 className="m-0 text-[17px] font-semibold">The evidence doesn’t explain this failure</h3>
              </div>
              <p className="m-0 text-sm leading-[1.55] text-ink-2">
                Nothing we observed points to a cause, so we won’t guess. What we do know is listed above.
              </p>
            </div>
          ) : null}

          {!failed ? (
            <div className="rounded-[4px] border border-line bg-surface px-[18px] py-4 text-sm leading-[1.55] text-ink-2">
              {couldNotRun.length > 0
                ? `Nothing failed, but “${couldNotRun.join("”, “")}” couldn’t run, so this run isn’t a pass either. There is nothing to explain or review.`
                : "Nothing failed, so there is nothing to explain."}
            </div>
          ) : null}

          {diagnosis && diagnosis.caveats.length > 0 ? (
            <div className="rounded-[4px] border border-line bg-surface-2 px-[18px] py-3.5">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                <Icon.Info />
                Also note
              </div>
              <ul className="mt-2 mb-0 flex flex-col gap-1 pl-[22px] text-[13.5px] leading-[1.55] text-ink-2">
                {plainCaveats(diagnosis.caveats, metrics).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Section>
    </>
  );
}
