/**
 * The address a from-source desktop's own engine listens on.
 *
 * ABuCode: this computer only. Upstream starts that engine on every network interface. Its own Pair dialog stopped
 * needing that when pairing moved to the remote tunnel, and it leaves an engine that runs shell commands reachable
 * from the local network over plain http. ABUCODE_DESKTOP_EXPOSE_SERVER=1 brings that bind back.
 *
 * No other value does, and no other address is offered: the app reaches a wildcard bind through 127.0.0.1, and its
 * window is handed the engine's credential for loopback addresses only.
 */
export function isolatedHostname(expose: string | undefined) {
  return expose === "1" ? "0.0.0.0" : "127.0.0.1"
}
