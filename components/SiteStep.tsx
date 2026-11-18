import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";

import styles from "./Step.module.css";

// Matches the server's limit (services/site.ts), which also checks the file's content.
const ICON_MAX_BYTES = 256 * 1024;

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });

type Props = { readonly project: Project; readonly hasIcon: boolean };

// The page title and icon of the built app. Saving a built app republishes it without the builder.
export function SiteStep({ project, hasIcon }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const [title, setTitle] = useState(project.pageTitle ?? project.name);
  const [icon, setIcon] = useState<File | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const save = useMutation(
    trpc.projects.setSite.mutationOptions({
      onSuccess: () => {
        setIcon(null);
        setInputKey((key) => key + 1);
      },
      onSettled: () => refresh(),
    })
  );
  // The project name is the default, so saving it stores none and later renames carry over.
  const storedTitle = title.trim() === project.name ? "" : title;
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = icon ? await toBase64(icon) : undefined;
    save.mutate({ id: project.id, title: storedTitle, icon: data });
  };
  const onRemoveIcon = () => save.mutate({ id: project.id, title: storedTitle, icon: null });

  return (
    <section aria-labelledby="site" className={styles.step}>
      <h2 id="site">{copy.project.site.title}</h2>
      <form onSubmit={(event) => void onSubmit(event)} className={styles.form}>
        <p className={styles.muted}>{copy.project.site.intro}</p>
        <label htmlFor="site-title">{copy.project.site.titleLabel}</label>
        <input
          id="site-title"
          type="text"
          maxLength={100}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor="site-icon">{copy.project.site.iconLabel}</label>
        <input
          key={inputKey}
          id="site-icon"
          type="file"
          accept=".png,.ico,image/png,image/x-icon,image/vnd.microsoft.icon"
          aria-invalid={tooBig || undefined}
          aria-describedby={tooBig ? "site-icon-error" : undefined}
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            const big = Boolean(file && file.size > ICON_MAX_BYTES);
            setTooBig(big);
            setIcon(big ? null : file);
            if (big) event.currentTarget.focus();
          }}
        />
        {tooBig && (
          <p id="site-icon-error" className={styles.fieldError}>
            {copy.project.site.iconTooBig}
          </p>
        )}
        <p className={styles.muted}>
          {hasIcon ? copy.project.site.iconSet : copy.project.site.iconNone}
        </p>
        <div className={styles.actions}>
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? copy.project.saving : copy.project.site.save}
          </button>
          {hasIcon && (
            <button type="button" onClick={onRemoveIcon} disabled={save.isPending}>
              {copy.project.site.removeIcon}
            </button>
          )}
          {save.isSuccess && <span className={styles.muted}>{copy.project.site.saved}</span>}
        </div>
        <ErrorNote error={save.error} />
      </form>
    </section>
  );
}
