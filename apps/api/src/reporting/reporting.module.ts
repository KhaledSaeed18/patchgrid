import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { ReportingConsumer } from "./reporting.consumer"
import { ReportingReconcileProcessor, ReportingReconcileService } from "./reporting-reconcile"
import { ReportsController } from "./reports.controller"
import { ReportsService } from "./reports.service"
import { ReportingRepository } from "./repositories/reporting.repository"

/** Reporting (ADR-0051): the facts, the consumer that keeps them, the reconcile that checks them, the reports. */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: "reporting-reconcile" })],
  controllers: [ReportsController],
  providers: [ReportingRepository, ReportingConsumer, ReportingReconcileService, ReportingReconcileProcessor, ReportsService],
})
export class ReportingModule {}
