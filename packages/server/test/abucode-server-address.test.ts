import { expect } from "bun:test"
import { ServerAddress } from "@opencode/util/server-address"
import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

// ABuCode: the ABuCode plugin refuses the agent's requests to the URLs a server records here, and masks the password it
// records. A merge that drops the registration from ServerProcess.start fails this test.
it.live("records the URLs it listens on and its password while it runs, and drops them when it stops", () =>
  Effect.gen(function* () {
    const running = yield* Effect.scoped(
      ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port: 0,
        password: "secret-probe-password",
        app: { version: "test-version" },
        database: { path: ":memory:" },
        models: { fetch: false },
      }).pipe(
        Effect.map((server) => ({
          url: HttpServer.formatAddress(server.address),
          listed: ServerAddress.list(),
          passwords: ServerAddress.passwords(),
        })),
      ),
    )

    expect(running.listed).toContain(running.url)
    expect(running.passwords).toContain("secret-probe-password")
    expect(ServerAddress.list()).not.toContain(running.url)
    expect(ServerAddress.passwords()).not.toContain("secret-probe-password")
  }),
)
