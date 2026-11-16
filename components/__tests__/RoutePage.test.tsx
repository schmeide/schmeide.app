import { screen } from "@testing-library/react";

import { routes } from "../../utils/routes";
import { RoutePage } from "../RoutePage";
import { aProject, projectServer, renderWithApi } from "./fakeApi";

describe("RoutePage", () => {
  it.each(routes)("renders a page with a heading for $name, which has a title", async (route) => {
    renderWithApi(
      <RoutePage name={route.name} params={{ id: 7 }} />,
      projectServer({ project: aProject() })
    );
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(route.title).not.toBe("");
  });
});
