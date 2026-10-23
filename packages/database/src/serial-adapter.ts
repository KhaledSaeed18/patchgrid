import { PrismaPg } from "@prisma/adapter-pg"

type Adapter = Awaited<ReturnType<PrismaPg["connect"]>>
type Transaction = Awaited<ReturnType<Adapter["startTransaction"]>>

/**
 * `PrismaPg`, with each transaction's statements sent one after another.
 *
 * Prisma 7's query interpreter loads an `include`'s relations with
 * `Promise.all`. Outside a transaction each lands on its own pooled
 * connection; inside one they all go to the transaction's single `pg` client,
 * which today queues them with a deprecation warning and from pg@9 refuses.
 * Postgres runs one statement at a time per connection either way, so
 * queueing here costs nothing — it only moves the queue from `pg`'s deprecated
 * path to ours.
 */
export class SerialPrismaPg extends PrismaPg {
  override async connect(): Promise<Adapter> {
    return serialised(await super.connect())
  }

  override async connectToShadowDb(): Promise<Adapter> {
    return serialised(await super.connectToShadowDb())
  }
}

function serialised(adapter: Adapter): Adapter {
  const start = adapter.startTransaction.bind(adapter)
  adapter.startTransaction = async (isolationLevel) => inTurn(await start(isolationLevel))
  return adapter
}

/** The transaction, its statements chained: each starts when the one before it settles. */
export function inTurn(transaction: Transaction): Transaction {
  let tail: Promise<unknown> = Promise.resolve()
  const next = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run, run)
    tail = result.catch(() => undefined)
    return result
  }
  const serial: Transaction = Object.create(transaction) as Transaction
  return Object.assign(serial, {
    queryRaw: (query: Parameters<Transaction["queryRaw"]>[0]) => next(() => transaction.queryRaw(query)),
    executeRaw: (query: Parameters<Transaction["executeRaw"]>[0]) => next(() => transaction.executeRaw(query)),
    commit: () => next(() => transaction.commit()),
    rollback: () => next(() => transaction.rollback()),
  })
}
