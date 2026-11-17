import { describe, expect, it } from "vitest";
import {
  PUBLIC_MAILBOX_DOMAINS,
  addressAllowed,
  checkUrl,
  classifyIp,
  emailDomain,
  isOwnAddress,
  parseAddress,
} from "../webAddress.ts";

describe("classifyIp", () => {
  it.each([
    ["93.184.216.34", "public"],
    ["1.1.1.1", "public"],
    ["8.8.8.8", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.0", "public"],
    ["172.15.255.255", "public"],
    ["172.32.0.0", "public"],
    ["169.253.255.255", "public"],
    ["169.255.0.0", "public"],
    ["192.167.255.255", "public"],
    ["192.169.0.0", "public"],
    ["223.255.255.255", "public"],
    ["9.255.255.255", "public"],
    ["11.0.0.0", "public"],
    ["126.255.255.255", "public"],
    ["128.0.0.0", "public"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["10.0.0.0", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.0", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["100.64.0.0", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["169.254.0.1", "link_local"],
    ["169.254.255.255", "link_local"],
    ["169.254.169.254", "metadata"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.254", "reserved"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.1", "reserved"],
    ["192.88.99.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["198.19.255.255", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.7", "reserved"],
  ])("puts the IPv4 address %s in %s", (address, kind) => {
    expect(classifyIp(address)).toBe(kind);
  });

  it.each([
    ["2606:2800:220:1:248:1893:25c8:1946", "public"],
    ["2a00:1450:4001:81b::200e", "public"],
    ["2001:4860:4860::8888", "public"],
    ["::", "unspecified"],
    ["0:0:0:0:0:0:0:0", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["fc00::1", "unique_local"],
    ["fd12:3456:789a::1", "unique_local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique_local"],
    ["fd00:ec2::254", "metadata"],
    ["fd00:0ec2:0:0:0:0:0:254", "metadata"],
    ["fe80::1", "link_local"],
    ["febf::1", "link_local"],
    ["fe80::1%eth0", "link_local"],
    ["fec0::1", "private"],
    ["ff02::1", "multicast"],
    ["ff0e::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2001::1", "reserved"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"],
    ["100::1", "reserved"],
    ["64:ff9b:1::1", "reserved"],
    ["[::1]", "loopback"],
    ["[2606:2800:220:1:248:1893:25c8:1946]", "public"],
  ])("puts the IPv6 address %s in %s", (address, kind) => {
    expect(classifyIp(address)).toBe(kind);
  });

  it.each([
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["0:0:0:0:0:ffff:7f00:0001", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:a00:1", "private"],
    ["::ffff:192.168.1.1", "private"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:a9fe:a9fe", "metadata"],
    ["::ffff:100.64.0.1", "cgnat"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["::ffff:255.255.255.255", "broadcast"],
    ["::ffff:93.184.216.34", "public"],
    ["::ffff:5db8:d822", "public"],
    ["::127.0.0.1", "loopback"],
    ["::10.0.0.1", "private"],
    ["::ffff:0:127.0.0.1", "loopback"],
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
    ["64:ff9b::5db8:d822", "public"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:a00:1::1", "private"],
    ["2002:c0a8:101::", "private"],
    ["2002:5db8:d822::1", "public"],
  ])("reads the IPv4 address inside %s as %s", (address, kind) => {
    expect(classifyIp(address)).toBe(kind);
  });

  it.each(["", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "12345::", "0x7f.0.0.1", ":::1"])(
    "calls %j invalid",
    (address) => {
      expect(classifyIp(address)).toBe("invalid");
    }
  );
});

describe("addressAllowed", () => {
  it("allows a public address on the standard ports only", () => {
    expect(addressAllowed("93.184.216.34", 443)).toBe(true);
    expect(addressAllowed("93.184.216.34", 80)).toBe(true);
    expect(addressAllowed("93.184.216.34", 8080)).toBe(false);
    expect(addressAllowed("not an address", 443)).toBe(false);
  });

  it("allows a refused address only on the exact port an exception names", () => {
    const exceptions = new Set(["127.0.0.1:4010"]);
    expect(addressAllowed("127.0.0.1", 4010)).toBe(false);
    expect(addressAllowed("127.0.0.1", 4010, exceptions)).toBe(true);
    expect(addressAllowed("127.0.0.1", 4011, exceptions)).toBe(false);
    expect(addressAllowed("127.0.0.2", 4010, exceptions)).toBe(false);
    expect(addressAllowed("93.184.216.34", 4010, exceptions)).toBe(false);
  });
});

describe("checkUrl", () => {
  it.each([
    "https://example.com/",
    "http://example.com/a/b?c=d#e",
    "https://example.com:443/",
    "http://example.com:80/",
    "https://example.com:80/",
    "http://example.com:443/",
    "https://sub.example.co.uk/path",
    "https://93.184.216.34/",
    "https://[2606:2800:220:1:248:1893:25c8:1946]/",
    "HTTPS://EXAMPLE.COM/",
  ])("accepts %s", (address) => {
    expect(checkUrl(address)).toMatchObject({ ok: true });
  });

  it.each([
    ["", "not_an_address"],
    ["example.com", "not_an_address"],
    ["https://", "not_an_address"],
    [`https://example.com/${"a".repeat(2000)}`, "not_an_address"],
    ["ftp://example.com/", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["gopher://example.com/", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,hello", "scheme"],
    ["ws://example.com/", "scheme"],
    ["https://user@example.com/", "credentials"],
    ["https://user:secret@example.com/", "credentials"],
    ["https://:secret@example.com/", "credentials"],
    ["https://example.com:8443/", "port"],
    ["http://example.com:8080/", "port"],
    ["http://example.com:22/", "port"],
    ["http://example.com:6379/", "port"],
    ["http://example.com:5432/", "port"],
    ["http://localhost/", "host"],
    ["http://LOCALHOST/", "host"],
    ["http://localhost./", "host"],
    ["http://app.localhost/", "host"],
    ["http://intranet/", "host"],
    ["http://printer.local/", "host"],
    ["http://db.internal/", "host"],
    ["http://metadata.google.internal/", "host"],
    ["http://router.lan/", "host"],
    ["http://127.0.0.1/", "address"],
    ["http://127.1/", "address"],
    ["http://2130706433/", "address"],
    ["http://0x7f000001/", "address"],
    ["http://0177.0.0.1/", "address"],
    ["http://0/", "address"],
    ["http://0.0.0.0/", "address"],
    ["http://10.0.0.1/", "address"],
    ["http://172.16.0.1/", "address"],
    ["http://192.168.1.1/", "address"],
    ["http://100.64.0.1/", "address"],
    ["http://169.254.169.254/latest/meta-data/", "address"],
    ["http://224.0.0.1/", "address"],
    ["http://255.255.255.255/", "address"],
    ["http://[::1]/", "address"],
    ["http://[::]/", "address"],
    ["http://[::ffff:127.0.0.1]/", "address"],
    ["http://[::ffff:7f00:1]/", "address"],
    ["http://[::ffff:169.254.169.254]/", "address"],
    ["http://[fd00:ec2::254]/", "address"],
    ["http://[fc00::1]/", "address"],
    ["http://[fe80::1]/", "address"],
    ["http://[64:ff9b::7f00:1]/", "address"],
  ])("refuses %s as %s", (address, refusal) => {
    expect(checkUrl(address)).toEqual({ ok: false, refusal });
  });

  it("lets an exception through only for its own address and port", () => {
    const exceptions = new Set(["127.0.0.1:4010"]);
    expect(checkUrl("http://127.0.0.1:4010/", exceptions)).toMatchObject({ ok: true });
    expect(checkUrl("http://shop.test:4010/", exceptions)).toMatchObject({ ok: true });
    expect(checkUrl("http://127.0.0.1:4011/", exceptions)).toEqual({ ok: false, refusal: "port" });
    expect(checkUrl("http://127.0.0.2:4010/", exceptions)).toEqual({
      ok: false,
      refusal: "address",
    });
    expect(checkUrl("http://127.0.0.1/", exceptions)).toEqual({ ok: false, refusal: "address" });
    expect(checkUrl("http://127.0.0.1:4010/")).toEqual({ ok: false, refusal: "port" });
  });
});

describe("parseAddress", () => {
  it("reads an address typed without a scheme as https", () => {
    const parsed = parseAddress("  www.example.com/shop ");
    expect(parsed.ok && parsed.url.href).toBe("https://www.example.com/shop");
  });

  it("keeps the scheme a person typed, and refuses the ones it may not use", () => {
    const plain = parseAddress("http://example.com");
    expect(plain.ok && plain.url.href).toBe("http://example.com/");
    expect(parseAddress("ftp://example.com")).toEqual({ ok: false, refusal: "scheme" });
    expect(parseAddress("localhost:5432")).toEqual({ ok: false, refusal: "port" });
    expect(parseAddress("127.0.0.1")).toEqual({ ok: false, refusal: "address" });
    expect(parseAddress("user:secret@example.com")).toEqual({ ok: false, refusal: "credentials" });
    expect(parseAddress("just some words")).toEqual({ ok: false, refusal: "not_an_address" });
  });
});

describe("isOwnAddress", () => {
  it.each([
    ["acme.example", "ada@acme.example"],
    ["www.acme.example", "ada@acme.example"],
    ["shop.acme.example", "ada@acme.example"],
    ["ACME.example.", "Ada@Acme.Example"],
    ["acme.co.uk", "ada@acme.co.uk"],
    ["www.acme.co.uk", "ada@acme.co.uk"],
  ])("takes %s as the site of %s", (host, email) => {
    expect(isOwnAddress(host, email)).toBe(true);
  });

  it.each([
    ["other.example", "ada@acme.example"],
    ["acme.example.evil.test", "ada@acme.example"],
    ["notacme.example", "ada@acme.example"],
    ["example", "ada@acme.example"],
    ["acme.example", "ada@mail.acme.example"],
    ["other.co.uk", "ada@acme.co.uk"],
    ["co.uk", "ada@acme.co.uk"],
    ["gmail.com", "ada@gmail.com"],
    ["mail.google.com", "ada@gmail.com"],
    ["sites.outlook.com", "ada@outlook.com"],
    ["www.yahoo.com", "ada@yahoo.com"],
    ["icloud.com", "ada@icloud.com"],
    ["acme.example", "not an email"],
    ["acme.example", "@acme.example"],
    ["127.0.0.1", "ada@127.0.0.1"],
    ["localhost", "ada@localhost"],
  ])("does not take %s as the site of %s", (host, email) => {
    expect(isOwnAddress(host, email)).toBe(false);
  });

  it("never treats a public mailbox domain as a business's own", () => {
    expect(PUBLIC_MAILBOX_DOMAINS.size).toBeGreaterThan(40);
    for (const domain of PUBLIC_MAILBOX_DOMAINS) {
      expect([domain, emailDomain(`someone@${domain}`)]).toEqual([domain, null]);
      expect(isOwnAddress(domain, `someone@${domain}`)).toBe(false);
    }
    expect(emailDomain("ada@acme.example")).toBe("acme.example");
  });

  it("also takes a domain connected to one of the business's apps", () => {
    expect(isOwnAddress("www.bakery.example", "ada@gmail.com", ["bakery.example"])).toBe(true);
    expect(isOwnAddress("other.example", "ada@gmail.com", ["bakery.example"])).toBe(false);
  });
});
