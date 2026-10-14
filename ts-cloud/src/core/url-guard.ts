/**
 * @file ts-cloud/src/core/url-guard.ts
 * @description SSRF guard for the proxy endpoints.
 * Rejects targets that would let a caller reach the platform's own network
 * (cloud metadata, loopback, private ranges) or use non-HTTP schemes.
 *
 * Limitation: this inspects the URL text only. An edge runtime cannot resolve DNS, so a public
 * hostname whose A record points at a private address is not caught here, and redirects are
 * not re-checked. The bearer-token check in ./auth is the primary control; this is defence in depth.
 */

export interface ProxyTargetOptions {
	/** When set, the hostname must equal one of these or be a subdomain of one (e.g. "nasdaq.com"). */
	allowedHostSuffixes?: string[];
}

/** Hostnames that are internal by convention rather than by address. */
const INTERNAL_NAME =
	/(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa)$/;

type Ipv4 = readonly [number, number, number, number];
type Ipv6 = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

function ipv4Octets(host: string): Ipv4 | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const [, a, b, c, d] = m;
	// Unreachable (the regex has four groups); a missing group is treated as not an address.
	if (a === undefined || b === undefined || c === undefined || d === undefined)
		return null;
	const octets: Ipv4 = [Number(a), Number(b), Number(c), Number(d)];
	return octets.every((o) => o <= 255) ? octets : null;
}

function isBlockedIpv4([a, b]: Ipv4): boolean {
	return (
		a === 0 || // "this network", 0.0.0.0
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast, reserved, broadcast
	);
}

/** Expands an IPv6 literal (no brackets, no zone) to eight 16-bit groups, or null if malformed. */
function ipv6Groups(host: string): Ipv6 | null {
	if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(":")) return null;
	let text = host;
	// Trailing dotted-quad (::ffff:1.2.3.4) -> two hex groups
	const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
	const tailV4 = tail?.[1];
	if (tailV4 !== undefined) {
		const o = ipv4Octets(tailV4);
		if (!o) return null;
		text =
			text.slice(0, -tailV4.length) +
			`${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [
		...head,
		...Array(halves.length === 2 ? missing : 0).fill("0"),
		...rest,
	];
	const nums = groups.map((g) =>
		/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN,
	);
	const [n0, n1, n2, n3, n4, n5, n6, n7, ...extra] = nums;
	if (
		n0 === undefined ||
		n1 === undefined ||
		n2 === undefined ||
		n3 === undefined ||
		n4 === undefined ||
		n5 === undefined ||
		n6 === undefined ||
		n7 === undefined ||
		extra.length > 0 ||
		nums.some((n) => Number.isNaN(n))
	)
		return null;
	return [n0, n1, n2, n3, n4, n5, n6, n7];
}

function isBlockedIpv6(g: Ipv6): boolean {
	const embeddedV4: Ipv4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
	const firstSixZero = g.slice(0, 6).every((x) => x === 0);
	return (
		g.every((x) => x === 0) || // ::
		(g.slice(0, 7).every((x) => x === 0) && g[7] === 1) || // ::1
		(g.slice(0, 5).every((x) => x === 0) &&
			g[5] === 0xffff &&
			isBlockedIpv4(embeddedV4)) || // ::ffff:a.b.c.d
		(firstSixZero && isBlockedIpv4(embeddedV4)) || // deprecated IPv4-compatible ::a.b.c.d
		(g[0] === 0x64 &&
			g[1] === 0xff9b &&
			g.slice(2, 6).every((x) => x === 0) &&
			isBlockedIpv4(embeddedV4)) || // NAT64
		(g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(g[0] & 0xff00) === 0xff00 // multicast
	);
}

/**
 * Checks whether a caller-supplied URL is an acceptable proxy target.
 * @returns null when allowed, otherwise a short reason suitable for a 400 response.
 */
export function checkProxyTarget(
	raw: string,
	options: ProxyTargetOptions = {},
): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "Invalid URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return "Only http and https URLs are allowed";
	}
	if (url.username || url.password) {
		return "URLs with embedded credentials are not allowed";
	}

	// WHATWG URL has already canonicalized decimal/hex/octal IPv4 forms (2130706433, 0x7f.1, 127.1).
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	const bare =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

	const v4 = ipv4Octets(bare);
	const v6 = v4 ? null : ipv6Groups(bare);
	if ((v4 && isBlockedIpv4(v4)) || (v6 && isBlockedIpv6(v6))) {
		return "Target address is not allowed";
	}
	if (!v4 && !v6 && INTERNAL_NAME.test(host)) {
		return "Target host is not allowed";
	}

	const suffixes = options.allowedHostSuffixes;
	if (suffixes && !suffixes.some((s) => host === s || host.endsWith(`.${s}`))) {
		return "Target host is not on the allow-list";
	}
	return null;
}
