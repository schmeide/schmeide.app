import { createElement, useId } from "react";

import { copy } from "../data/copy";
import type { VersionFeature } from "../trpc";
import { CheckWords } from "./CheckWords";

import styles from "./FeatureResults.module.css";

type Props = {
  readonly features: readonly VersionFeature[];
  // The level of each feature's name, under the heading the list sits in.
  readonly headingLevel: 3 | 4;
  // Starts a change request asking for a fix, with the broken checks written into it. Without it
  // there is no "Ask for a fix".
  readonly onAskForFix?: (request: string) => void;
};

// Which features work in a version (#357): each with "Works" or "Not working yet", and under it
// every check the tester followed, in plain words, with what the tester saw. The checks of a
// feature not working yet are shown; the others' are folded away.
const checks = (feature: VersionFeature) => (
  <ol className={styles.checks}>
    {feature.checks.map((check) => (
      <li key={check.id} className={styles.check} data-verdict={check.verdict}>
        <p className={styles.expect}>{check.expect ?? copy.project.features.unknownCheck}</p>
        <p className={styles.saw}>
          <strong className={styles.verdict}>{copy.project.features.verdict[check.verdict]}</strong>{" "}
          {copy.project.features.saw} {check.saw}
        </p>
        {(check.given || check.steps.length > 0) && (
          <details className={styles.steps}>
            <summary>{copy.project.features.showSteps}</summary>
            <CheckWords given={check.given} steps={check.steps} expect={null} />
          </details>
        )}
      </li>
    ))}
  </ol>
);

export function FeatureResults({ features, headingLevel, onAskForFix }: Props) {
  const id = useId();
  const working = features.filter((feature) => feature.state === "works").length;
  return (
    <>
      <p>{copy.project.features.summary(working, features.length)}</p>
      <ul className={styles.features}>
        {features.map((feature) => {
          const nameId = `${id}-${feature.number}`;
          const broken = feature.checks.filter((check) => check.verdict === "broken");
          return (
            <li key={feature.number} className={styles.feature} data-state={feature.state}>
              <div className={styles.head}>
                {createElement(
                  `h${headingLevel}`,
                  { id: nameId, className: styles.name },
                  feature.name
                )}
                <span className={styles.state}>{copy.project.features.state[feature.state]}</span>
              </div>
              {feature.state === "broken" ? (
                checks(feature)
              ) : (
                <details className={styles.more}>
                  <summary aria-describedby={nameId}>
                    {copy.project.features.showChecks(feature.checks.length)}
                  </summary>
                  {checks(feature)}
                </details>
              )}
              {onAskForFix && broken.length > 0 && (
                <div className={styles.fix}>
                  <button
                    type="button"
                    aria-describedby={`${nameId} ${nameId}-fix`}
                    onClick={() =>
                      onAskForFix(copy.project.features.fixRequest(feature.name, broken))
                    }
                  >
                    {copy.project.features.askForFix}
                  </button>
                  <p id={`${nameId}-fix`} className={styles.hint}>
                    {copy.project.features.askForFixHint}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
