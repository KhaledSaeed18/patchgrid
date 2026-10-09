import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { SlaPolicyRepository } from "./repositories/sla-policy.repository"
import { SlaPoliciesController } from "./sla-policies.controller"
import { SlaPoliciesService } from "./sla-policies.service"

@Module({
  imports: [AuthModule],
  controllers: [SlaPoliciesController],
  providers: [SlaPolicyRepository, SlaPoliciesService],
  exports: [SlaPoliciesService],
})
export class SlaModule {}
