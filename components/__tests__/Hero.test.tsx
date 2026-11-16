import { render, screen } from "@testing-library/react";

import { copy } from "../../data/copy";
import { Hero } from "../Hero";

describe("Hero", () => {
  it("renders the headline as the page's only h1", () => {
    render(<Hero />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(copy.hero.headline);
  });

  it("renders the tagline", () => {
    render(<Hero />);
    expect(screen.getByText(copy.hero.tagline)).toBeInTheDocument();
  });
});
