import { describeDevice } from "../device";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

describe("describing a device from its user agent", () => {
  it.each([
    [CHROME_MAC, { browser: "Chrome", os: "macOS" }],
    [EDGE_WINDOWS, { browser: "Edge", os: "Windows" }],
    [SAFARI_IPHONE, { browser: "Safari", os: "iPhone" }],
    [FIREFOX_LINUX, { browser: "Firefox", os: "Linux" }],
    [CHROME_ANDROID, { browser: "Chrome", os: "Android" }],
  ])("names the browser and system of %s", (agent, expected) => {
    expect(describeDevice(agent)).toEqual(expected);
  });

  it("names nothing it does not recognise", () => {
    expect(describeDevice("curl/8.5.0")).toEqual({ browser: null, os: null });
    expect(describeDevice(null)).toEqual({ browser: null, os: null });
  });
});
