export * as ServerAddress from "./server-address.js"

// ABuCode: the URLs the HTTP servers in this process answer on, and the passwords they take. With the password a
// request to one of them can run commands and answer permission prompts, so the ABuCode plugin refuses the agent's own
// requests to them and masks the password in what the agent reads. Plugins cannot import the server package, so a
// server records itself here once it listens.
const servers = new Set<{ readonly urls: () => ReadonlyArray<string>; readonly password?: string }>()

/** Record a listening server's URLs, read again on every `list`, and its password; call the returned function once it stops. */
export function register(urls: () => ReadonlyArray<string>, password?: string) {
  const server = { urls, password }
  servers.add(server)
  return () => {
    servers.delete(server)
  }
}

/** The URLs every listening server in this process answers on now. */
export function list() {
  return Array.from(servers).flatMap((server) => server.urls())
}

/** The passwords of the listening servers in this process, which need not be in any file. */
export function passwords() {
  return Array.from(servers).flatMap((server) => (server.password === undefined ? [] : [server.password]))
}
