export type Person = { readonly name: string; readonly email: string };
export type Business = { readonly id: number; readonly name: string };

// Who is using the app. `person` is null when signed out; a new person has no business yet.
export type Session = {
  readonly person: Person | null;
  readonly businesses: readonly Business[];
};

export const signedOut: Session = { person: null, businesses: [] };
