import { isIP } from "node:net";

export const IP_KINDS = [
  "public",
  "invalid",
  "unspecified",
  "loopback",
  "private",
  "cgnat",
  "link_local",
  "metadata",
  "multicast",
  "broadcast",
  "reserved",
  "unique_local",
] as const;
export type IpKind = (typeof IP_KINDS)[number];

type Range = readonly [prefix: string, bits: number, kind: IpKind];

const V4_RANGES: readonly Range[] = [
  ["255.255.255.255", 32, "broadcast"],
  ["169.254.169.254", 32, "metadata"],
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "cgnat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link_local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "reserved"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "reserved"],
  ["198.51.100.0", 24, "reserved"],
  ["203.0.113.0", 24, "reserved"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

const V6_RANGES: readonly Range[] = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["fd00:ec2::254", 128, "metadata"],
  ["64:ff9b:1::", 48, "reserved"],
  ["100::", 64, "reserved"],
  ["2001::", 23, "reserved"],
  ["2001:db8::", 32, "reserved"],
  ["3fff::", 20, "reserved"],
  ["5f00::", 16, "reserved"],
  ["fc00::", 7, "unique_local"],
  ["fe80::", 10, "link_local"],
  ["fec0::", 10, "private"],
  ["ff00::", 8, "multicast"],
];

const EMBEDDED_V4: readonly (readonly [prefix: string, bits: number])[] = [
  ["::ffff:0:0", 96],
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["2002::", 16],
];

const v4Bits = (address: string): bigint =>
  address.split(".").reduce((sum, part) => (sum << 8n) | BigInt(Number(part)), 0n);

const dottedTail = (address: string): string => {
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (!dotted) return address;
  const tail = v4Bits(dotted[2]);
  return `${dotted[1]}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
};

const v6Bits = (address: string): bigint => {
  const [head, rest] = dottedTail(address).split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const groups =
    rest === undefined
      ? left
      : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  return groups.reduce((sum, group) => (sum << 16n) | BigInt(`0x${group}`), 0n);
};

const within = (bits: bigint, width: number, prefix: bigint, prefixBits: number): boolean =>
  bits >> BigInt(width - prefixBits) === prefix >> BigInt(width - prefixBits);

const classifyV4 = (bits: bigint): IpKind =>
  V4_RANGES.find(([prefix, size]) => within(bits, 32, v4Bits(prefix), size))?.[2] ?? "public";

const classifyV6 = (bits: bigint): IpKind => {
  const fixed = V6_RANGES.find(([prefix, size]) => within(bits, 128, v6Bits(prefix), size));
  if (fixed) return fixed[2];
  const embedded = EMBEDDED_V4.find(([prefix, size]) => within(bits, 128, v6Bits(prefix), size));
  if (embedded) return classifyV4((bits >> BigInt(96 - embedded[1])) & 0xffffffffn);
  return "public";
};

const unbracketed = (host: string): string => host.replace(/^\[|\]$/g, "");

export const classifyIp = (address: string): IpKind => {
  const bare = unbracketed(address);
  if (isIP(bare) === 4) return classifyV4(v4Bits(bare));
  if (isIP(bare) === 6) return bare.includes("%") ? "link_local" : classifyV6(v6Bits(bare));
  return "invalid";
};

export const NO_EXCEPTIONS: ReadonlySet<string> = new Set();

export const exceptionKey = (address: string, port: number): string => `${address}:${port}`;

const STANDARD_PORTS: readonly number[] = [80, 443];

export const portOf = (url: URL): number =>
  url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

export const addressAllowed = (
  address: string,
  port: number,
  exceptions: ReadonlySet<string> = NO_EXCEPTIONS
): boolean =>
  exceptions.has(exceptionKey(address, port)) ||
  (STANDARD_PORTS.includes(port) && classifyIp(address) === "public");

export const URL_REFUSALS = [
  "not_an_address",
  "scheme",
  "credentials",
  "port",
  "host",
  "address",
] as const;
export type UrlRefusal = (typeof URL_REFUSALS)[number];

export type CheckedUrl =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly refusal: UrlRefusal };

const MAX_URL_LENGTH = 2000;
const INTERNAL_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa)$/;

const parse = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

const refuse = (refusal: UrlRefusal): CheckedUrl => ({ ok: false, refusal });

export const checkUrl = (
  text: string,
  exceptions: ReadonlySet<string> = NO_EXCEPTIONS
): CheckedUrl => {
  const url = text.length <= MAX_URL_LENGTH ? parse(text) : null;
  if (!url) return refuse("not_an_address");
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse("scheme");
  if (url.username || url.password) return refuse("credentials");
  const port = portOf(url);
  const excepted = [...exceptions].some((key) => key.endsWith(`:${port}`));
  if (!STANDARD_PORTS.includes(port) && !excepted) return refuse("port");
  const host = unbracketed(url.hostname).replace(/\.$/, "");
  if (isIP(host))
    return addressAllowed(host, port, exceptions) ? { ok: true, url } : refuse("address");
  if (!host.includes(".") || INTERNAL_NAMES.test(host)) return refuse("host");
  return { ok: true, url };
};

export const parseAddress = (
  typed: string,
  exceptions: ReadonlySet<string> = NO_EXCEPTIONS
): CheckedUrl => {
  const text = typed.trim();
  return checkUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`, exceptions);
};

export const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  "126.com",
  "163.com",
  "aol.com",
  "att.net",
  "bluewin.ch",
  "btinternet.com",
  "comcast.net",
  "duck.com",
  "fastmail.com",
  "free.fr",
  "freenet.de",
  "gmail.com",
  "gmx.at",
  "gmx.ch",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "hotmail.de",
  "hotmail.fr",
  "hotmail.it",
  "icloud.com",
  "laposte.net",
  "libero.it",
  "live.co.uk",
  "live.com",
  "mac.com",
  "mail.com",
  "mail.ru",
  "mailbox.org",
  "me.com",
  "msn.com",
  "naver.com",
  "orange.fr",
  "outlook.com",
  "outlook.de",
  "outlook.fr",
  "pm.me",
  "posteo.de",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "sbcglobal.net",
  "t-online.de",
  "tuta.io",
  "tutanota.com",
  "verizon.net",
  "wanadoo.fr",
  "web.de",
  "yahoo.co.uk",
  "yahoo.com",
  "yahoo.de",
  "yahoo.fr",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

const bareHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

const atOrUnder = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

export const emailDomain = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  const domain = at < 1 ? "" : bareHost(email.slice(at + 1));
  return domain.includes(".") && !isIP(domain) && !PUBLIC_MAILBOX_DOMAINS.has(domain)
    ? domain
    : null;
};

export const isOwnAddress = (
  host: string,
  email: string,
  connectedDomains: readonly string[] = []
): boolean => {
  const site = bareHost(host);
  if (isIP(unbracketed(site))) return false;
  const own = emailDomain(email);
  return [...(own ? [own] : []), ...connectedDomains.map(bareHost)].some((domain) =>
    atOrUnder(site, domain)
  );
};
