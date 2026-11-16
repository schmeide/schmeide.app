import { Hero } from "./components/Hero";
import { Studio } from "./components/Studio";
import { hasHostedApi } from "./utils/apiUrl";

// Root layout only: composes sections, holds no page content of its own. The public site (a
// production build on GitHub Pages) shows the hero until it is built with an API address
// (VITE_API_URL), and whenever that API does not answer.
export function App({
  isPublicSite = import.meta.env.PROD,
  expectsApi = hasHostedApi,
}: {
  readonly isPublicSite?: boolean;
  readonly expectsApi?: boolean;
}) {
  return <Studio isPublicSite={isPublicSite} expectsApi={expectsApi} fallback={<Hero />} />;
}
