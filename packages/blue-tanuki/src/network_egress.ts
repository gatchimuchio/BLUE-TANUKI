import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedNetworkAddress {
  address: string;
  family: 4 | 6;
}

const NON_PUBLIC_IPS = new BlockList();
const LOOPBACK_IPS = new BlockList();
const IPV4_PROTOCOL_ASSIGNMENTS = new BlockList();
const IPV4_PUBLIC_SPECIAL_ADDRESSES = new BlockList();
const IPV6_IETF_PROTOCOL_ASSIGNMENTS = new BlockList();
const IPV6_PUBLIC_SPECIAL_ADDRESSES = new BlockList();
const IPV6_MAPPED_IPV4 = new BlockList();
const IPV6_WELL_KNOWN_NAT64 = new BlockList();
const IPV6_GLOBAL_UNICAST = new BlockList();

// Snapshot of IANA's IPv4 and IPv6 Special-Purpose Address Registries
// (updated 2025-10-09). Globally-reachable entries are kept as explicit
// exceptions inside the broader 192.0.0.0/24 and 2001::/23 assignments.
IPV4_PROTOCOL_ASSIGNMENTS.addSubnet("192.0.0.0", 24, "ipv4");
IPV4_PUBLIC_SPECIAL_ADDRESSES.addAddress("192.0.0.9", "ipv4");
IPV4_PUBLIC_SPECIAL_ADDRESSES.addAddress("192.0.0.10", "ipv4");
IPV6_IETF_PROTOCOL_ASSIGNMENTS.addSubnet("2001::", 23, "ipv6");
for (const [address, prefix] of [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
] as const) {
  IPV6_PUBLIC_SPECIAL_ADDRESSES.addSubnet(address, prefix, "ipv6");
}
IPV6_MAPPED_IPV4.addSubnet("::ffff:0:0", 96, "ipv6");
IPV6_WELL_KNOWN_NAT64.addSubnet("64:ff9b::", 96, "ipv6");
IPV6_GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["100:0:0:1::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:2::", 48, "ipv6"],
  ["2001:10::", 28, "ipv6"],
  // The registry does not establish direct global reachability for 6to4.
  ["2002::", 16, "ipv6"],
  ["3fff::", 20, "ipv6"],
  ["5f00::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
] as const) {
  NON_PUBLIC_IPS.addSubnet(address, prefix, type);
}

LOOPBACK_IPS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_IPS.addAddress("::1", "ipv6");

function ipv4FromMappedIPv6(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1];
}

export function isLoopbackNetworkAddress(resolved: ResolvedNetworkAddress): boolean {
  const mapped = ipv4FromMappedIPv6(resolved.address);
  if (mapped) return isLoopbackNetworkAddress({ address: mapped, family: 4 });
  if (resolved.family !== isIP(resolved.address)) return false;
  try {
    return LOOPBACK_IPS.check(resolved.address, resolved.family === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

export function isPublicNetworkAddress(resolved: ResolvedNetworkAddress): boolean {
  if (resolved.family !== isIP(resolved.address)) return false;

  if (resolved.family === 6) {
    const address = resolved.address;
    if (IPV6_MAPPED_IPV4.check(address, "ipv6")) return false;
    if (IPV6_WELL_KNOWN_NAT64.check(address, "ipv6")) {
      const embedded = ipv4FromWellKnownNat64(address);
      if (!embedded || !isPublicNetworkAddress({ address: embedded, family: 4 })) return false;
      return true;
    }
    if (!IPV6_GLOBAL_UNICAST.check(address, "ipv6")) return false;
    if (IPV6_IETF_PROTOCOL_ASSIGNMENTS.check(address, "ipv6")) {
      return IPV6_PUBLIC_SPECIAL_ADDRESSES.check(address, "ipv6");
    }
  } else if (IPV4_PROTOCOL_ASSIGNMENTS.check(resolved.address, "ipv4")) {
    return IPV4_PUBLIC_SPECIAL_ADDRESSES.check(resolved.address, "ipv4");
  }

  try {
    return !NON_PUBLIC_IPS.check(
      resolved.address,
      resolved.family === 6 ? "ipv6" : "ipv4",
    );
  } catch {
    return false;
  }
}

function ipv4FromWellKnownNat64(address: string): string | undefined {
  const value = ipv6ToBigInt(address);
  if (value === undefined) return undefined;
  const ipv4 = Number(value & 0xffff_ffffn);
  return [24, 16, 8, 0].map((shift) => (ipv4 >>> shift) & 0xff).join(".");
}

function ipv6ToBigInt(address: string): bigint | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return undefined;

  let normalized = address.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized);
  if (dotted?.[1] && dotted.index !== undefined) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return undefined;
    }
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${normalized.slice(0, dotted.index)}${high}:${low}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) {
    return undefined;
  }
  const words = [...left, ...Array.from({ length: zeroCount }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) {
    return undefined;
  }
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

export async function resolveNetworkAddresses(
  hostname: string,
): Promise<ResolvedNetworkAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) {
      throw new Error("network_egress_unsupported_address_family");
    }
    return { address: record.address, family: record.family };
  });
}
