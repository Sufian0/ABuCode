import { expect, test } from "bun:test"
import { isolatedHostname } from "./isolated-hostname"

// The variable is an on/off switch, not a truthy flag and not a way to name an address.
test.each([
  { expose: undefined, expected: "127.0.0.1" },
  { expose: "1", expected: "0.0.0.0" },
  { expose: "true", expected: "127.0.0.1" },
  { expose: "0.0.0.0", expected: "127.0.0.1" },
])("isolatedHostname($expose) -> $expected", (input) => {
  expect(isolatedHostname(input.expose)).toBe(input.expected)
})
