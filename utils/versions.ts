// What the versions view (#230) reads out of builds.list, newest first.
type Listed = {
  readonly kind: string;
  readonly status: string;
  readonly version: number | null;
  readonly movedTo: number | null;
};

const RELEASES: readonly string[] = ["promote", "discard", "rollback"];

// A passed build that is a version of the app, numbered or from before versions were kept.
export const isVersion = (build: Listed): boolean =>
  build.status === "passed" && !RELEASES.includes(build.kind);

// A passed promote, discard or roll back: a line between the versions.
export const isRelease = (build: Listed): boolean =>
  build.status === "passed" && RELEASES.includes(build.kind);

// The version that was live before `live`, or null. Live in turn, newest first: what each passed
// promote and roll back put live, then the first version, which went live by itself.
export const previousLive = (builds: readonly Listed[], live: number | null): number | null => {
  const numbers = builds.flatMap(({ version }) => (version === null ? [] : [version]));
  const first = numbers.length > 0 ? Math.min(...numbers) : null;
  const order = [
    ...builds
      .filter((build) => isRelease(build) && build.kind !== "discard")
      .map(({ movedTo }) => movedTo),
    first,
  ];
  const previous = order[0] === live ? (order[1] ?? null) : null;
  return previous === live ? null : previous;
};

// The versions a move from `live` to `target` takes off or puts on the live app.
// ponytail: by number, not by what each version was built on; a version thrown away from the
// version being worked on and never live is listed too. Reading builds.baseCommit fixes it.
export const between = <T extends Listed>(
  builds: readonly T[],
  live: number,
  target: number
): readonly T[] =>
  builds.filter(
    ({ version }) =>
      version !== null && version > Math.min(live, target) && version <= Math.max(live, target)
  );
