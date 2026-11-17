import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { Interview } from "../../trpc";
import { ProjectPage } from "../ProjectPage";
import {
  anInterview,
  anItem,
  ApiFailure,
  aProject,
  aQuestion,
  projectServer,
  renderWithApi,
} from "./fakeApi";

const WHO = aQuestion();
const DUE = aQuestion({
  id: 12,
  text: "Do invoices have a due date?",
  kind: "yes_no",
  choices: [],
});
const answered = (answer: NonNullable<Interview["questions"][number]["answer"]>) =>
  aQuestion({ answer, answeredAt: new Date() });

// A project page whose interview the test advances by hand, one handler result per call.
const setup = (
  interview: Interview,
  handlers: Parameters<typeof renderWithApi>[1] = {},
  project = aProject()
) => {
  const state = { project, interview };
  const calls = renderWithApi(<ProjectPage id={7} />, { ...projectServer(state), ...handlers });
  return { state, calls };
};

const plan = (items: number) =>
  screen.getByRole("region", { name: copy.interview.planTitle(items) });

describe("InterviewStep", () => {
  it("sets the question one heading level under the step title, which is not numbered like a question", async () => {
    setup(anInterview({ current: WHO }));

    const title = await screen.findByRole("heading", {
      level: 2,
      name: copy.project.featuresTitle,
    });
    expect(title).toBeVisible();
    expect(title.textContent ?? "").not.toMatch(/^\d/);
    expect(screen.getByRole("heading", { level: 3, name: WHO.text })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 2, name: WHO.text })).toBeNull();
    expect(screen.getByRole("group", { name: WHO.text })).toBeVisible();
  });

  it("shows what the app replaces only when something was named, with no progress beside it", async () => {
    const withReplaces = anInterview({
      current: aQuestion(),
      items: [anItem({ id: 30, section: "replaces", text: "A spreadsheet" })],
    });
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject(), interview: withReplaces })
    );

    const heading = await screen.findByRole("heading", { name: copy.interview.sections.replaces });
    expect(heading).toHaveTextContent(new RegExp(`^${copy.interview.sections.replaces}\\s*$`));
    expect(screen.getByText("A spreadsheet")).toBeVisible();
  });

  it("leaves “What it replaces” out of a plan that started from an idea", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject(), interview: anInterview({ current: aQuestion() }) })
    );

    await screen.findByText(aQuestion().text);
    expect(screen.queryByRole("heading", { name: copy.interview.sections.replaces })).toBeNull();
  });

  it("offers the questions first, and asks one when started", async () => {
    const { calls } = setup(anInterview(), {
      "interview.start": () =>
        anInterview({
          current: WHO,
          items: [anItem({ source: "schmeide" })],
          sections: { ...anInterview().sections, does: "sketched" },
        }),
    });

    await userEvent.click(await screen.findByRole("button", { name: copy.interview.start }));

    const question = await screen.findByRole("group", { name: WHO.text });
    expect(
      within(question)
        .getAllByRole("radio")
        .map((radio) => radio.parentElement)
    ).toEqual([
      expect.objectContaining({ textContent: "Just me" }),
      expect.objectContaining({ textContent: "Me and my staff" }),
      expect.objectContaining({ textContent: copy.interview.other }),
    ]);
    expect(calls).toContainEqual({ path: "interview.start", input: { id: 7 } });
    const item = within(plan(1)).getByText("Create an invoice").closest("li");
    expect(item).toHaveTextContent(copy.interview.tagSchmeide);
    expect(item).toHaveTextContent(copy.interview.tagNew);
    expect(plan(1)).toHaveTextContent(copy.interview.sectionStatus.sketched);
  });

  it("sends a chosen answer, marks what it added to the plan, and moves to the next question", async () => {
    const { calls } = setup(anInterview({ current: WHO, items: [anItem()] }), {
      "interview.answer": () =>
        anInterview({
          questions: [answered({ type: "choices", values: ["Just me"] })],
          current: DUE,
          items: [anItem(), anItem({ id: 22, section: "who", text: "Only the owner" })],
        }),
    });

    await userEvent.click(await screen.findByRole("radio", { name: "Just me" }));
    await userEvent.click(screen.getByRole("button", { name: copy.interview.continue }));

    const next = await screen.findByRole("group", { name: DUE.text });
    expect(calls).toContainEqual({
      path: "interview.answer",
      input: { id: 7, questionId: 11, answer: { type: "choices", values: ["Just me"] } },
    });
    expect(within(next).getByText(DUE.text)).toHaveFocus();
    expect(within(plan(2)).getByText("Only the owner").closest("li")).toHaveTextContent(
      copy.interview.tagNew
    );
    expect(within(plan(2)).getByText("Create an invoice").closest("li")).not.toHaveTextContent(
      copy.interview.tagNew
    );
    expect(screen.getByText(copy.interview.added(["Only the owner"]))).toHaveAttribute(
      "role",
      "status"
    );
    await userEvent.click(screen.getByText(copy.interview.answersTitle(1)));
    expect(screen.getByText("Just me")).toBeInTheDocument();
  });

  it.each([
    [
      "yes or no",
      DUE,
      async () => userEvent.click(screen.getByRole("radio", { name: "Yes" })),
      {
        type: "yes_no",
        value: true,
      },
    ],
    [
      "several choices",
      aQuestion({ kind: "pick_many", choices: ["Email", "Print", "Text message"] }),
      async () => {
        await userEvent.click(screen.getByRole("checkbox", { name: "Email" }));
        await userEvent.click(screen.getByRole("checkbox", { name: "Print" }));
      },
      { type: "choices", values: ["Email", "Print"] },
    ],
    [
      "the person's own words",
      WHO,
      async () => {
        await userEvent.click(screen.getByRole("radio", { name: copy.interview.other }));
        await userEvent.type(screen.getByLabelText(copy.interview.otherLabel), "My bookkeeper");
      },
      { type: "text", value: "My bookkeeper" },
    ],
    [
      "a written answer",
      aQuestion({ kind: "text", choices: [] }),
      async () => userEvent.type(screen.getByLabelText(copy.interview.answerLabel), "Plumbing"),
      { type: "text", value: "Plumbing" },
    ],
  ])("answers with %s", async (_, question, fill, answer) => {
    const { calls } = setup(anInterview({ current: question }), {
      "interview.answer": () => anInterview({ finished: true, questions: [question] }),
    });
    await screen.findByRole("group", { name: question.text });

    await fill();
    await userEvent.click(screen.getByRole("button", { name: copy.interview.continue }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "interview.answer",
        input: { id: 7, questionId: question.id, answer },
      })
    );
  });

  it("lets Schmeide decide", async () => {
    const { calls } = setup(anInterview({ current: WHO }), {
      "interview.answer": () => anInterview({ finished: true, questions: [WHO] }),
    });

    await userEvent.click(await screen.findByRole("button", { name: copy.interview.youDecide }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "interview.answer",
        input: { id: 7, questionId: 11, answer: { type: "you_decide" } },
      })
    );
  });

  it("asks for an answer before continuing, beside the question", async () => {
    const { calls } = setup(anInterview({ current: WHO }));

    await userEvent.click(await screen.findByRole("button", { name: copy.interview.continue }));

    expect(screen.getByRole("alert")).toHaveTextContent(copy.interview.needAnswer);
    expect(screen.getByRole("group", { name: WHO.text })).toHaveAccessibleDescription(
      copy.interview.needAnswer
    );
    expect(calls.map((call) => call.path)).not.toContain("interview.answer");
  });

  it("keeps the answer and says how to go on when the next question cannot be prepared", async () => {
    const { calls } = setup(anInterview({ current: WHO }), {
      "interview.answer": () => {
        throw new ApiFailure("SERVICE_UNAVAILABLE", "The model run failed");
      },
    });
    await userEvent.click(await screen.findByRole("radio", { name: "Just me" }));
    await userEvent.click(screen.getByRole("button", { name: copy.interview.continue }));

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.interview.unavailable);
    expect(screen.getByRole("radio", { name: "Just me" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: copy.interview.continue }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "interview.answer")).toHaveLength(2)
    );
  });

  it("writes the spec from the plan once the questions are done", async () => {
    const { state, calls } = setup(
      anInterview({
        finished: true,
        questions: [answered({ type: "you_decide" })],
        items: [anItem()],
      }),
      {
        "projects.generateSpec": () => {
          state.project = aProject({ status: "spec_generating" });
          return state.project;
        },
      }
    );
    expect(await screen.findByText(copy.interview.finished)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: copy.project.writeSpec }));

    expect(await screen.findByText(copy.project.specWriting)).toBeInTheDocument();
    expect(calls).toContainEqual({ path: "projects.generateSpec", input: { id: 7 } });
  });

  it("does not write a spec from a plan that says nothing about what the app does", async () => {
    const { calls } = setup(
      anInterview({ current: WHO, items: [anItem({ section: "who", text: "Only the owner" })] })
    );

    await userEvent.click(await screen.findByRole("button", { name: copy.project.writeSpec }));

    expect(screen.getByRole("alert")).toHaveTextContent(copy.interview.needPlan);
    expect(calls.map((call) => call.path)).not.toContain("projects.generateSpec");
  });

  it("switches to typed requests and back", async () => {
    setup(anInterview());

    await userEvent.click(await screen.findByRole("button", { name: copy.interview.writeMyself }));
    expect(screen.getByLabelText(copy.project.requestLabel(1))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: copy.interview.useQuestions }));
    expect(screen.getByRole("button", { name: copy.interview.start })).toBeInTheDocument();
  });

  it("opens on the typed requests for a project that was described that way", async () => {
    setup(anInterview(), {}, aProject({ features: "Keep a list of clients" }));

    expect(await screen.findByLabelText(copy.project.requestLabel(1))).toHaveValue(
      "Keep a list of clients"
    );
    const title = screen.getByRole("heading", { level: 2, name: copy.project.featuresTitle });
    expect(title).toBeVisible();
    expect(title.textContent ?? "").not.toMatch(/^\d/);
  });

  // Setup shows one step at a time, so the build replaces the plan and its questions.
  it("leaves the plan and its questions to the describe step once the app is being built", async () => {
    setup(
      anInterview({
        current: WHO,
        items: [anItem()],
        questions: [answered({ type: "you_decide" })],
      }),
      {},
      aProject({ status: "building" })
    );

    expect(await screen.findByRole("list", { name: copy.project.setup.label })).toBeInTheDocument();
    expect(screen.queryByText("Create an invoice")).toBeNull();
    expect(screen.queryByRole("group", { name: WHO.text })).toBeNull();
    expect(screen.queryByRole("button", { name: copy.project.writeSpec })).toBeNull();
  });
});
