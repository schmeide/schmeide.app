// Measures of one interview transcript, read alongside it: how many questions, how many build on an
// earlier answer, how many raise something the owner had not mentioned, and what it cost.
import type { Owner } from "./owners.ts";

export type Exchange = {
  readonly question: {
    readonly text: string;
    readonly why: string;
    readonly kind: string;
    readonly choices: readonly string[];
  };
  // The answer as the owner gave it, in words.
  readonly answer: string;
  // How long the question took to prepare, and what that model call cost.
  readonly ms: number;
  readonly costUsd: number;
};

export type Metrics = {
  readonly questions: number;
  readonly quotesEarlier: number;
  readonly raisesUnmentioned: number;
  readonly withWhy: number;
  readonly costUsd: number;
  readonly secondsPerQuestion: number;
};

const STOPWORDS = new Set(
  "a an and are as at be but by do does for from have how i if in is it its me my of on or our so that the their them they this to was we what when who will with you your".split(
    " "
  )
);

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

// Runs of three words, leaving out runs made only of filler words.
const trigrams = (text: string): ReadonlySet<string> => {
  const all = words(text);
  return new Set(
    all
      .slice(0, -2)
      .map((_, i) => all.slice(i, i + 3))
      .filter((run) => run.some((word) => !STOPWORDS.has(word)))
      .map((run) => run.join(" "))
  );
};

// ponytail: word overlap stands in for "quotes an earlier answer"; read the transcripts to judge it.
export const quotesEarlier = (question: string, earlierAnswers: readonly string[]): boolean => {
  if (/\byou (said|mentioned|told)\b/i.test(question)) return true;
  const asked = trigrams(question);
  return earlierAnswers.some((answer) => [...trigrams(answer)].some((run) => asked.has(run)));
};

// The blind spots a question raises that the owner had not brought up before it.
export const raisedBlindSpots = (
  owner: Pick<Owner, "need" | "blindSpots">,
  question: Exchange["question"],
  earlierAnswers: readonly string[]
): readonly string[] => {
  const asked = `${question.text} ${question.why}`.toLowerCase();
  const said = [owner.need, ...earlierAnswers].join(" ").toLowerCase();
  return owner.blindSpots
    .filter(({ keywords }) =>
      keywords.some((keyword) => asked.includes(keyword) && !said.includes(keyword))
    )
    .map(({ topic }) => topic);
};

export const measure = (
  owner: Pick<Owner, "need" | "blindSpots">,
  transcript: readonly Exchange[]
): Metrics => {
  const before = (index: number) => transcript.slice(0, index).map((exchange) => exchange.answer);
  const count = (test: (exchange: Exchange, index: number) => boolean) =>
    transcript.filter(test).length;
  const totalMs = transcript.reduce((sum, exchange) => sum + exchange.ms, 0);
  return {
    questions: transcript.length,
    quotesEarlier: count(
      (exchange, index) => index > 0 && quotesEarlier(exchange.question.text, before(index))
    ),
    raisesUnmentioned: count(
      (exchange, index) => raisedBlindSpots(owner, exchange.question, before(index)).length > 0
    ),
    withWhy: count((exchange) => exchange.question.why.trim() !== ""),
    costUsd: transcript.reduce((sum, exchange) => sum + exchange.costUsd, 0),
    secondsPerQuestion: transcript.length ? totalMs / transcript.length / 1000 : 0,
  };
};
