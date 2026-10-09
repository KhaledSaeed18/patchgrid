import { BullModule } from "@nestjs/bullmq"
import { Global, Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { AUDIT_PARTITION_QUEUE, AuditPartitionProcessor, AuditPartitionService } from "./audit-partitions"
import { AuditService } from "./audit.service"
import { OrgAuditController } from "./org-audit.controller"
import { OrgAuditService } from "./org-audit.service"
import { AuditLogRepository } from "./repositories/audit-log.repository"

/** The tenant audit log: the writer every audited change calls, its reader for admins, and partition upkeep. */
@Global()
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: AUDIT_PARTITION_QUEUE })],
  controllers: [OrgAuditController],
  providers: [AuditLogRepository, AuditService, OrgAuditService, AuditPartitionService, AuditPartitionProcessor],
  exports: [AuditService, OrgAuditService],
})
export class AuditModule {}
