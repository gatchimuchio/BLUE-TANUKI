import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedNetworkAddress {
  address: string;
  family: 4 | 6;
}

const NON_PUBLIC_IPS = new BlockList();
const LOOPBACK_IPS = new BlockList();

for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
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
  const mapped = ipv4FromMappedIPv6(resolved.address);
  if (mapped) return isPublicNetworkAddress({ address: mapped, family: 4 });
  if (resolved.address.toLowerCase().startsWith("::ffff:")) return false;
  if (resolved.family !== isIP(resolved.address)) return false;
  try {
    return !NON_PUBLIC_IPS.check(
      resolved.address,
      resolved.family === 6 ? "ipv6" : "ipv4",
    );
  } catch {
    return false;
  }
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
