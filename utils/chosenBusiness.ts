// Which business a person in several is working in. Kept outside React so the API link (main.tsx)
// can send it with every call. The server (BUSINESS_HEADER in server/src/router.ts) reads the
// same header, and uses the person's first business when it names none or one they are not in.
export const BUSINESS_HEADER = "x-schmeide-business";

let chosen: number | null = null;

export const chooseBusiness = (id: number | null) => {
  chosen = id;
};

export const businessHeaders = (): Readonly<Record<string, string>> =>
  chosen === null ? {} : { [BUSINESS_HEADER]: String(chosen) };
