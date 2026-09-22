import { Inject } from "@nestjs/common"

import type { Env } from "./env.schema"

export const APP_CONFIG = Symbol("APP_CONFIG")

/** `@InjectConfig() private readonly config: AppConfig` */
export const InjectConfig = (): ParameterDecorator => Inject(APP_CONFIG)

export type AppConfig = Readonly<Env> & {
  readonly isProduction: boolean
  readonly isDevelopment: boolean
  readonly isTest: boolean
}

export function toAppConfig(env: Env): AppConfig {
  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === "production",
    isDevelopment: env.NODE_ENV === "development",
    isTest: env.NODE_ENV === "test",
  })
}
