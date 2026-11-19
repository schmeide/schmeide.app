import { Hero } from "./components/Hero";
import { Studio } from "./components/Studio";
import { hasHostedApi } from "./utils/apiUrl";

// Root layout only: composes sections, holds no page content of its own. The public site (a
// production build on GitHub Pages) shows the hero until it is built with an API address
// (VITE_API_URL). Once it is, an API that does not answer shows the outage page instead.
export function App({
  isPublicSite = import.meta.env.PROD,
  expectsApi = hasHostedApi,
}: {
  readonly isPublicSite?: boolean;
  readonly expectsApi?: boolean;
}) {
  return <Studio isPublicSite={isPublicSite} expectsApi={expectsApi} fallback={<Hero />} />;
}
