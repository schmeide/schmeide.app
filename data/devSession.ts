import type { Session } from "../utils/session";

// ponytail: there is no auth yet (#5), so everyone is this one owner of the seeded `demo` tenant.
// Replace with the current person and their businesses from the server.
export const devSession: Session = {
  person: { name: "Demo owner", email: "owner@demo.example" },
  businesses: [{ id: 1, name: "Demo business" }],
};
