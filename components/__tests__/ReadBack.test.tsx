import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { ReadBack } from "../../trpc";
import { ProjectPage } from "../ProjectPage";
import {
  anInterview,
  anItem,
  ApiFailure,
  aProject,
  aQuestion,
  aReadBack,
  projectServer,
  renderWithApi,
} from "./fakeApi";

const DONE = anInterview({
  finished: true,
  questions: [aQuestion({ answer: { type: "you_decide" }, answeredAt: new Date() })],
  items: [anItem()],
});

// A project whose interview is done, on its way to the read-back.
const setup = (readBack: ReadBack | null, handlers: Parameters<typeof renderWithApi>[1] = {}) => {
  const state = { project: aProject(), interview: DONE, readBack: readBack ?? undefined };
  const calls = renderWithApi(<ProjectPage id={7} />, {
    ...projectServer(state),
    ...(readBack === null ? { "readBack.get": () => aReadBack({ account: null }) } : {}),
    ...handlers,
  });
  return { state, calls };
};

const openReadBack = async () =>
  userEvent.click(await screen.findByRole("button", { name: copy.readBack.open }));

describe("ReadBack", () => {
  it("says back the business and how a piece of work goes, then writes the spec when it is right", async () => {
    const { state, calls } = setup(aReadBack(), {
      "projects.generateSpec": () => {
        state.project = aProject({ status: "spec_generating" });
        return state.project;
      },
    });
    await openReadBack();

    expect(
      await screen.findByRole("heading", { level: 2, name: copy.readBack.title })
    ).toBeVisible();
    expect(screen.getByText("You run a cleaning company.")).toBeVisible();
    const steps = within(screen.getByRole("list", { name: copy.readBack.stepsTitle }));
    expect(steps.getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      expect.stringContaining("A client calls."),
      expect.stringContaining("You send the invoice from your phone."),
    ]);
    expect(calls.map((call) => call.path)).not.toContain("projects.generateSpec");

    await userEvent.click(screen.getByRole("button", { name: copy.readBack.confirm }));

    expect(await screen.findByText(copy.project.specWriting)).toBeInTheDocument();
    expect(calls).toContainEqual({ path: "projects.generateSpec", input: { id: 7 } });
  });

  it("writes the account when there is none yet", async () => {
    const { calls } = setup(null, { "readBack.write": () => aReadBack() });
    await openReadBack();

    expect(await screen.findByText("A client calls.")).toBeVisible();
    expect(calls).toContainEqual({ path: "readBack.write", input: { id: 7 } });
  });

  it("asks one question about a sentence marked wrong, and shows the account written again", async () => {
    const { calls } = setup(aReadBack(), {
      "readBack.correct": () =>
        aReadBack({
          account: {
            business: aReadBack().account?.business ?? [],
            steps: [{ text: "A client emails you.", ask: "How do jobs start?" }],
          },
        }),
    });
    await openReadBack();
    const step = (await screen.findByText("A client calls.")).closest("li");
    if (!step) throw new Error("no step");

    await userEvent.click(within(step).getByRole("button", { name: copy.readBack.notRight }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "How does a job usually start?" }),
      "Clients email me"
    );
    await userEvent.click(screen.getByRole("button", { name: copy.readBack.send }));

    expect(await screen.findByText("A client emails you.")).toBeVisible();
    expect(calls).toContainEqual({
      path: "readBack.correct",
      input: { id: 7, target: { part: "steps", index: 0 }, answer: "Clients email me" },
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("lists what Schmeide chose with a way to change it, what is open, and what waits", async () => {
    const { calls } = setup(
      aReadBack({
        chosen: [anItem({ id: 31, text: "Prices per room", source: "schmeide" })],
        open: [anItem({ id: 32, text: "Invoices are due in 30 days", open: true })],
        later: [anItem({ id: 33, text: "Online booking", phase: "later" })],
      }),
      { "interview.updateItem": () => anItem({ id: 31, text: "Prices per hour" }) }
    );
    await openReadBack();

    const chosen = await screen.findByRole("region", { name: copy.readBack.chosenTitle });
    const open = screen.getByRole("region", { name: copy.readBack.openTitle });
    expect(within(open).getByText("Invoices are due in 30 days")).toBeVisible();
    expect(screen.getByText(copy.readBack.openLeft(1))).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: copy.readBack.laterTitle })).getByText(
        "Online booking"
      )
    ).toBeVisible();

    await userEvent.click(within(chosen).getByRole("button", { name: copy.readBack.change }));
    const field = within(chosen).getByRole("textbox", { name: copy.readBack.changeLabel });
    await userEvent.clear(field);
    await userEvent.type(field, "Prices per hour");
    await userEvent.click(within(chosen).getByRole("button", { name: copy.readBack.save }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "interview.updateItem",
        input: { id: 7, itemId: 31, text: "Prices per hour" },
      })
    );
  });

  it("answers an open point", async () => {
    const { calls } = setup(
      aReadBack({ open: [anItem({ id: 32, text: "Invoices are due in 30 days", open: true })] }),
      { "readBack.correct": () => aReadBack() }
    );
    await openReadBack();
    const open = await screen.findByRole("region", { name: copy.readBack.openTitle });

    await userEvent.click(within(open).getByRole("button", { name: copy.readBack.answer }));
    await userEvent.type(
      within(open).getByRole("textbox", { name: copy.readBack.openLabel }),
      "14 days"
    );
    await userEvent.click(within(open).getByRole("button", { name: copy.readBack.send }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "readBack.correct",
        input: { id: 7, target: { itemId: 32 }, answer: "14 days" },
      })
    );
  });

  it("goes on to the spec with a note when the account cannot be written", async () => {
    const { calls } = setup(null, {
      "readBack.write": () => {
        throw new ApiFailure("SERVICE_UNAVAILABLE", "The interview could not reach the model");
      },
      "projects.generateSpec": () => aProject({ status: "spec_generating" }),
    });
    await openReadBack();

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.readBack.failed);
    await userEvent.click(screen.getByRole("button", { name: copy.readBack.skip }));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "projects.generateSpec", input: { id: 7 } })
    );
  });

  it("goes back to the questions", async () => {
    setup(aReadBack());
    await openReadBack();

    await userEvent.click(await screen.findByRole("button", { name: copy.readBack.back }));

    expect(screen.getByRole("button", { name: copy.readBack.open })).toBeVisible();
  });
});
