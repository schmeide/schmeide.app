// The look of a project's app, as the person sees and picks it (#159). The design lead's choice
// is made in a build (temporal/activities.ts); here the person reads it and can pick another.
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { projectDesigns } from "../db/schema.ts";
import { designBrief, type DesignChooser } from "./designBrief.ts";
import { STYLES, styleById } from "./designStyles.ts";
import { ConflictError } from "./errors.ts";
import { findProject, requestChange, type Deps } from "./projects.ts";

export type DesignDeps = Deps & {
  // SCHMEIDE_DESIGN_TEAM; absent is off.
  readonly designTeam?: boolean;
};

export const pickLookSchema = z.object({
  id: z.number().int().positive(),
  style: z.enum(STYLES.map((style) => style.id) as [string, ...string[]]),
});

export const LOOKS_OFF = "Picking a look is not turned on yet";

// The change that restyles a built app after the person picks a look. The builder's prompt says
// to keep the look unless the request asks for a change, and this one does.
export const restyleRequest = (style: string): string =>
  `Restyle the app to the ${styleById(style)?.name ?? style} look in the design brief: set the shared stylesheet's tokens to the brief's, restyle the shared pieces (page frame, menu, form, table, button, empty state) to it, and make every screen use them. Keep what every screen does.`;

const briefRow = async (db: Db, projectId: number) =>
  (await db.select().from(projectDesigns).where(eq(projectDesigns.projectId, projectId)))[0];

export type Design = {
  readonly enabled: boolean;
  readonly current: {
    readonly style: string;
    readonly name: string;
    readonly summary: string;
    readonly chosenBy: DesignChooser;
    readonly reason: string;
  } | null;
  readonly styles: readonly {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
  }[];
};

export const getDesign = async (deps: DesignDeps, id: number): Promise<Design> => {
  const row = await briefRow(deps.db, id);
  const style = row && styleById(row.style);
  return {
    enabled: Boolean(deps.designTeam),
    current:
      row && style
        ? {
            style: style.id,
            name: style.name,
            summary: style.summary,
            chosenBy: row.chosenBy,
            reason: row.brief.reason,
          }
        : null,
    styles: STYLES.map(({ id: styleId, name, summary }) => ({ id: styleId, name, summary })),
  };
};

// Stores the person's pick. Before the first build it is only stored, and that build keeps it.
// A built app gets it as a restyle change, started now or queued behind a running build; an app
// built without a brief gets its first one this way, and only this way.
export const pickLook = async (
  deps: DesignDeps,
  input: { readonly id: number; readonly style: string }
): Promise<void> => {
  if (!deps.designTeam) throw new ConflictError(LOOKS_OFF);
  const project = await findProject(deps.db, input.id);
  const current = await briefRow(deps.db, input.id);
  if (current?.style === input.style) return;
  const brief = designBrief(
    { style: input.style, reason: "You picked this look.", screens: current?.brief.screens ?? [] },
    project.brandColors,
    "person"
  );
  await deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const values = { style: brief.style, chosenBy: brief.chosenBy, brief };
    await tx
      .insert(projectDesigns)
      .values({ projectId: input.id, ...values })
      .onConflictDoUpdate({ target: projectDesigns.projectId, set: values });
    const built = !["draft", "spec_generating", "spec_ready"].includes(project.status);
    if (built)
      await requestChange(
        { ...deps, db: tx },
        { id: input.id, request: restyleRequest(input.style) }
      );
  });
};
