// `role` is there only for a person with the platform admin role.
export type Person = { readonly name: string; readonly email: string; readonly role?: "admin" };
export type Business = { readonly id: number; readonly name: string };
export type Provider = "google" | "microsoft" | "apple";

// Who is using the app. `person` is null when signed out; a new person has no business yet.
export type Session = {
  readonly person: Person | null;
  readonly businesses: readonly Business[];
};

export const signedOut: Session = { person: null, businesses: [] };

export const isAdmin = (session: Session): boolean => session.person?.role === "admin";
