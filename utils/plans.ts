// The plans a business can pay for. The server answers them at `GET /plans` for schmeide.com's
// pricing page, and the app accepts their ids in `?plan=<id>`, so both sites show the same ones.
//
// An id is a contract: links already sent out carry it. Never rename or drop one in place; add the
// new plan and map the old id to it in `RENAMED_PLANS`.
//
// Prices, allowances and how many live apps a plan includes are not decided yet (#61, #82), so
// they are null and the site shows them as to be confirmed.

export type Plan = {
  readonly id: string;
  readonly name: string;
  // Per month, in US dollars.
  readonly monthlyPriceUsd: number | null;
  readonly liveApps: number | null;
  // Model spend on building included each month, in US dollars.
  readonly buildingAllowanceUsd: number | null;
  readonly beyondAllowance: string;
};

const BEYOND_ALLOWANCE = "Building beyond the allowance is added to the next invoice at cost.";

export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    name: "Starter",
    monthlyPriceUsd: null,
    liveApps: null,
    buildingAllowanceUsd: null,
    beyondAllowance: BEYOND_ALLOWANCE,
  },
  {
    id: "business",
    name: "Business",
    monthlyPriceUsd: null,
    liveApps: null,
    buildingAllowanceUsd: null,
    beyondAllowance: BEYOND_ALLOWANCE,
  },
];

// Old id to the id that replaced it. Empty: nothing has been renamed.
export const RENAMED_PLANS: ReadonlyMap<string, string> = new Map();
