import { describe, expect, it } from "vitest"

import { unsafeDrops } from "../scripts/migration-safety.ts"

describe("unsafeDrops", () => {
  it("flags a DROP TABLE with no annotation", () => {
    expect(unsafeDrops(`-- DropTable\nDROP TABLE "Legacy";\n`)).toEqual([
      { statement: `DROP TABLE "Legacy";`, line: 2 },
    ])
  })

  it("flags a DROP COLUMN spread over several lines", () => {
    const sql = `-- AlterTable\nALTER TABLE "Ticket"\n  DROP COLUMN "legacyRef";\n`
    expect(unsafeDrops(sql)).toHaveLength(1)
  })

  it("accepts a drop whose comment block carries `-- safe:`", () => {
    const sql = `-- safe: unread since release 14\n-- DropTable\nDROP TABLE "Legacy";\n`
    expect(unsafeDrops(sql)).toEqual([])
  })

  it("does not let an annotation carry across a blank line to a later statement", () => {
    const sql = `-- safe: unread since release 14\n\nDROP TABLE "Legacy";\n`
    expect(unsafeDrops(sql)).toHaveLength(1)
  })

  it("does not let one annotation cover two statements", () => {
    const sql = `-- safe: unread since release 14\nDROP TABLE "A";\nDROP TABLE "B";\n`
    expect(unsafeDrops(sql).map((f) => f.statement)).toEqual([`DROP TABLE "B";`])
  })

  it("ignores additive statements and DROP INDEX / DROP CONSTRAINT", () => {
    const sql = `CREATE TABLE "A" (id uuid);\nDROP INDEX "x";\nALTER TABLE "A" DROP CONSTRAINT "c";\n`
    expect(unsafeDrops(sql)).toEqual([])
  })
})
