// `role` is there only for a person with the platform admin role.
export type Person = { readonly name: string; readonly email: string; readonly role?: "admin" };
// `suspended`: its members see the suspended page in place of its pages (components/Routes.tsx).
export type Business = { readonly id: number; readonly name: string; readonly suspended?: boolean };
export type Provider = "google" | "microsoft" | "apple" | "auth0";

// The admin behind a session that views the app as `person`.
export type Impersonator = { readonly name: string; readonly email: string };

// Who is using the app. `person` is null when signed out; a new person has no business yet.
// `impersonatedBy` is set while an admin views the app as the person. `buildsOff`: the server
// builds and hosts no app (SCHMEIDE_BUILDS=off). `canBuild`: this person may approve a spec (not
// with builds off, nor with SCHMEIDE_BUILDS=admins unless an admin), so nothing else offers to.
export type Session = {
  readonly person: Person | null;
  readonly businesses: readonly Business[];
  readonly impersonatedBy?: Impersonator | null;
  readonly buildsOff?: boolean;
  readonly canBuild?: boolean;
};

export const signedOut: Session = { person: null, businesses: [] };

// Never while viewing as someone: the server answers no admin procedure then either.
export const isAdmin = (session: Session): boolean =>
  session.person?.role === "admin" && !session.impersonatedBy;
