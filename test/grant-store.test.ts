import { describe, expect, test } from "bun:test"
import { PermissionGrantStore } from "../fork/command-code/src/grant-store.js"

/** A store whose clock we control, so TTL behaviour is deterministic. */
function storeAt(start = 0) {
  let now = start
  const store = new PermissionGrantStore(() => now)
  return { store, advance: (ms: number) => (now += ms) }
}

describe("PermissionGrantStore", () => {
  test("a grant is consumed exactly once", () => {
    const { store } = storeAt()
    const key = store.key("write_file", { path: "a.txt" })

    store.grant(key, "allow")
    expect(store.consume(key)?.decision).toBe("allow")
    // Second pass must not reuse it: a grant covers one execution, so a later
    // identical call prompts again.
    expect(store.consume(key)).toBeUndefined()
  })

  test("keys ignore property order", () => {
    const { store } = storeAt()
    // The two hooks receive the same input with different key order.
    expect(store.key("write_file", { content: "hi", file_path: "a.txt" })).toBe(
      store.key("write_file", { file_path: "a.txt", content: "hi" }),
    )
  })

  test("nested values are compared structurally", () => {
    const { store } = storeAt()
    expect(store.key("t", { a: { b: 1, c: [1, 2] } })).toBe(store.key("t", { a: { c: [1, 2], b: 1 } }))
    expect(store.key("t", { a: { b: 1 } })).not.toBe(store.key("t", { a: { b: 2 } }))
  })

  test("the tool name is part of the key", () => {
    const { store } = storeAt()
    // Two tools handed the same argument must not share a grant.
    expect(store.key("write_file", { path: "a" })).not.toBe(store.key("read_file", { path: "a" }))
  })

  test("distinct inputs produce distinct keys", () => {
    const { store } = storeAt()
    const a = store.key("write_file", { path: "a.txt" })
    const b = store.key("write_file", { path: "b.txt" })
    store.grant(a, "allow")
    expect(store.consume(b)).toBeUndefined()
    expect(store.consume(a)).toBeDefined()
  })

  test("an unconsumed grant expires", () => {
    const { store, advance } = storeAt()
    const key = store.key("write_file", { path: "a.txt" })
    store.grant(key, "allow")

    advance(31_000)
    expect(store.consume(key)).toBeUndefined()
  })

  test("an expired grant does not linger in the store", () => {
    const { store, advance } = storeAt()
    store.grant(store.key("write_file", { path: "a.txt" }), "allow")
    expect(store.size).toBe(1)

    advance(31_000)
    store.prune()
    expect(store.size).toBe(0)
  })

  test("survives input that cannot be serialised", () => {
    const { store } = storeAt()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    // Falls back to a per-tool key: sharing is lost, but nothing throws inside
    // the injected hook.
    const key = store.key("write_file", cyclic)
    expect(key).toContain("write_file")
    expect(() => store.grant(key, "allow")).not.toThrow()
  })

  test("a missing tool name is still keyable", () => {
    const { store } = storeAt()
    expect(store.key(undefined, {})).toBeTruthy()
  })
})
