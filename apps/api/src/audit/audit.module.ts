import { BullModule } from "@nestjs/bullmq"
import { Global, Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { AUDIT_PARTITION_QUEUE, AuditPartitionProcessor, AuditPartitionService } from "./audit-partitions"
import { AuditService } from "./audit.service"
import { AuditLogRepository } from "./repositories/audit-log.repository"

/** The tenant audit log: the writer every audited change calls, and its partition upkeep. */
@Global()
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: AUDIT_PARTITION_QUEUE })],
  providers: [AuditLogRepository, AuditService, AuditPartitionService, AuditPartitionProcessor],
  exports: [AuditService],
})
export class AuditModule {}
