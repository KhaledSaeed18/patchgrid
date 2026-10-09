import { RequestMethod, type Type } from "@nestjs/common"
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants"
import { describe, expect, it } from "vitest"

import { AppModule } from "../app.module"
import { IS_PUBLIC, IS_TENANT_OPTIONAL } from "../common/decorators/route-markers"
import { REQUIRED_PERMISSION } from "./require-permission"

/**
 * The route-coverage test (ADR-0019, RBAC.md §13.3) — the real protection
 * against an unguarded endpoint shipping. Walks the module graph from
 * `AppModule` by its decorator metadata, without booting anything, and fails
 * for any route that is neither `@Public`, `@TenantOptional`, nor carrying a
 * `@RequirePermission`.
 */

type Route = { route: string; markers: string[] }

function modulesFrom(root: Type): Set<Type> {
  const seen = new Set<Type>()
  const visit = (entry: unknown): void => {
    // A dynamic module is `{ module, imports?, controllers? }`; a static one is the class.
    const moduleClass = (typeof entry === "function" ? entry : (entry as { module?: Type } | null)?.module) as
      | Type
      | undefined
    if (moduleClass === undefined || seen.has(moduleClass)) return
    seen.add(moduleClass)
    const imports = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) as unknown[] | undefined) ?? []),
      ...(typeof entry === "object" ? ((entry as { imports?: unknown[] }).imports ?? []) : []),
    ]
    imports.forEach(visit)
  }
  visit(root)
  return seen
}

function routesOf(controller: Type): Route[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "")
  const prototype = controller.prototype as Record<string, unknown>
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .flatMap((name) => {
      const handler = prototype[name]
      if (typeof handler !== "function") return []
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined
      if (path === undefined) return []
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod]
      const markers = [
        [IS_PUBLIC, "public"],
        [IS_TENANT_OPTIONAL, "tenant-optional"],
        [REQUIRED_PERMISSION, "permission"],
      ].flatMap(([key, label]) =>
        Reflect.getMetadata(key, handler) !== undefined || Reflect.getMetadata(key, controller) !== undefined
          ? [label as string]
          : [],
      )
      return [{ route: `${method} /${base}/${path}`.replace(/\/+/g, "/").replace(/\/$/, ""), markers }]
    })
}

function allRoutes(): Route[] {
  return [...modulesFrom(AppModule)].flatMap((module) =>
    ((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) as Type[] | undefined) ?? []).flatMap(routesOf),
  )
}

describe("route coverage", () => {
  const routes = allRoutes()

  it("finds the application's routes", () => {
    // A walk that silently found nothing would pass the next test vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(15)
    expect(routes.map((r) => r.route)).toContain("POST /orgs")
  })

  it("every route is public, tenant-optional, or requires a permission", () => {
    expect(routes.filter((r) => r.markers.length === 0).map((r) => r.route)).toEqual([])
  })

  it("no route claims two answers at once", () => {
    expect(routes.filter((r) => r.markers.length > 1)).toEqual([])
  })
})
