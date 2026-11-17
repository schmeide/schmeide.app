import { useState } from "react";

import { copy } from "../data/copy";
import { readStored, writeStored } from "../utils/stored";

import styles from "./AppFrame.module.css";

const WIDTHS = {
  phone: { width: 390, height: 700 },
  computer: { width: 1280, height: 800 },
} as const;

type FrameWidth = keyof typeof WIDTHS;

const WIDTH_NAMES = ["phone", "computer"] as const satisfies readonly FrameWidth[];

// Remembered per browser, for every app.
const WIDTH_KEY = "schmeide.preview.width";
const RELOAD_KEY = "schmeide.preview.reloadOnBuild";

const isWidth = (value: unknown): value is FrameWidth => WIDTH_NAMES.some((name) => name === value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

type Props = {
  readonly name: string;
  // The version being worked on, which the frame shows; null for an app live before it had one,
  // which shows the live app.
  readonly stagingUrl: string | null;
  // The live app, null while it is offline.
  readonly liveUrl: string | null;
  // The build that last changed what staging runs; null when the latest build did not.
  readonly version: number | null;
};

export function AppFrame({ name, stagingUrl, liveUrl, version }: Props) {
  const url = stagingUrl ?? liveUrl ?? "";
  const links = [
    { href: stagingUrl, label: copy.project.openStaging },
    { href: liveUrl, label: copy.project.openLive },
  ].flatMap(({ href, label }) => (href === null ? [] : [{ href, label }]));
  const [width, setWidth] = useState(() => readStored(WIDTH_KEY, isWidth, "computer"));
  const [reloadOnBuild, setReloadOnBuild] = useState(() =>
    readStored(RELOAD_KEY, isBoolean, false)
  );
  const [reloads, setReloads] = useState(0);
  // The version in the frame. It starts at the newest, so opening the page never shows the notice;
  // only a build that passes while the page is open makes `version` newer than it.
  const [shown, setShown] = useState(version);
  const newer = version !== null && version !== shown;
  if (newer && reloadOnBuild) setShown(version);
  const reload = () => {
    if (newer) setShown(version);
    setReloads((count) => count + 1);
  };
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
                onChange={() => {
                  setWidth(option);
                  writeStored(WIDTH_KEY, option);
                }}
              />
              {copy.project.designer.width[option]}
            </label>
          ))}
        </fieldset>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={reloadOnBuild}
            onChange={(event) => {
              setReloadOnBuild(event.target.checked);
              writeStored(RELOAD_KEY, event.target.checked);
            }}
          />
          {copy.project.designer.reloadOnBuild}
        </label>
        <button type="button" onClick={reload}>
          {copy.project.designer.reload}
        </button>
        {links.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className={styles.open}
          >
            {link.label} <span className={styles.hint}>{copy.project.opensInNewTab}</span>
          </a>
        ))}
      </div>
      <div className={styles.viewport} data-width={width}>
        {/* Always rendered so the live region exists before the notice is put in it. */}
        <div role="status" className={styles.notice}>
          {newer && !reloadOnBuild && (
            <p>
              {copy.project.designer.newVersion}{" "}
              <button type="button" data-variant="primary" onClick={reload}>
                {copy.project.designer.reloadNew}
              </button>
            </p>
          )}
        </div>
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
