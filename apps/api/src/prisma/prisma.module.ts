import { Global, Module } from "@nestjs/common"

import { DatabaseListener } from "./database-listener"
import { PrismaService } from "./prisma.service"

@Global()
@Module({ providers: [PrismaService, DatabaseListener], exports: [PrismaService, DatabaseListener] })
export class PrismaModule {}
