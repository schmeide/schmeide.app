import type { ReactNode } from "react";

import { copy } from "../data/copy";
import type { RouteName, RouteParams } from "../utils/routes";
import { AccountPage } from "./AccountPage";
import { AdminAdminsPage } from "./AdminAdminsPage";
import { AdminAuditPage } from "./AdminAuditPage";
import { AdminBusinessPage } from "./AdminBusinessPage";
import { AdminBusinessesPage } from "./AdminBusinessesPage";
import { AdminPage } from "./AdminPage";
import { AdminPeoplePage } from "./AdminPeoplePage";
import { AdminProjectsPage } from "./AdminProjectsPage";
import { AdminReviewPage } from "./AdminReviewPage";
import { AdminUsagePage } from "./AdminUsagePage";
import { BusinessPage } from "./BusinessPage";
import { FirstRun } from "./FirstRun";
import { PlaceholderPage } from "./PlaceholderPage";
import { ProjectList } from "./ProjectList";
import { ProjectPage } from "./ProjectPage";
import { SetPasswordPage } from "./SetPasswordPage";
import { SignInPage } from "./SignInPage";
import { SignUpPage } from "./SignUpPage";
import { StartPage } from "./StartPage";
import { TodayPage } from "./TodayPage";

const placeholder = (name: RouteName) => () => <PlaceholderPage title={copy.routes[name]} />;

// The page of every route. A route added to utils/routes.ts does not compile until it has one.
const pages: Readonly<Record<RouteName, (params: RouteParams) => ReactNode>> = {
  apps: () => <ProjectList />,
  start: () => <StartPage />,
  startExisting: () => <TodayPage />,
  // One key for the four views, so moving between them keeps the page and what was typed.
  project: ({ id }) => <ProjectPage key={id} id={id} view="overview" />,
  projectChanges: ({ id }) => <ProjectPage key={id} id={id} view="changes" />,
  projectVersions: ({ id }) => <ProjectPage key={id} id={id} view="versions" />,
  projectSettings: ({ id }) => <ProjectPage key={id} id={id} view="settings" />,
  usage: placeholder("usage"),
  billing: placeholder("billing"),
  business: () => <BusinessPage />,
  account: () => <AccountPage />,
  welcome: () => <FirstRun />,
  admin: () => <AdminPage />,
  adminBusinesses: () => <AdminBusinessesPage />,
  adminBusiness: ({ id }) => <AdminBusinessPage key={id} id={id} />,
  adminPeople: () => <AdminPeoplePage />,
  adminAdmins: () => <AdminAdminsPage />,
  adminProjects: () => <AdminProjectsPage />,
  adminUsage: () => <AdminUsagePage />,
  adminAudit: () => <AdminAuditPage />,
  adminReview: () => <AdminReviewPage />,
  help: placeholder("help"),
  go: () => null,
  signIn: () => <SignInPage />,
  signUp: () => <SignUpPage />,
  setPassword: () => <SetPasswordPage />,
  terms: placeholder("terms"),
  privacy: placeholder("privacy"),
  acceptableUse: placeholder("acceptableUse"),
  report: () => <PlaceholderPage title={copy.routes.report} note={copy.report.lookedAt} />,
};

type Props = { readonly name: RouteName; readonly params: RouteParams };

export function RoutePage({ name, params }: Props) {
  return pages[name](params);
}
