/**
 * The production rehearsal on emulated AWS (ADR-0058), as commands:
 *
 *   pnpm aws:up              Floci, the state backend and the platform, then a deploy
 *   pnpm aws:deploy          build → push → jobs → provision → migrate → services → healthy
 *   pnpm aws:run <job>       one job (provision, migrate, seed, verify), its logs, its exit code
 *   pnpm aws:status          every service's tasks and every target's health
 *   pnpm aws:e2e             the browser suite, through the load balancer
 *   pnpm aws:down            destroy services, jobs and the platform; Floci keeps running
 *
 * Every step is idempotent: a second `aws:up` changes nothing that is already
 * in place, and a deploy of the same commit pushes nothing new.
 *
 * Needs Docker and OpenTofu (`brew install opentofu`). The AWS calls go through
 * the SDK, so no AWS CLI is required.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs"
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr"
import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs"
import {
  DeregisterTargetsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2"
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"

const root = path.join(import.meta.dirname, "..")
const live = path.join(root, "infra/live/local")
const floci = process.env.FLOCI_ENDPOINT ?? "http://localhost:4566"
const caDir = path.join(root, "infra/.floci")
const caFile = path.join(caDir, "ca.pem")

// Floci accepts any credentials; real AWS would take them from the default chain.
const aws = { region: "us-east-1", endpoint: floci, credentials: { accessKeyId: "test", secretAccessKey: "test" } }
const ecs = new ECSClient(aws)
const logs = new CloudWatchLogsClient(aws)
const elb = new ElasticLoadBalancingV2Client(aws)

const JOBS = ["provision", "migrate", "seed", "verify"]

function title(text) {
  console.log(`\n▸ ${text}`)
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options })
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", ...options }).trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── OpenTofu ──────────────────────────────────────────────────────────────────

function tofu(stack, args) {
  run("tofu", [`-chdir=${path.join(live, stack)}`, ...args])
}

function tofuInit(stack) {
  const backend = stack === "bootstrap" ? [] : ["-backend-config=../backend.hcl"]
  tofu(stack, ["init", "-input=false", "-upgrade=false", ...backend])
}

function apply(stack, vars = {}) {
  tofuInit(stack)
  const flags = Object.entries(vars).flatMap(([name, value]) => ["-var", `${name}=${value}`])
  tofu(stack, ["apply", "-input=false", "-auto-approve", ...flags])
}

function outputs(stack) {
  return JSON.parse(capture("tofu", [`-chdir=${path.join(live, stack)}`, "output", "-json"]))
}

const value = (out, name) => out[name].value

// ─── The build ─────────────────────────────────────────────────────────────────

/** A commit, or a commit and the moment, when the tree has uncommitted changes: tags are immutable. */
function imageTag() {
  const sha = capture("git", ["rev-parse", "--short=12", "HEAD"])
  const dirty = capture("git", ["status", "--porcelain"]) !== ""
  return dirty ? `${sha}-dirty-${Date.now().toString(36)}` : sha
}

/** The build machine's architecture, which the task definitions must name. */
function cpuArchitecture() {
  return os.arch() === "arm64" ? "ARM64" : "X86_64"
}

async function ensureFloci() {
  title("Floci and Mailpit (docker compose --profile aws)")
  run("docker", ["compose", "--profile", "aws", "up", "-d", "--wait", "mailpit"])
  run("docker", ["compose", "--profile", "aws", "up", "-d", "floci"])
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${floci}/_floci/health`)
      if (response.ok) {
        const { version } = await response.json()
        console.log(`  Floci ${version} is up`)
        return
      }
    } catch {
      // not yet
    }
    await sleep(2_000)
  }
  throw new Error("Floci did not become healthy on :4566")
}

/** Floci's CA, which the overlays bake in and the browser must trust. */
async function exportCa() {
  const response = await fetch(`${floci}/_floci/ca.pem`)
  if (!response.ok) throw new Error(`Could not read Floci's CA: HTTP ${response.status}`)
  mkdirSync(caDir, { recursive: true })
  writeFileSync(caFile, await response.text())
  console.log(`  CA at ${path.relative(root, caFile)}`)
}

async function dockerLogin(registry) {
  const ecr = new ECRClient(aws)
  const { authorizationData } = await ecr.send(new GetAuthorizationTokenCommand({}))
  const token = authorizationData?.[0]?.authorizationToken
  if (token === undefined) throw new Error("ECR returned no authorization token")
  const [user, password] = Buffer.from(token, "base64").toString("utf8").split(":")
  execFileSync("docker", ["login", "--username", user, "--password-stdin", registry], {
    input: password,
    stdio: ["pipe", "ignore", "inherit"],
  })
}

function imageExists(reference) {
  return spawnSync("docker", ["manifest", "inspect", "--insecure", reference], { stdio: "ignore" }).status === 0
}

/**
 * The production images, unchanged, and over each the one layer this
 * environment adds: its private CA. Built once per commit.
 */
function buildAndPush(repositories, tag, rootDomain) {
  const local = (name) => `patchgrid/${name}:${tag}`
  const remote = (name) => `${repositories[name]}:${tag}`
  const todo = Object.keys(repositories).filter((name) => !imageExists(remote(name)))
  if (todo.length === 0) {
    console.log(`  every image for ${tag} is already in ECR`)
    return
  }

  const next = [
    `NEXT_PUBLIC_ROOT_DOMAIN=${rootDomain}`,
    "NEXT_PUBLIC_PROTOCOL=https",
    `NEXT_PUBLIC_API_URL=https://api.${rootDomain}/api/v1`,
    "NEXT_PUBLIC_APP_PORT=",
    "NEXT_PUBLIC_MARKETING_PORT=",
  ].flatMap((arg) => ["--build-arg", arg])

  const builds = {
    api: ["-f", "apps/api/Dockerfile", "--target", "runtime"],
    tools: ["-f", "apps/api/Dockerfile", "--target", "tools"],
    app: ["-f", "docker/next.Dockerfile", "--build-arg", "APP=app", ...next],
    www: ["-f", "docker/next.Dockerfile", "--build-arg", "APP=www", ...next],
  }

  for (const name of todo) {
    if (name === "pgbouncer") {
      title(`pgbouncer: mirrored, trusting the environment's CA`)
      run("docker", ["build", "-q", "-f", "infra/images/pgbouncer.Dockerfile", "-t", remote(name), caDir])
    } else {
      title(`${name}: the production image`)
      run("docker", ["build", ...builds[name], "-t", local(name), "."])
      title(`${name}: with the environment's CA`)
      run("docker", [
        "build",
        "-q",
        "-f",
        "infra/images/private-ca.Dockerfile",
        "--build-arg",
        `BASE=${local(name)}`,
        "-t",
        remote(name),
        caDir,
      ])
    }
    run("docker", ["push", "-q", remote(name)])
  }
}

// ─── Jobs ──────────────────────────────────────────────────────────────────────

async function printLogs(group, stream) {
  let token
  for (;;) {
    const page = await logs.send(
      new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: true, nextToken: token }),
    )
    for (const event of page.events ?? []) console.log(`  │ ${event.message}`)
    if (page.nextForwardToken === undefined || page.nextForwardToken === token) return
    token = page.nextForwardToken
  }
}

/** Scales one service and waits until that many of its tasks run; returns the count it had. */
async function scale(cluster, service, desiredCount) {
  const before = (await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }))).services?.[0]
  if (before === undefined) throw new Error(`No service ${service}`)
  await ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount }))
  for (let waited = 0; ; waited += 3) {
    const now = (await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }))).services?.[0]
    if (now?.runningCount === desiredCount) return before.desiredCount
    if (waited > 300) throw new Error(`${service} did not reach ${desiredCount} running tasks`)
    await sleep(3_000)
  }
}

/**
 * The tenancy suite must be the only consumer of the outbox it writes: a live
 * worker on the same database hears its NOTIFY, drains its events and
 * publishes them on its own Redis, where the suite's streams never hear them.
 * So the worker steps out for the run, and comes back however it ends. Nothing
 * is lost meanwhile: the outbox is durable, and the worker drains what waited.
 */
async function withoutWorker(fn) {
  const cluster = value(outputs("platform"), "cluster").name
  title("worker: out of service while the suite runs")
  const previous = await scale(cluster, "worker", 0)
  try {
    await fn()
  } finally {
    title(`worker: back to ${previous}`)
    await scale(cluster, "worker", previous)
  }
}

/** RunTask, wait for it to stop, print its logs, and fail on a non-zero exit. */
async function runJob(name) {
  if (!JOBS.includes(name)) throw new Error(`No job ${JSON.stringify(name)}. Jobs: ${JOBS.join(", ")}`)
  if (name === "verify") return withoutWorker(() => runTask(name))
  return runTask(name)
}

async function runTask(name) {
  const jobs = outputs("jobs")
  const { cluster, subnets, security_groups: securityGroups } = value(jobs, "run")
  const definition = value(jobs, "task_definitions")[name]
  const platform = outputs("platform")
  const group = value(platform, "cluster").log_groups.jobs

  title(`job ${name}`)
  const started = await ecs.send(
    new RunTaskCommand({
      cluster,
      taskDefinition: definition,
      launchType: "FARGATE",
      networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: "DISABLED" } },
    }),
  )
  const task = started.tasks?.[0]
  if (task?.taskArn === undefined) throw new Error(`RunTask started nothing: ${JSON.stringify(started.failures)}`)

  let described
  for (let waited = 0; ; waited += 3) {
    described = (await ecs.send(new DescribeTasksCommand({ cluster, tasks: [task.taskArn] }))).tasks?.[0]
    if (described?.lastStatus === "STOPPED") break
    if (waited > 1_800) throw new Error(`job ${name} is still running after 30 minutes`)
    await sleep(3_000)
  }
  const container = described.containers?.[0]
  await printLogs(group, `${name}/${name}/${task.taskArn.split("/").pop()}`).catch(() => console.log("  (no logs)"))
  if (container?.exitCode !== 0) {
    throw new Error(`job ${name} exited ${container?.exitCode ?? "without a code"}: ${described.stoppedReason ?? container?.reason ?? ""}`)
  }
  console.log(`  ${name} succeeded`)
}

// ─── Health ───────────────────────────────────────────────────────────────────

/**
 * Settled, not merely healthy: every service on one deployment with all its
 * tasks running, and every target group holding exactly that many targets, all
 * healthy. Mid-rollout the old tasks are healthy too, and still serving.
 */
async function status() {
  const platform = outputs("platform")
  const cluster = value(platform, "cluster").name
  const services = value(outputs("services"), "services")
  const described = await ecs.send(new DescribeServicesCommand({ cluster, services }))
  let settled = true
  const desired = {}
  title("services")
  for (const service of described.services ?? []) {
    const deployments = service.deployments?.length ?? 0
    desired[service.serviceName] = service.desiredCount
    if (deployments !== 1 || service.runningCount !== service.desiredCount) settled = false
    console.log(`  ${service.serviceName.padEnd(10)} ${service.runningCount}/${service.desiredCount} running, ${deployments} deployment(s)`)
  }
  title("targets")
  for (const [name, arn] of Object.entries(value(platform, "target_groups"))) {
    const health = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }))
    const states = (health.TargetHealthDescriptions ?? []).map((target) => target.TargetHealth?.State ?? "unknown")
    if (states.length !== desired[name] || states.some((state) => state !== "healthy")) settled = false
    console.log(`  ${name.padEnd(10)} ${states.join(", ") || "no targets"}`)
  }
  return settled
}

/** A running task's address on the Docker network, which is what Floci registers as its target. */
function taskAddresses(taskId, service) {
  try {
    return capture("docker", [
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
      `floci-aws-ecs-${taskId}-${service}`,
    ]).split(" ")
  } catch {
    return []
  }
}

/**
 * ECS deregisters a task's target when the task stops; Floci leaves it, so
 * after any rollout the old task's target stays behind, unhealthy for good.
 * This does what ECS would: every target that is not a running task of its
 * service goes. A group whose tasks cannot be seen is left alone.
 */
async function deregisterStaleTargets(platform) {
  const cluster = value(platform, "cluster").name
  for (const [service, arn] of Object.entries(value(platform, "target_groups"))) {
    const tasks = (await ecs.send(new ListTasksCommand({ cluster, serviceName: service, desiredStatus: "RUNNING" }))).taskArns ?? []
    const live = new Set(tasks.flatMap((task) => taskAddresses(task.split("/").pop(), service)).filter((ip) => ip !== ""))
    if (live.size === 0) continue
    const health = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }))
    const stale = (health.TargetHealthDescriptions ?? []).map((d) => d.Target).filter((t) => t?.Id !== undefined && !live.has(t.Id))
    if (stale.length === 0) continue
    await elb.send(new DeregisterTargetsCommand({ TargetGroupArn: arn, Targets: stale }))
    console.log(`  ${service}: deregistered ${stale.map((t) => `${t.Id}:${t.Port}`).join(", ")}, left by stopped tasks`)
  }
}

/** Applies the services and waits until every target is healthy, or fails. */
async function rollOut(vars) {
  apply("services", vars)
  const platform = outputs("platform")
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await deregisterStaleTargets(platform)
    if (await status()) return
    await sleep(5_000)
  }
  throw new Error("the services did not all turn healthy within five minutes")
}

/**
 * The API's rate limits off for the length of a browser suite run, and back on
 * however it ends: one rollout of api and worker each way. Floci's load
 * balancer sends no X-Forwarded-For, so every client shares one address, and
 * the suite would spend the per-IP budget in seconds (ADR-0058).
 */
async function withoutThrottles(fn) {
  const release = value(outputs("services"), "release")
  title("services: rate limits off for the browser suite")
  await rollOut({ ...release, throttle_enabled: false })
  try {
    await fn()
  } finally {
    title("services: rate limits back on")
    await rollOut(release)
  }
}

/** Through the load balancer, the way a browser comes in: TLS, the host, readiness. */
async function smoke(rootDomain) {
  title("through the load balancer")
  for (const [host, pathname] of [
    [`api.${rootDomain}`, "/health/ready"],
    [`app.${rootDomain}`, "/api/health"],
    [rootDomain, "/api/health"],
  ]) {
    const out = capture("curl", [
      "-fsS",
      "--cacert",
      caFile,
      "--resolve",
      `${host}:443:127.0.0.1`,
      "-o",
      "/dev/null",
      "-w",
      "%{http_code} %{ssl_verify_result}",
      `https://${host}${pathname}`,
    ])
    console.log(
      `  https://${host}${pathname} → ${out.split(" ")[0]}, certificate ${out.split(" ")[1] === "0" ? "verified" : "NOT verified"}`,
    )
  }
}

// ─── The browser suite ─────────────────────────────────────────────────────────

/**
 * The browser suite against the deployed stack (ADR-0058): https on the root
 * domain, every host sent to the load balancer and Floci's CA trusted, by
 * Chromium and by the suite's own requests, with nothing changed on this
 * machine. The SLA spec moves one deadline as the owner, through Floci's RDS
 * proxy. The SSO spec is left out: its Keycloak is on this machine, which a
 * task cannot reach, and production refuses a private issuer.
 */
async function e2e() {
  const platform = outputs("platform")
  const rootDomain = value(platform, "root_domain")
  const secrets = new SecretsManagerClient(aws)
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: value(platform, "secrets").migration }))
  // The task's URL names the database by its in-network name and verifies it; here it is a forwarded port.
  const owner = new URL(JSON.parse(SecretString ?? "{}").DATABASE_MIGRATION_URL)
  owner.hostname = "localhost"
  owner.searchParams.set("sslmode", "no-verify")

  await exportCa()
  await runJob("seed")

  const specs = readdirSync(path.join(root, "apps/app/e2e")).filter((file) => file.endsWith(".spec.ts") && file !== "sso.spec.ts")
  await withoutThrottles(async () => {
    title(`browser suite: ${specs.join(", ")}`)
    runSuite(specs, rootDomain, owner)
  })
}

function runSuite(specs, rootDomain, owner) {
  const result = spawnSync("pnpm", ["--filter", "@patchgrid/app", "exec", "playwright", "test", ...specs.map((spec) => `e2e/${spec}`)], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_ROOT_DOMAIN: rootDomain,
      E2E_PROTOCOL: "https",
      E2E_APP_PORT: "",
      E2E_API_PORT: "",
      E2E_RESOLVE_TO: "127.0.0.1",
      E2E_CA_FILE: caFile,
      NODE_EXTRA_CA_CERTS: caFile,
      DATABASE_MIGRATION_URL: owner.toString(),
    },
  })
  if (result.status !== 0) throw new Error(`the browser suite failed (exit ${result.status ?? "by signal"})`)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function deploy() {
  const platform = outputs("platform")
  const repositories = value(platform, "repositories")
  const rootDomain = value(platform, "root_domain")
  const tag = imageTag()
  const vars = { image_tag: tag, cpu_architecture: cpuArchitecture() }
  title(`deploying ${tag} (${vars.cpu_architecture})`)

  await exportCa()
  await dockerLogin(repositories.api.split("/")[0])
  buildAndPush(repositories, tag, rootDomain)

  title("jobs: the task definitions for this build")
  apply("jobs", vars)
  // Before any task of the new release starts: the schema it needs exists, and
  // every migration is additive, so the old release keeps working meanwhile.
  await runJob("provision")
  await runJob("migrate")

  title("services: rolling forward, waiting for steady state")
  await rollOut(vars)
  await smoke(rootDomain)
}

async function up() {
  await ensureFloci()
  await exportCa()
  title("state backend")
  apply("bootstrap")
  title("platform")
  apply("platform")
  await deploy()
  const rootDomain = value(outputs("platform"), "root_domain")
  console.log(`
Up. In a browser, once (see infra/README.md):
  · trust ${path.relative(root, caFile)} (Floci's CA, which signed the ACM certificate)
  · resolve *.${rootDomain} to 127.0.0.1
then https://app.${rootDomain}. \`pnpm aws:run seed\` adds the demo workspaces.`)
}

async function down() {
  for (const stack of ["services", "jobs", "platform"]) {
    title(`destroying ${stack}`)
    tofuInit(stack)
    const vars = stack === "platform" ? [] : ["-var", "image_tag=unused"]
    tofu(stack, ["destroy", "-input=false", "-auto-approve", ...vars])
  }
  console.log("\nDestroyed. Floci and the state backend are left running: `docker compose --profile aws down` stops them.")
}

const [command, argument] = process.argv.slice(2)
const commands = {
  up,
  deploy,
  down,
  status: async () => {
    if (!(await status())) process.exitCode = 1
  },
  run: () => runJob(argument),
  e2e,
}

if (!(command in commands)) {
  console.error(`Usage: node scripts/aws.mjs <${Object.keys(commands).join("|")}> [job]`)
  process.exit(2)
}
if (!existsSync(path.join(live, "backend.hcl"))) throw new Error("infra/live/local is missing")

try {
  await commands[command]()
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
