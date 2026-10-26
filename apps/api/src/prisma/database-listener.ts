import { Injectable } from "@nestjs/common"
import { type Listener, listen, OUTBOX_CHANNEL } from "@patchgrid/database"

import { type AppConfig, InjectConfig } from "../config/app-config"

export { type Listener, OUTBOX_CHANNEL }

/**
 * A dedicated `LISTEN` connection as the application role (ADR-0049), owned
 * here with the rest of the database plumbing so nothing above the data layer
 * imports `@patchgrid/database`. `LISTEN` lives as long as its session, so
 * behind a transaction-mode pooler this connection goes to the database
 * directly (DATABASE_LISTEN_URL); `NOTIFY` is sent inside a transaction and
 * pools like everything else.
 */
@Injectable()
export class DatabaseListener {
  constructor(@InjectConfig() private readonly config: AppConfig) {}

  async listen(
    channel: string,
    handlers: { onNotify: (payload: string) => void; onConnect?: () => void; onError?: (error: Error) => void },
  ): Promise<Listener> {
    return listen({ connectionString: this.config.DATABASE_LISTEN_URL ?? this.config.DATABASE_URL, channel, ...handlers })
  }
}
