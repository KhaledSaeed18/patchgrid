import { describe, expect, it } from "vitest"

import { inTurn } from "./serial-adapter.ts"

type Transaction = Parameters<typeof inTurn>[0]

/** A transaction that records how many statements it was running at once. */
function recording(fail: (sql: string) => boolean = () => false) {
  let running = 0
  let most = 0
  const order: string[] = []
  const run = async (sql: string) => {
    running += 1
    most = Math.max(most, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running -= 1
    order.push(sql)
    if (fail(sql)) throw new Error(`failed: ${sql}`)
  }
  const tx = {
    provider: "postgres",
    adapterName: "probe",
    options: { usePhantomQuery: false },
    queryRaw: async (query: { sql: string }) => {
      await run(query.sql)
      return { columnTypes: [], columnNames: [], rows: [[query.sql]] }
    },
    executeRaw: async (query: { sql: string }) => {
      await run(query.sql)
      return 1
    },
    commit: async () => run("COMMIT"),
    rollback: async () => run("ROLLBACK"),
  } as unknown as Transaction
  return { tx, order, most: () => most }
}

const query = (sql: string) => ({ sql, args: [], argTypes: [] }) as unknown as Parameters<Transaction["queryRaw"]>[0]

describe("inTurn", () => {
  it("runs statements handed over at once one after another, in the order given", async () => {
    const probe = recording()
    const tx = inTurn(probe.tx)
    const answers = await Promise.all(["a", "b", "c"].map((sql) => tx.queryRaw(query(sql))))
    await tx.commit()
    expect(probe.most()).toBe(1)
    expect(probe.order).toEqual(["a", "b", "c", "COMMIT"])
    expect(answers.map((a) => a.rows[0]?.[0])).toEqual(["a", "b", "c"])
  })

  it("lets a failure through without stalling what is queued behind it", async () => {
    const probe = recording((sql) => sql === "bad")
    const tx = inTurn(probe.tx)
    const [bad, good] = await Promise.allSettled([tx.executeRaw(query("bad")), tx.executeRaw(query("good"))])
    expect(bad.status).toBe("rejected")
    expect(good).toEqual({ status: "fulfilled", value: 1 })
    await tx.rollback()
    expect(probe.order).toEqual(["bad", "good", "ROLLBACK"])
  })

  it("keeps the transaction's own properties", () => {
    const tx = inTurn(recording().tx)
    expect(tx.provider).toBe("postgres")
    expect(tx.options).toEqual({ usePhantomQuery: false })
  })
})
