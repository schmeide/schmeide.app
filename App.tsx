import { Hero } from "./components/Hero";
import { Studio } from "./components/Studio";

// Root layout only: composes sections, holds no page content of its own. The public site (a
// production build on GitHub Pages) has no API, so it falls back to the hero.
export function App({ isPublicSite = import.meta.env.PROD }: { readonly isPublicSite?: boolean }) {
  return <Studio isPublicSite={isPublicSite} fallback={<Hero />} />;
}
