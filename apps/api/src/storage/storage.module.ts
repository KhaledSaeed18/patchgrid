import { Global, Module } from "@nestjs/common"

import { StorageService } from "./storage.service"

/** Object storage, for whichever module keeps bytes (attachments today). */
@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
