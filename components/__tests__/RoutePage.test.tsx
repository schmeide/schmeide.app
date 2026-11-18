import { screen } from "@testing-library/react";

import { copy } from "../../data/copy";
import { routes } from "../../utils/routes";
import { RoutePage } from "../RoutePage";
import { aProject, projectServer, renderWithApi } from "./fakeApi";

describe("RoutePage", () => {
  it.each(routes.filter((route) => route.name !== "go"))(
    "renders a page with a heading for $name, which has a title",
    async (route) => {
      renderWithApi(
        <RoutePage name={route.name} params={{ id: 7 }} />,
        projectServer({ project: aProject() })
      );
      expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
      expect(route.title).not.toBe("");
    }
  );

  it("says on the report page that a report is looked at within two working days", () => {
    renderWithApi(<RoutePage name="report" params={{}} />, {});
    expect(screen.getByRole("heading", { level: 1, name: copy.routes.report })).toBeInTheDocument();
    expect(screen.getByText(copy.report.lookedAt)).toBeInTheDocument();
  });

  it("gives /go a title and no page: it only forwards", () => {
    const go = routes.find((route) => route.name === "go");
    expect(go?.title).not.toBe("");
    renderWithApi(<RoutePage name="go" params={{}} />, {});
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
