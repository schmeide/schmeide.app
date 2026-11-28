import { between, previousLive } from "../versions";

const version = (number: number) => ({
  kind: "change",
  status: "passed",
  version: number,
  movedTo: number,
});
const release = (kind: string, movedTo: number | null, status = "passed") => ({
  kind,
  status,
  version: null,
  movedTo,
});

describe("previousLive", () => {
  it("is the version a promote or roll back replaced, or the first version", () => {
    expect(previousLive([version(3), release("promote", 2), version(2), version(1)], 2)).toBe(1);
    expect(
      previousLive(
        [release("rollback", 1), release("discard", 2), release("promote", 3), version(1)],
        1
      )
    ).toBe(3);
  });

  it("is null while the first version is live, or when the list does not match what is live", () => {
    expect(previousLive([version(2), version(1)], 1)).toBeNull();
    expect(previousLive([release("promote", 3), version(1)], 2)).toBeNull();
    expect(previousLive([release("promote", 2, "failed"), version(2), version(1)], 1)).toBeNull();
  });
});

describe("between", () => {
  it("lists the versions after the lower one, up to the higher one", () => {
    const builds = [version(4), version(3), release("promote", 2), version(2), version(1)];
    expect(between(builds, 3, 1).map((build) => build.version)).toEqual([3, 2]);
    expect(between(builds, 1, 3).map((build) => build.version)).toEqual([3, 2]);
  });
});
