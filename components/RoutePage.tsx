import type { ReactNode } from "react";

import { copy } from "../data/copy";
import type { RouteName, RouteParams } from "../utils/routes";
import { PlaceholderPage } from "./PlaceholderPage";
import { ProjectList } from "./ProjectList";
import { ProjectPage } from "./ProjectPage";
import { SetPasswordPage } from "./SetPasswordPage";
import { SignInPage } from "./SignInPage";

const placeholder = (name: RouteName) => () => <PlaceholderPage title={copy.routes[name]} />;

// The page of every route. A route added to utils/routes.ts does not compile until it has one.
const pages: Readonly<Record<RouteName, (params: RouteParams) => ReactNode>> = {
  apps: () => <ProjectList />,
  // One key for the three views, so moving between them keeps the page and what was typed.
  project: ({ id }) => <ProjectPage key={id} id={id} view="overview" />,
  projectChanges: ({ id }) => <ProjectPage key={id} id={id} view="changes" />,
  projectSettings: ({ id }) => <ProjectPage key={id} id={id} view="settings" />,
  usage: placeholder("usage"),
  billing: placeholder("billing"),
  business: placeholder("business"),
  account: placeholder("account"),
  welcome: placeholder("welcome"),
  help: placeholder("help"),
  signIn: () => <SignInPage />,
  setPassword: () => <SetPasswordPage />,
  terms: placeholder("terms"),
  privacy: placeholder("privacy"),
  acceptableUse: placeholder("acceptableUse"),
  report: placeholder("report"),
};

type Props = { readonly name: RouteName; readonly params: RouteParams };

export function RoutePage({ name, params }: Props) {
  return pages[name](params);
}
