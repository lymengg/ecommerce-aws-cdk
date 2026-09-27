# E-commerce Platform Infrastructure

AWS CDK (v2, TypeScript) infrastructure for a production-oriented e-commerce platform, plus the
containerised Spring Boot API that runs on it.

**Phase 1** delivers the networking foundation: a VPC with public and private subnets spread over
Availability Zones, correct routing through an Internet Gateway and NAT Gateways, the three-tier
security group model, VPC Flow Logs, and the stack outputs later phases consume.

**Phase 2** delivers the application compute: a minimal Spring Boot product API, packaged as a
container image, stored in ECR and run as a single ECS Fargate task behind an internet-facing
Application Load Balancer, with container logs in CloudWatch.

No database, cache, queue, authentication, CI/CD or auto scaling exists yet. Those are Phase 3+ and
are listed at the end of this document.

---

## Table of contents

1. [Architecture](#architecture)
2. [Project structure](#project-structure)
3. [Stacks and deployment order](#stacks-and-deployment-order)
4. [Core concepts: the network](#core-concepts-the-network)
5. [Core concepts: the application tier](#core-concepts-the-application-tier)
6. [The Spring Boot application](#the-spring-boot-application)
7. [The container image](#the-container-image)
8. [ECR: how an image is tagged and pushed](#ecr-how-an-image-is-tagged-and-pushed)
9. [IAM: execution role versus task role](#iam-execution-role-versus-task-role)
10. [Security group model](#security-group-model)
11. [Environments and configuration](#environments-and-configuration)
12. [Tags](#tags)
13. [Stack outputs](#stack-outputs)
14. [Removal policies and resource protection](#removal-policies-and-resource-protection)
15. [Commands](#commands)
16. [Testing](#testing)
17. [Cost expectations](#cost-expectations)
18. [Phase 3 and beyond](#phase-3-and-beyond)

---

## Architecture

The Phase 2 request path:

```
                              Internet
                                 │
                                 │ HTTP :80
                                 ▼
                    ┌────────────────────────┐
                    │ Application Load       │
                    │ Balancer               │
                    │ public subnets         │
                    │ security group: Alb    │
                    └───────────┬────────────┘
                                │
                                │ HTTP :8080 (by security group reference)
                                ▼
                    ┌────────────────────────┐
                    │ ECS Service            │
                    │ desiredCount = 1       │
                    └───────────┬────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │ Fargate Task           │
                    │ Spring Boot API        │
                    │ private subnet         │
                    │ port 8080              │
                    │ security group: App    │
                    └───────────┬────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │ CloudWatch Logs        │
                    └────────────────────────┘

        ECR ──────── container image ────────▶ Fargate Task
```

The whole platform, network and compute:

```
                              Internet
                                 │
                                 ▼
                        Internet Gateway
                                 │
        ┌────────────────────────┴────────────────────────┐
        │                      VPC                        │
        │                  10.0.0.0/16                    │
        │                                                 │
        │   AZ-A                        AZ-B              │
        │                                                 │
        │   Public subnet               Public subnet     │
        │       │                           │             │
        │   ALB ─┘                       NAT Gateway      │
        │       │                           │             │
        │   Private subnet              Private subnet    │
        │       │                           │             │
        │   Fargate task ───────────────────┘             │
        │                                                 │
        │        Future: RDS / Redis                      │
        │                                                 │
        └─────────────────────────────────────────────────┘
```

Traffic paths created by the stacks:

| Source            | Destination                | Path                                              |
| ----------------- | -------------------------- | ------------------------------------------------- |
| Internet → public | Application Load Balancer  | Internet Gateway → public subnet route table      |
| ALB → task        | ECS/Fargate task           | public subnet → private subnet, security groups only |
| Private → Internet | NAT Gateway → Internet Gateway | public subnet → IGW (image pulls, patches)   |
| Internet → private | **not possible**          | private route table has no route to the IGW       |

Security group chain:

```
Internet ──80──▶ ALB SG ──8080──▶ Application SG ──5432──▶ Database SG
                                     │
                                     └──443──▶ Internet (via NAT, e.g. image pulls)
```

---

## Project structure

```
aws-cdk/
├── ecommerce-infrastructure/         # CDK app (TypeScript)
│   ├── bin/
│   │   └── ecommerce.ts              # CDK app entry point: resolve env, build the stacks
│   ├── lib/
│   │   ├── config/
│   │   │   ├── types.ts              # EnvironmentConfig + ApplicationConfig interfaces
│   │   │   ├── validation.ts         # fail-fast validation of an environment config
│   │   │   ├── dev.ts                # dev values
│   │   │   ├── uat.ts                # uat values
│   │   │   ├── prod.ts               # prod values
│   │   │   └── index.ts              # environment + image tag resolution, config lookup
│   │   ├── constructs/
│   │   │   ├── tier-security-groups.ts   # ALB / application / database security groups
│   │   │   ├── vpc-flow-logs.ts          # optional flow logging + its least-privilege role
│   │   │   └── load-balanced-api.ts      # Fargate task, ECS service, ALB, target group, listener
│   │   ├── stacks/
│   │   │   ├── network-stack.ts      # VPC, subnets, routing, security groups, outputs
│   │   │   ├── ecr-stack.ts          # container registry
│   │   │   └── application-stack.ts  # ECS cluster, service, ALB, IAM, logs
│   │   └── tags.ts                   # the shared tag contract
│   ├── test/
│   │   ├── network-stack.test.ts     # network contract tests (CDK assertions)
│   │   ├── ecr-stack.test.ts         # registry contract tests
│   │   ├── application-stack.test.ts # compute contract tests
│   │   └── config.test.ts            # configuration tests
│   ├── cdk.json
│   ├── jest.config.js
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md                     # this file
│
└── application/                      # the Spring Boot API
    ├── src/main/java/com/ecommerce/api/
    │   ├── EcommerceApiApplication.java
    │   ├── controller/ProductController.java
    │   ├── service/ProductService.java
    │   └── model/Product.java
    ├── src/main/resources/application.properties
    ├── src/test/java/com/ecommerce/api/ProductApiTest.java
    ├── pom.xml
    ├── Dockerfile
    ├── .dockerignore
    └── .gitignore
```

`bin/ecommerce.ts` contains no environment values: it resolves the environment, loads its
configuration and hands it to the stacks. No stack contains environment values either — everything
arrives through `EnvironmentConfig`, which is why the same stack code produces dev, uat and prod.

---

## Stacks and deployment order

| Stack | Name | Creates |
| ----- | ---- | ------- |
| Network | `ecommerce-network-<env>` | VPC, subnets, gateways, route tables, tier security groups, flow logs |
| Registry | `ecommerce-ecr-<env>` | ECR repository |
| Application | `ecommerce-application-<env>` | ECS cluster, task definition, ECS service, ALB, target group, listener, log group, IAM roles |

The registry is a **separate stack from the compute** on purpose. An ECS service cannot start until
an image exists, and an image can only be pushed once the repository exists, so the repository has
to be creatable — and an image pushable — before the application stack is deployed. Keeping the
registry separate also means recreating the compute never touches the images, and in uat/prod the
registry can be retained while everything else is disposable.

The application stack consumes the network stack's VPC and security groups and the registry stack's
repository **by reference** (CDK cross-stack references), so the CDK CLI orders the stacks
automatically and there is exactly one definition of each resource.

> Cross-stack references use **weak** strength (`"@aws-cdk/core:defaultCrossStackReferences": "weak"`
> in `cdk.json`). A weak reference reads the producer's output directly instead of locking an export
> in place, which avoids the "deadly embrace" where a producer stack can no longer be updated or
> deleted because a consumer still imports one of its exports. This is the recommended setting for a
> new project; there is nothing deployed yet to migrate.

---

## Core concepts: the network

### VPC

An isolated, software-defined network. Everything the platform runs lives inside this VPC and is
addressable only through the routes and security groups defined here. The VPC is the blast radius of
the environment: prod cannot reach dev, and neither can be reached from the internet unless a route
and a security group rule explicitly allow it.

DNS support and DNS hostnames are enabled because later phases need them: RDS endpoints, interface
VPC endpoints, and ECS service discovery all resolve names rather than IP addresses.

### CIDR

`10.0.0.0/16` is a private (RFC 1918) IPv4 range. The `/16` is the prefix length: the first 16 bits
are fixed, leaving 65,536 addresses. Each environment uses a different block — `10.0.0.0/16` (dev),
`10.1.0.0/16` (uat), `10.2.0.0/16` (prod) — so the networks can later be peered or attached to a
Transit Gateway without re-addressing, which is otherwise a disruptive migration.

### Subnet

A slice of the VPC CIDR in a single Availability Zone. Each subnet here is a `/24` (256 addresses,
254 usable after AWS reserves five). Subnets exist per Availability Zone because an Availability Zone
is a physically separate data centre: spreading resources across subnets in different zones is what
makes the platform survive the loss of one.

### Availability Zone

An isolated location inside a region, with independent power, cooling and networking. This project
places one public and one private subnet in each zone — two zones in dev and uat, three in prod — and
one NAT Gateway per zone in prod.

The zone list is passed to the VPC explicitly instead of through CDK's `maxAzs`, because `maxAzs` is
silently capped at **two** zones whenever the stack environment is not fully resolved, which is the
default here since no account id is pinned in source. See the comment on `availabilityZoneTokens()` in
`lib/stacks/network-stack.ts`, and the test that synthesises production without a pinned account to
keep the configured zone count honest.

### Public subnet

A subnet whose route table has a route to an Internet Gateway, which makes it routable from the
internet. It hosts only resources that must be reachable from outside: the Application Load Balancer
and the NAT Gateways. `mapPublicIpOnLaunch` is switched off, so nothing launched here gets a public
IP by accident; an ALB and a NAT Gateway do not need one on their network interface.

### Private subnet

A subnet with **no** route to the Internet Gateway. Outbound traffic goes through a NAT Gateway
instead, and inbound traffic from the internet is impossible at the routing layer. The application
tier (ECS tasks) and the data tier (RDS, Redis) live here, which is what keeps a database or a
container out of reach even if a security group is misconfigured later.

### Route table

The per-subnet routing decision table. `0.0.0.0/0` is the default route — "everything I do not
otherwise know how to reach". The stacks produce exactly two routing models:

```
Public subnet                          Private subnet
0.0.0.0/0                              0.0.0.0/0
    ↓                                       ↓
Internet Gateway                        NAT Gateway (in a public subnet)
                                            ↓
                                        Internet Gateway
```

### Internet Gateway

The managed, highly available door between the VPC and the internet. It performs one-to-one NAT for
resources that have a public address. It is attached to the VPC once and referenced by every public
subnet's default route. Without an entry in a route table it routes nothing — which is precisely why
private subnets never mention it.

### NAT Gateway

A managed service that lets resources *without* a public address initiate outbound connections. It
lives in a public subnet with an Elastic IP, and it only allows connections that start inside the
VPC: an inbound connection from the internet cannot be established through it. That asymmetry is the
whole point — the ECS task pulls its container image and applies patches through the NAT Gateway,
but nothing can dial in.

**NAT Gateways are billed per hour and per GB processed**, so their count is the main cost lever.
A NAT Gateway lives in exactly one Availability Zone; if that zone fails, every subnet routed through
it loses outbound connectivity.

| Configuration | Outbound connectivity if an AZ fails | Relative NAT cost | Used here |
| ------------- | ------------------------------------ | ----------------- | --------- |
| 1 NAT Gateway | Lost for every private subnet | 1x | `dev` |
| 1 NAT Gateway per AZ (2 AZs) | Survives; the other zone keeps working | 2x | `uat` |
| 1 NAT Gateway per AZ (3 AZs) | Survives; 2/3 capacity remains | 3x | `prod` |
| 0 NAT Gateways | No outbound access at all (isolated) | 0 | not used |

---

## Core concepts: the application tier

### ECR (Elastic Container Registry)

A private, IAM-secured registry for container images. The image the ECS task runs is pushed here, and
the task's execution role is granted pull access scoped to this one repository. Scanning on push
records known vulnerabilities against every image; a lifecycle rule expires untagged images after 14
days so build leftovers do not accumulate. See [ECR: how an image is tagged and pushed](#ecr-how-an-image-is-tagged-and-pushed).

### ECS (Elastic Container Service)

The container orchestrator. It decides *where* containers run, starts and stops tasks, replaces
unhealthy ones, and keeps the number of running tasks at the service's desired count. It is a control
plane: on its own it schedules onto capacity you provide.

### Fargate

The serverless compute engine for containers. With Fargate you do not manage any EC2 instances: you
declare the CPU and memory a task needs, and AWS provisions, patches and scales the underlying
capacity. You are billed for the vCPU and memory the task reserves while it runs. This is what the
project uses.

### EC2 launch type

The alternative to Fargate. With the EC2 launch type, **you** own the cluster's capacity: you create
an Auto Scaling group of EC2 instances, register them with the cluster, choose the AMI and instance
type, and patch and scale them. It is cheaper per unit of compute at sustained, high utilisation and
gives control over instance types and GPU/hardware, but you pay for the capacity even when no task is
running and you carry the operational burden of the instances.

| | ECS (control plane) | Fargate (launch type) | EC2 launch type |
| --- | --- | --- | --- |
| What it is | Orchestrator | Serverless capacity | Self-managed capacity |
| Who patches hosts | n/a | AWS | You |
| Billing unit | none | per task vCPU/memory-second | per EC2 instance-hour, running or not |
| Scaling | n/a | per task | per task **and** per instance |
| Best for | all of the below | small, variable, low-ops workloads | large, steady, cost-sensitive workloads |
| Used here | yes | **yes** | no |

### ECS cluster

A logical grouping of services and tasks — a namespace, not a pool of servers under Fargate. The
cluster `ecommerce-<env>-cluster` holds the one service this phase creates.

### Task definition

The blueprint for a task: which image to run, how much CPU and memory, which ports to expose, which
log configuration to use, and which IAM roles to assume. It is versioned — changing it creates a new
revision, and the service is redeployed onto it. The task definition here uses:

| Setting | dev / uat | prod |
| ------- | --------- | ---- |
| CPU | 512 units (0.5 vCPU) | 1024 units (1 vCPU) |
| Memory | 1024 MiB | 2048 MiB |
| Network mode | `awsvpc` (required by Fargate) | same |
| Container port | 8080 | same |
| Image | `<registry>/ecommerce-<env>-api:<tag>` | same |

The JVM needs more headroom than a typical process, which is why the smallest Fargate size (256 CPU
/ 512 MiB) is not used: 512/1024 comfortably runs a Spring Boot API, and production is sized up.

### Task

A single running instance of a task definition — here, one container running the Spring Boot API. The
ECS service keeps exactly one of these running in this phase.

### ECS service

Keeps a desired number of tasks running, restarts them if they fail, registers them with a load
balancer target group, and performs rolling deployments. This service runs `desiredCount = 1` in the
private subnets, carries the application security group, and has no public IP. The deployment circuit
breaker is enabled with rollback, so a task that never becomes healthy is rolled back automatically
instead of leaving a half-deployed service behind.

### Application Load Balancer (ALB)

A layer-7 load balancer. It is internet-facing, lives in the public subnets, carries the ALB security
group, and forwards HTTP traffic to the ECS service's target group. It is the only internet-facing
resource in the platform; the task itself has no public address.

### Target group

The set of backends the ALB forwards to. Because Fargate uses the `awsvpc` network mode, targets are
addressed by **IP**, and the ECS service registers and deregisters task IPs automatically — no task
address is ever managed by hand. The health check is what decides whether a task receives traffic:

| Setting | Value |
| ------- | ----- |
| Protocol / port | HTTP / 8080 |
| Target type | `ip` |
| Health check path | `/actuator/health` |
| Healthy / unhealthy threshold | 2 / 3 |
| Interval / timeout | 30s / 5s |
| Success code | `200` |

### Listener

Accepts connections on a port and forwards them. Phase 2 creates one HTTP listener on **port 80**
that forwards to the target group. HTTPS (a certificate, a port 443 listener and a redirect from 80)
is a later phase; until then the endpoint is plaintext, which is fine for a learning deployment but
must not carry real user data.

### CloudWatch Logs

The container's `stdout`/`stderr` are shipped to the log group `/ecs/ecommerce-<env>-api` by the
`awslogs` driver. This is where you look when a task starts and immediately stops. Retention follows
the environment, and the execution role is granted write access to exactly this log group.

---

## The Spring Boot application

`application/` is a minimal Spring Boot API. It uses **Java 21** (the current LTS) and **Spring Boot
4.1.1**, with Spring Web, Spring Boot Actuator and Spring Boot Test.

Structure:

```
controller  →  service  →  model
```

| Layer | Class | Responsibility |
| ----- | ----- | -------------- |
| Controller | `ProductController` | Maps HTTP to the service; holds no state |
| Service | `ProductService` | In-memory product storage |
| Model | `Product` | Immutable record: `id`, `name`, `price` |

### Endpoints

| Method | Path | Behaviour |
| ------ | ---- | --------- |
| `GET` | `/api/products` | Returns all products, ordered by id |
| `GET` | `/api/products/{id}` | Returns one product, or `404` |
| `POST` | `/api/products` | Creates a product, returns `201` with the assigned id |
| `GET` | `/actuator/health` | Returns `{"status":"UP"}` — the ALB health check target |

Example:

```bash
curl http://<alb-dns-name>/api/products
# [{"id":1,"name":"Laptop","price":1200.00},{"id":2,"name":"Smartphone","price":800.00}]

curl -X POST http://<alb-dns-name>/api/products \
     -H 'Content-Type: application/json' \
     -d '{"name":"Tablet","price":450.00}'
# {"id":3,"name":"Tablet","price":450.00}

curl http://<alb-dns-name>/actuator/health
# {"status":"UP"}
```

### Why in-memory

There is deliberately no database. `ProductService` seeds two products and keeps them in a
`ConcurrentHashMap`. State is lost when the task stops, which is acceptable because this phase runs
exactly one task and exists to prove the deploy path, not to store data. A later phase replaces the
service with a real repository backed by RDS.

### Port and health

The application listens on **8080** (`server.port`), which is also the container port in the task
definition and the target group port — the ECS task passes `SERVER_PORT` so all three stay in sync.
Actuator exposes **only** the `health` endpoint over HTTP, with details suppressed, because that
endpoint is publicly reachable through the load balancer.

---

## The container image

`application/Dockerfile` is a multi-stage build:

```
pom.xml ──▶ dependency:go-offline   (cached dependency layer)
src/    ──▶ mvn package             (compile + executable jar)
              │
              ▼
        target/*.jar ──▶ eclipse-temurin:21-jre-alpine  (JRE only, non-root)
```

Design points:

- **Two stages.** The build stage uses `maven:3.9-eclipse-temurin-21`; the final image uses
  `eclipse-temurin:21-jre-alpine`. No Maven, sources or dependency cache end up in the final image.
- **Layer caching.** `pom.xml` is copied and dependencies resolved before `src/` is copied, so the
  slow dependency download is only repeated when dependencies change.
- **Non-root.** A dedicated `app` user is created and the process runs as it (`USER app`), so a
  compromised process is not root inside the container.
- **Small.** Only the packaged jar crosses the stage boundary.
- **No secrets.** No credentials are baked into the image. If the application ever needs AWS access,
  it uses the task role's temporary credentials at runtime — never a key in the image.
- **Container-aware heap.** `-XX:MaxRAMPercentage=75.0` sizes the JVM heap from the container's memory
  limit rather than the host's, so the task's configured memory is what the JVM actually respects.

---

## ECR: how an image is tagged and pushed

The image is **not** built or pushed by the infrastructure stack. CDK creates the repository; a
person or pipeline builds, tags and pushes the image. This keeps a mutable `latest` image out of the
deployment path: the task definition references an **immutable tag**, and `resolveImageTag()` refuses
`latest` outright, so a task replacement can never silently deploy an image nobody reviewed.

The configured tag is `v0.1.0` (`application.imageTag`). It can be overridden per deploy without
editing source, via `-c imageTag=<tag>` or the `IMAGE_TAG` environment variable.

```bash
# 1. Deploy the registry first, so the repository exists.
npx cdk deploy ecommerce-ecr-dev -c environment=dev

# 2. Build the image and tag it with the registry URI and the immutable tag.
docker build -t ecommerce-api:v0.1.0 application
docker tag ecommerce-api:v0.1.0 <account>.dkr.ecr.ap-southeast-1.amazonaws.com/ecommerce-dev-api:v0.1.0

# 3. Authenticate Docker to ECR and push.
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-southeast-1.amazonaws.com
docker push <account>.dkr.ecr.ap-southeast-1.amazonaws.com/ecommerce-dev-api:v0.1.0

# 4. Deploy the compute; the service now finds the image and starts a task.
npx cdk deploy ecommerce-application-dev -c environment=dev
```

`<account>` is the AWS account id. The repository URI is exported as
`ecommerce-dev-ecr-repository-uri` if you would rather read it from the stack than construct it.

To ship a new version, push a **new** tag (for example `v0.2.0`) and deploy with
`-c imageTag=v0.2.0`. Reusing a tag means a task replacement may run a different image than the one
that was reviewed, which is exactly what the immutability rule prevents.

---

## IAM: execution role versus task role

The two roles look similar but do completely different jobs. Mixing them up is the most common ECS
IAM mistake, so the distinction is explicit here.

```
Execution role                         Task role
──────────────                         ─────────
Assumed by the ECS agent               Assumed by the application code
before the container starts            inside the container

"Get the container running"            "What the container may do"

ecr: pull the image                    Phase 2: nothing
logs: create the stream, write logs
```

| | Execution role | Task role |
| --- | --- | --- |
| Assumed by | The ECS container agent | The application process |
| When | Before the container starts | While the container runs |
| Used for | Pulling the image, writing logs | Calling AWS services the app uses |
| Phase 2 permissions | ECR pull + CloudWatch log write | **none** |

**Execution role.** ECS assumes it to perform the two infrastructure actions it needs before the
container runs. The permissions are granted with scoped CDK `grant` calls rather than the broad
`AmazonECSTaskExecutionRolePolicy` managed policy:

- `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` — scoped to the
  one repository.
- `ecr:GetAuthorizationToken` — an account-level action that cannot be scoped to a repository, so it
  is the only statement with a `*` resource.
- `logs:CreateLogStream`, `logs:PutLogEvents` — scoped to the one log group.

**Task role.** Assumed by the application itself. In Phase 2 the API only uses in-memory data, so the
role carries **no permissions at all** — a compromised container has no AWS credentials worth using.
It exists now so later phases attach permissions (S3, SQS, Secrets Manager) to a role that is already
wired into the task definition.

`test/application-stack.test.ts` asserts that the execution role has no wildcard action, that its
only `*` resource is `ecr:GetAuthorizationToken`, and that the task role has no attached policy.

---

## Security group model

Three groups, linked by reference:

| Security group | Inbound | Outbound |
| -------------- | ------- | -------- |
| `Alb` | TCP 80 from `0.0.0.0/0` (Phase 2), TCP 443 from `0.0.0.0/0` (Phase 1) | TCP 8080 to `Application` (by reference) |
| `Application` | TCP 8080 from `Alb` (by reference) | TCP 5432 to `Database` (by reference), TCP 443 to `0.0.0.0/0` (NAT egress) |
| `Database` | TCP 5432 from `Application` (by reference) | nothing |

Rules and rationale:

- **The database tier has no CIDR-based inbound rule at all.** The only way to reach it is from a
  resource carrying the application security group.
- **The application tier has no inbound rule from the internet**, and its outbound internet access is
  limited to TLS (443).
- **Only the load balancer accepts traffic from `0.0.0.0/0`.** Phase 1 opened 443; Phase 2 adds 80 for
  the HTTP listener. Port 80 is added by the *application* stack, not the network stack: the load
  balancer security group is re-imported there so the Phase 2 rule is owned by the Phase 2 stack.
- **The application stack creates no security group of its own** — it references the Phase 1 groups,
  so there is exactly one definition of each.
- **`allowAllOutbound: false` everywhere**, with egress granted explicitly.
- The VPC's **default security group is stripped of its rules** (`restrictDefaultSecurityGroup: true`).

### The no-traffic egress rule

The `Alb` and `Database` groups contain an egress rule that matches nothing:
`ICMP 252-86 → 255.255.255.255/32`, described as "Disallow all traffic".

This is not a mistake. CloudFormation adds an **allow-all-outbound** rule to any security group whose
inline `SecurityGroupEgress` list is empty, and a rule pointing at another security group is rendered
as a separate resource rather than inline. Without the marker, the load balancer group would silently
regain `allowAllOutbound`. The marker keeps the inline list non-empty so the rule set in the template
is exactly the rule set intended.

---

## Environments and configuration

| Setting | dev | uat | prod |
| ------- | --- | --- | ---- |
| Region | `ap-southeast-1` | `ap-southeast-1` | `ap-southeast-1` |
| VPC CIDR | `10.0.0.0/16` | `10.1.0.0/16` | `10.2.0.0/16` |
| Availability Zones | 2 | 2 | 3 |
| NAT Gateways | 1 | 2 | 3 |
| VPC Flow Logs | off | on (1 month) | on (3 months) |
| Fargate CPU / memory | 512 / 1024 | 512 / 1024 | 1024 / 2048 |
| ECS desired count | 1 | 1 | 1 |
| ALB deletion protection | off | on | on |
| Container log retention | 1 week | 1 month | 3 months |
| Image tag | `v0.1.0` | `v0.1.0` | `v0.1.0` |
| Removal policy | `DESTROY` | `RETAIN` | `RETAIN` |

All three environments live in Asia Pacific (Singapore) `ap-southeast-1`, which has three
Availability Zones — enough for the production spread. Environment separation does not depend on the
region: each environment keeps its own CIDR block, stack names, tags and export names, so dev, uat and
prod coexist in one account and region without colliding.

Selecting an environment, in order of precedence:

```bash
npx cdk synth -c environment=prod    # 1. CDK context (cdk.json defaults to dev)
ENVIRONMENT=uat npx cdk synth        # 2. environment variable, convenient in CI
npx cdk synth                        # 3. falls back to dev
```

An unknown environment name fails immediately with a clear error rather than silently deploying dev
configuration to the wrong account. `lib/config/validation.ts` additionally rejects an invalid CIDR, a
zero-AZ deployment, more NAT Gateways than Availability Zones, an empty region, a Fargate cpu/memory
pair ECS would refuse, an out-of-range port, a health check path that is not absolute, and a `latest`
image tag.

### Pinning the account

Each environment reads its account from an environment variable — `ECOMMERCE_DEV_ACCOUNT`,
`ECOMMERCE_UAT_ACCOUNT`, `ECOMMERCE_PROD_ACCOUNT` — so account ids stay out of source control. The
value is read when the CDK app starts, so it has to be set in the shell that runs `cdk`.

PowerShell:

```powershell
$env:ECOMMERCE_DEV_ACCOUNT = "123456789012"; npx cdk deploy ecommerce-network-dev -c environment=dev
```

bash / Git Bash / CI:

```bash
ECOMMERCE_PROD_ACCOUNT=123456789012 npx cdk deploy ecommerce-network-prod -c environment=prod
```

A `.env` file will not work: nothing in the CDK CLI or this app reads one. Pin the account before
deploying anything other than dev, so `-c environment=prod` cannot target whichever account the
current credentials happen to resolve to.

---

## Tags

Applied at stack level with `applyPlatformTags()` (`lib/tags.ts`), so every stack tags its resources
identically and tags are never repeated per resource:

| Tag | Value |
| --- | ----- |
| `Project` | `Ecommerce` |
| `Environment` | `dev` / `uat` / `prod` |
| `ManagedBy` | `CDK` |

The ECS service propagates these onto the running tasks as well, so task cost and log records can be
traced back to their environment. Filter by `Project=Ecommerce` to find everything the platform owns,
or by `Environment=dev` to find what may be deleted.

---

## Stack outputs

Every output is exported with an environment-specific name so dev, uat and prod can coexist in one
account without clashing.

| Stack | Output | Export name (dev) | Consumed by |
| ----- | ------ | ----------------- | ----------- |
| Network | `VpcId` | `ecommerce-dev-vpc-id` | every later stack |
| Network | `PublicSubnetIds` | `ecommerce-dev-public-subnet-ids` | ALB, NAT placement |
| Network | `PrivateSubnetIds` | `ecommerce-dev-private-subnet-ids` | ECS tasks, RDS, ElastiCache |
| Network | `AlbSecurityGroupId` | `ecommerce-dev-alb-security-group-id` | Phase 2 load balancer |
| Network | `ApplicationSecurityGroupId` | `ecommerce-dev-application-security-group-id` | Phase 2 ECS service |
| Network | `DatabaseSecurityGroupId` | `ecommerce-dev-database-security-group-id` | Phase 3 RDS / ElastiCache |
| Registry | `RepositoryUri` | `ecommerce-dev-ecr-repository-uri` | image push |
| Registry | `RepositoryName` | `ecommerce-dev-ecr-repository-name` | image push |
| Application | `ClusterName` | `ecommerce-dev-ecs-cluster-name` | operations |
| Application | `ServiceName` | `ecommerce-dev-ecs-service-name` | operations |
| Application | `LoadBalancerDnsName` | `ecommerce-dev-alb-dns-name` | the API endpoint |
| Application | `ApiUrl` | `ecommerce-dev-api-url` | the API endpoint |
| Application | `TargetGroupArn` | `ecommerce-dev-target-group-arn` | operations |

---

## Removal policies and resource protection

`RemovalPolicy.DESTROY` is not applied blindly — it follows the environment's `removalPolicy`
(`DESTROY` in dev, `RETAIN` in uat and prod):

- The **flow log group** and the **container log group** are retained in uat/prod.
- The **ECR repository** is emptied on delete in dev and retained in uat/prod, so images survive a
  `cdk destroy`.
- The **ALB** has deletion protection enabled where the removal policy is `RETAIN`.

Everything else is either ephemeral by nature (subnets, route tables, security groups) or replaced
rather than deleted. When Phase 3 adds stateful resources, the following must be configured
explicitly and are called out so they are not forgotten:

| Resource | Required protection |
| -------- | ------------------- |
| RDS / Aurora | `deletionProtection: true`, automated backups, `RemovalPolicy.SNAPSHOT`; Multi-AZ in prod |
| ElastiCache | Automatic backups, and a final snapshot before replacement |
| S3 (assets, uploads) | `RemovalPolicy.RETAIN`, versioning, and lifecycle rules |
| Secrets Manager | Recovery window; never `DESTROY` in prod |
| KMS keys | `RemovalPolicy.RETAIN` — deleting a key is irreversible |

---

## Commands

CDK app (`ecommerce-infrastructure/`):

```bash
npm install                 # install dependencies
npm run typecheck           # tsc --noEmit
npm test                    # run the Jest test suite
npx cdk synth               # print the CloudFormation templates (no credentials needed)
npx cdk diff                # show what would change (needs AWS credentials)
npx cdk destroy             # remove a stack (dev only, see above)
```

Application (`application/`):

```bash
mvn test                    # run the Spring Boot tests
mvn package                 # build the executable jar (target/ecommerce-api-0.1.0.jar)
docker build -t ecommerce-api:v0.1.0 .
```

### First deployment

Bootstrap the account and region once before anything can be deployed:

```bash
npx cdk bootstrap aws://<account>/ap-southeast-1
```

Then deploy one environment at a time, in dependency order:

```bash
# 1. Network foundation
npx cdk deploy ecommerce-network-dev -c environment=dev

# 2. Registry (must exist before an image can be pushed)
npx cdk deploy ecommerce-ecr-dev -c environment=dev

# 3. Build and push the image (see "ECR: how an image is tagged and pushed")
#    ...

# 4. Compute (the service finds the image and starts a task)
npx cdk deploy ecommerce-application-dev -c environment=dev
```

`npx cdk deploy --all -c environment=dev` deploys all three stacks in the correct order in one go,
but only after an image has been pushed for the first time; otherwise the ECS service starts with no
image to run.

Things that are easy to get wrong:

- **`-c environment=...` selects the configuration; the stack name selects what is deployed.** Always
  pass both.
- **The CDK CLI silently ignores unknown options.** A mistyped flag does not fail the command — it
  deploys the `cdk.json` default. Read the stack name in the output.
- **Push the image before deploying the compute.** The service cannot start without it.
- **Pin the account per environment** before deploying anything other than dev.
- **Deploy from a dedicated IAM principal or Identity Center role, not the account root user.**
- **Deploying is not free:** NAT Gateways, an ALB and a running Fargate task all bill hourly.

Deployment is **not** performed automatically by this repository: nothing in the build or test path
runs `cdk deploy`.

---

## Testing

`npm test` in `ecommerce-infrastructure/` runs **85 Jest tests** over the synthesised CloudFormation
templates and the configuration modules — 31 for the network stack, 26 for the application stack, 6
for the registry stack and 22 for the configuration. `mvn test` in `application/` runs **6 Spring Boot
tests** over the API.

Network (Phase 1):

- the VPC exists, with the configured CIDR and DNS support, and a different CIDR per environment
- two Availability Zones in dev and uat, three in prod, with one public and one private subnet each
- public subnets do not auto-assign public IPs
- an Internet Gateway exists and both public route tables send `0.0.0.0/0` to it
- exactly one NAT Gateway in dev, one per AZ in prod, each in a public subnet with an Elastic IP
- both private route tables send `0.0.0.0/0` to a NAT Gateway and never to the Internet Gateway
- the three tier security groups exist; only the ALB accepts `0.0.0.0/0` inbound
- the application and database tiers are reachable only by security group reference
- the project, environment and management tags are present on every resource
- the VPC and subnet outputs exist, with one subnet id per Availability Zone
- flow logs are off in dev and capture all traffic in prod, with a scoped delivery policy

Registry (Phase 2):

- the repository is named per environment and scans images on push
- untagged images expire; the repository is emptied on delete in dev and retained in prod
- the repository is tagged and its push URI is exported

Application (Phase 2):

- the cluster, task definition and service exist; the task is Fargate with `awsvpc` networking
- the task is sized 512/1024 in dev and 1024/2048 in prod, and never references a `latest` image
- the container exposes port 8080 and logs to the dedicated log group
- the execution role has only scoped ECR pull and log write permissions, with no wildcard action
- the task role has no permissions at all; no administrator or power-user policy appears anywhere
- the service runs exactly one task, in the private subnets, without a public IP, in the application
  security group, with the circuit breaker enabled
- the load balancer is internet-facing in the public subnets and opens only port 80 to the internet
- the listener forwards to the target group; the target group health checks `/actuator/health` on 8080
- the project, environment and management tags are present on every resource

Configuration:

- valid per environment, non-overlapping CIDRs, no hardcoded account ids, no secrets
- unknown environment names are rejected
- invalid Fargate cpu/memory pairs, ports, health check paths and `latest` image tags are rejected
- the image tag is resolved from CDK context, then `IMAGE_TAG`, then configuration

Spring Boot:

- the seeded products are listed and a single product is returned by id
- an unknown id returns `404`; a product without a name returns `400`
- creating a product returns `201` with a server-assigned id
- `/actuator/health` reports `UP`

---

## Cost expectations

Phase 1 is mostly free; the cost is NAT Gateways and (in uat/prod) flow logs. Phase 2 adds the
always-on compute.

| Item | Rough cost driver |
| ---- | ----------------- |
| VPC, subnets, route tables, Internet Gateway, security groups | no charge |
| NAT Gateway | hourly charge per gateway + per GB processed |
| Elastic IPs attached to NAT Gateways | no charge while attached |
| VPC Flow Logs | CloudWatch Logs ingestion per GB, plus storage |
| **Application Load Balancer** | hourly charge + LCU (connections, bandwidth, rules) |
| **Fargate task** | per vCPU-hour and per GB-hour while the task runs |
| **CloudWatch Logs** | ingestion per GB, plus storage per retention period |
| ECR storage | per GB-month, plus a small charge for scanning |
| The default-SG cleanup Lambda | one invocation per stack create/update |

The `dev` configuration is deliberately the cheapest (one NAT Gateway, no flow logs, the smallest
sensible Fargate task) while remaining topologically identical to prod, so a change tested in dev
behaves the same way in prod. The single biggest ongoing cost in Phase 2 is the running Fargate task
plus the load balancer, both billed by the hour — `npx cdk destroy` (or, in uat/prod, a deliberate
scale-to-zero) stops that spend.

---

## Phase 3 and beyond

The platform is designed so the next phase attaches resources without redesigning what exists:

```
                 Phase 3
                    │
                    ▼
            RDS (private, Multi-AZ)     ← private subnets, Database SG
                    │
            ElastiCache (Redis)         ← private subnets, Database SG
                    │
            Auto scaling (ECS)          ← varies the desired count at runtime
                    │
            HTTPS: certificate + 443 listener + 80 → 443 redirect
                    │
            Secrets Manager, S3, SQS/SNS
```

Phase 3 will add a database (the application's in-memory service becomes a real repository), a cache,
ECS auto scaling (which is what actually makes production resilient to losing a task), TLS
termination on the load balancer, and the stateful-resource protections listed above. Later phases add
API Gateway, Cognito, CloudFront/Route 53/WAF, and CI/CD.

Nothing built so far needs to change for those to land: the subnets, route tables, security groups,
outputs, task role and container definition are already in place. The one deliberate Phase 2
limitation — `desiredCount = 1`, so losing the task briefly removes the only instance — is resolved by
auto scaling in Phase 3.
