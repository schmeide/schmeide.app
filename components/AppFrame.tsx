import { useState } from "react";

import { copy } from "../data/copy";

import styles from "./AppFrame.module.css";

const WIDTHS = {
  phone: { width: 390, height: 700 },
  computer: { width: 1280, height: 800 },
} as const;

type FrameWidth = keyof typeof WIDTHS;

const WIDTH_NAMES = ["phone", "computer"] as const satisfies readonly FrameWidth[];

type Props = {
  readonly name: string;
  readonly url: string;
  readonly version: number | null;
};

export function AppFrame({ name, url, version }: Props) {
  const [width, setWidth] = useState<FrameWidth>("computer");
  const [reloads, setReloads] = useState(0);
  const [shown, setShown] = useState(version);
  if (version !== null && version !== shown) setShown(version);
  const frameKey = `${url} ${shown ?? "first"} ${reloads}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  return (
    <>
      <div className={styles.toolbar}>
        <fieldset className={styles.width}>
          <legend>{copy.project.designer.widthLabel}</legend>
          {WIDTH_NAMES.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="frame-width"
                value={option}
                checked={width === option}
                onChange={() => setWidth(option)}
              />
              {copy.project.designer.width[option]}
            </label>
          ))}
        </fieldset>
        <button type="button" onClick={() => setReloads((count) => count + 1)}>
          {copy.project.designer.reload}
        </button>
        <a href={url} target="_blank" rel="noreferrer" className={styles.open}>
          {copy.project.open} <span className={styles.hint}>{copy.project.opensInNewTab}</span>
        </a>
      </div>
      <div className={styles.viewport} data-width={width}>
        {loadedKey !== frameKey && (
          <p className={styles.loading}>{copy.project.designer.loading}</p>
        )}
        <iframe
          key={frameKey}
          title={copy.project.designer.frameTitle(name)}
          src={url}
          width={WIDTHS[width].width}
          height={WIDTHS[width].height}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          className={styles.frame}
          onLoad={() => setLoadedKey(frameKey)}
        />
      </div>
      <p className={styles.help}>{copy.project.designer.frameHelp}</p>
    </>
  );
}
