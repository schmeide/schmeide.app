import type { ReactNode } from "react";

import { copy } from "../data/copy";
import type { RouteName, RouteParams } from "../utils/routes";
import { PlaceholderPage } from "./PlaceholderPage";
import { ProjectList } from "./ProjectList";
import { ProjectPage } from "./ProjectPage";
import { SignInPage } from "./SignInPage";

const placeholder = (name: RouteName) => () => <PlaceholderPage title={copy.routes[name]} />;

// The page of every route. A route added to utils/routes.ts does not compile until it has one.
const pages: Readonly<Record<RouteName, (params: RouteParams) => ReactNode>> = {
  apps: () => <ProjectList />,
  project: ({ id }) => <ProjectPage key={id} id={id} />,
  usage: placeholder("usage"),
  billing: placeholder("billing"),
  business: placeholder("business"),
  account: placeholder("account"),
  welcome: placeholder("welcome"),
  help: placeholder("help"),
  signIn: () => <SignInPage />,
  terms: placeholder("terms"),
  privacy: placeholder("privacy"),
  acceptableUse: placeholder("acceptableUse"),
  report: placeholder("report"),
};

type Props = { readonly name: RouteName; readonly params: RouteParams };

export function RoutePage({ name, params }: Props) {
  return pages[name](params);
}
