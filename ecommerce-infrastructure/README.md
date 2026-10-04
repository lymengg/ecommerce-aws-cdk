# E-commerce Platform Infrastructure

AWS CDK (v2, TypeScript) infrastructure for a production-oriented e-commerce platform, plus the
containerised Spring Boot API that runs on it.

**Phase 1** delivers the networking foundation: a VPC with public and private subnets spread over
Availability Zones, correct routing through an Internet Gateway and NAT Gateways, the three-tier
security group model, VPC Flow Logs, and the stack outputs later phases consume.

**Phase 2** delivers the application compute: a minimal Spring Boot product API, packaged as a
container image, stored in ECR and run as a single ECS Fargate task behind an internet-facing
Application Load Balancer, with container logs in CloudWatch.

**Phase 3** delivers the data layer: an Amazon RDS for PostgreSQL instance in dedicated private
database subnets, reachable only from the ECS tasks, encrypted at rest, backed up automatically,
with the master credentials generated and stored in AWS Secrets Manager and injected into the
container by ECS. The Spring Boot API now reads and writes PostgreSQL through Spring Data JPA, and
owns its schema with Flyway migrations.

**Phase 3.5** delivers TLS and DNS: a Route 53 hosted zone for the platform's delegated subdomain, an
ACM certificate validated by DNS, an HTTPS listener on the load balancer that forwards to the
existing target group, and a permanent redirect from HTTP to HTTPS. The API is now reached at
`https://api.<env-domain>` instead of by the load balancer's plaintext DNS name.

**Phase 4** delivers authentication and authorisation, using the **Backend for Frontend** pattern: a
Cognito user pool with a confidential app client, and a Spring Boot API that is the OAuth client and
holds the tokens server side. The browser receives only an `httpOnly` session cookie. Product reads
stay public; product writes require the `admin` Cognito group, enforced server side by claim. The
authorization code + PKCE flow is the only flow enabled - no implicit flow, no password grant, and no
bearer-token resource server (that is deferred; see [Phase 5 and beyond](#phase-5-and-beyond)).

**Phase 4.5** delivers the frontend: a Nuxt 4 single-page application built to static assets and
served by **nginx as a second Fargate service behind the load balancer** (`ecommerce-frontend-<env>`),
with a host rule on the existing HTTPS listener, a security-headers policy (CSP) and its own
repository. The SPA runs at the apex (`<env-domain>`), the API at `api.<env-domain>`, and the browser
authenticates through the Phase 4 BFF with a session cookie - no tokens ever reach the browser.

No cache, queue, CI/CD or auto scaling exists yet. Those are later phases and are listed at the end
of this document.

---

## Table of contents

1. [Architecture](#architecture)
2. [Project structure](#project-structure)
3. [Stacks and deployment order](#stacks-and-deployment-order)
4. [Core concepts: the network](#core-concepts-the-network)
5. [Core concepts: the application tier](#core-concepts-the-application-tier)
6. [Core concepts: the data tier](#core-concepts-the-data-tier)
7. [Core concepts: DNS and TLS](#core-concepts-dns-and-tls)
8. [Core concepts: authentication and authorisation](#core-concepts-authentication-and-authorisation)
9. [Core concepts: frontend hosting](#core-concepts-frontend-hosting)
10. [The Spring Boot application](#the-spring-boot-application)
11. [The container image](#the-container-image)
12. [ECR: how an image is tagged and pushed](#ecr-how-an-image-is-tagged-and-pushed)
13. [IAM: execution role versus task role](#iam-execution-role-versus-task-role)
14. [Database credentials and Secrets Manager](#database-credentials-and-secrets-manager)
15. [Security group model](#security-group-model)
16. [Environments and configuration](#environments-and-configuration)
17. [Tags](#tags)
18. [Stack outputs](#stack-outputs)
19. [Removal policies and resource protection](#removal-policies-and-resource-protection)
20. [Commands](#commands)
21. [Deployment and verification procedure](#deployment-and-verification-procedure)
22. [Testing](#testing)
23. [Cost expectations](#cost-expectations)
24. [Phase 5 and beyond](#phase-5-and-beyond)

---

## Architecture

The Phase 3.5 request path. HTTP on port 80 is answered with a permanent redirect to HTTPS, so the
only path that reaches the application is encrypted:

```
                              Internet
                                 │
                 ┌───────────────┴────────────────┐
                 │ HTTP :80                       │ HTTPS :443
                 │ (301 -> https://api.<env-domain>)│ (TLS 1.2+, ACM certificate)
                 ▼                                ▼
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
                    ┌────────────────────────┐        ┌────────────────────────┐
                    │ Fargate Task           │        │ CloudWatch Logs        │
                    │ Spring Boot API        │───────▶│ /ecs/ecommerce-<env>-api│
                    │ private subnet         │        └────────────────────────┘
                    │ port 8080              │
                    │ security group: App    │
                    └───────────┬────────────┘
                                │
                                │ TCP 5432 (by security group reference)
                                ▼
                    ┌────────────────────────┐        ┌────────────────────────┐
                    │ RDS for PostgreSQL     │◀───────│ Secrets Manager        │
                    │ isolated DB subnets    │ master │ generated credentials  │
                    │ encrypted, Multi-AZ*   │  pwd   └────────────────────────┘
                    │ security group: Database│
                    └────────────────────────┘
                             * prod only

        ECR ──────── container image ────────▶ Fargate Task
        Secrets Manager ── injected at start ─▶ Fargate Task (execution role reads it)
```

The whole platform, network, compute and data:

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
        │       │                                         │
        │   Database subnet             Database subnet   │
        │   (isolated, no route)        (isolated, no route)│
        │       │                           │             │
        │   RDS PostgreSQL ─────────────────┘             │
        │                                                 │
        └─────────────────────────────────────────────────┘
```

Traffic paths created by the stacks:

| Source            | Destination                | Path                                              |
| ----------------- | -------------------------- | ------------------------------------------------- |
| Internet → public | Application Load Balancer  | Internet Gateway → public subnet route table      |
| ALB → task        | ECS/Fargate task           | public subnet → private subnet, security groups only |
| Private → Internet | NAT Gateway → Internet Gateway | public subnet → IGW (image pulls, patches)   |
| Task → database   | RDS PostgreSQL             | private subnet → isolated subnet, security groups only |
| Internet → private | **not possible**          | private route table has no route to the IGW       |
| Database → anything | **not possible**         | isolated route tables have no route at all        |

Security group chain:

```
Internet ──443─▶ ALB SG ──8080──▶ Application SG ──5432──▶ Database SG
Internet ──80──▶ ALB SG              │
 (301 redirect)                      └──443──▶ Internet (via NAT, e.g. image pulls)
```

### The Phase 4 request path

Authentication does not add a new tier; it changes what the application does with a request. The
browser never holds a token and never talks to Cognito directly - the Spring Boot app is the OAuth
client (the Backend for Frontend pattern):

```
  Browser (SPA)                 BFF (Spring Boot)                    Cognito
  ─────────────                 ─────────────────                    ───────
  GET /me  ──────────────────▶  no session
                               302 ────────────────────────────────▶ /oauth2/authorization/cognito
                                                                      hosted UI (PKCE, S256)
       ◀────────────────────────────────────────────────────────────  authorization code
                                POST /login/oauth2/code/cognito
                                exchange code (client secret) ──────▶ token endpoint
                                ◀──────────────────────────────────── ID / access / refresh tokens
                                create server-side session
       ◀── 302 + Set-Cookie: SESSION (httpOnly, Secure, SameSite=Lax)

  GET /api/products  ─────────▶  permitAll  ──▶ PostgreSQL (public read)
  POST /api/products ─────────▶  session cookie + X-XSRF-TOKEN header
                                 CSRF ok, cognito:groups -> ROLE_admin, hasRole("admin") ok
                                 ──▶ PostgreSQL (write)

  POST /logout ───────────────▶  end session ──▶ Cognito /logout?client_id&logout_uri
       ◀── 302 https://<frontend>  ◀───────────────────────────────────  session + refresh token revoked
            (the SPA, not the API)
```

Cognito does **not** implement OIDC RP-Initiated Logout, so the API builds Cognito's proprietary
logout URL itself (`client_id` + `logout_uri`) instead of using Spring's spec-based handler — see
`CognitoLogoutSuccessHandler`. Without that, the local session would end but the Cognito session and
the refresh token would survive.

| Caller | Request | Result |
| ------ | ------- | ------ |
| Anyone | `GET /api/products`, `GET /api/products/{id}` | `200` (reads stay public) |
| Anyone | `GET /actuator/health` | `200` (the load balancer health check) |
| Anonymous | `POST /api/products` | `401`, not a redirect to the hosted UI |
| Signed in, not in `admin` | `POST /api/products` | `403` |
| Signed in, in `admin` | `POST /api/products` | `201` |
| Anonymous | any other protected path (for example `GET /me`) | `302` to the Cognito hosted UI |

The distinction between `401` and `302` matters: a JavaScript `fetch` gets a status it can act on,
while a browser navigation still gets the login redirect that starts the hosted-UI flow.

---

## Project structure

```
aws-cdk/
├── ecommerce-infrastructure/         # CDK app (TypeScript)
│   ├── bin/
│   │   └── ecommerce.ts              # CDK app entry point: resolve env, build the stacks
│   ├── lib/
│   │   ├── config/
│   │   │   ├── types.ts              # EnvironmentConfig + Application/Database/Dns/AuthConfig
│   │   │   ├── validation.ts         # fail-fast validation of an environment config
│   │   │   ├── dev.ts                # dev values
│   │   │   ├── uat.ts                # uat values
│   │   │   ├── prod.ts               # prod values
│   │   │   └── index.ts              # environment + image tag resolution, config lookup
│   │   ├── constructs/
│   │   │   ├── tier-security-groups.ts   # ALB / application / database security groups
│   │   │   ├── vpc-flow-logs.ts          # optional flow logging + its least-privilege role
│   │   │   └── load-balanced-api.ts      # Fargate task, ECS service, ALB, DB + auth wiring, IAM
│   │   ├── stacks/
│   │   │   ├── network-stack.ts      # VPC, public/private/isolated subnets, routing, SGs
│   │   │   ├── ecr-stack.ts          # container registry
│   │   │   ├── database-stack.ts     # RDS PostgreSQL instance + Secrets Manager credentials
│   │   │   ├── dns-stack.ts          # Route 53 hosted zone + ACM certificate (Phase 3.5)
│   │   │   ├── cognito-stack.ts      # user pool, confidential app client, client secret (Phase 4)
│   │   │   └── application-stack.ts  # ECS cluster, service, ALB, IAM, logs, DNS record
│   │   └── tags.ts                   # the shared tag contract
│   ├── test/
│   │   ├── setup-env.ts              # sets ECOMMERCE_<ENV>_DOMAIN before the config is imported
│   │   ├── network-stack.test.ts     # network contract tests (CDK assertions)
│   │   ├── ecr-stack.test.ts         # registry contract tests
│   │   ├── database-stack.test.ts    # database contract tests
│   │   ├── dns-stack.test.ts         # hosted zone + certificate contract tests
│   │   ├── cognito-stack.test.ts     # user pool, app client and secret contract tests
│   │   ├── application-stack.test.ts # compute + database + TLS + auth wiring contract tests
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
    │   ├── config/SecurityConfig.java          # filter chain, CORS, 401 entry point, CSRF, OIDC logout
    │   ├── security/CognitoAuthoritiesMapper.java  # cognito:groups -> ROLE_<group>
    │   ├── controller/ProductController.java   # HTTP mapping only
    │   ├── controller/SessionController.java   # /me, the protected endpoint that starts login
    │   ├── dto/ProductRequest.java             # validated create payload
    │   ├── service/ProductService.java         # business operations + transactions
    │   ├── repository/ProductRepository.java   # Spring Data JPA
    │   └── entity/Product.java                 # JPA entity mapped to `products`
    ├── src/main/resources/
    │   ├── application.properties              # datasource + auth from env, no credentials
    │   └── db/migration/V1__create_products_table.sql   # Flyway migration
    ├── src/test/java/com/ecommerce/api/
    │   ├── ProductApiTest.java                 # HTTP + PostgreSQL (Testcontainers)
    │   ├── SecurityTest.java                   # 401 / 403 / 201 and CORS contract
    │   ├── service/ProductServiceTest.java     # service unit tests (Mockito)
    │   └── support/                            # in-memory OIDC registration + auth test properties
    ├── pom.xml
    ├── Dockerfile
    ├── .dockerignore
    └── .gitignore

frontend/                             # the Nuxt 4 storefront (client-only SPA)
├── app/
│   ├── composables/useApi.ts         # the only place that calls the API (credentials + CSRF)
│   ├── composables/useAuth.ts        # session, login, logout, isAdmin
│   ├── pages/                        # catalog, product, cart, checkout, account, admin
│   ├── stores/cart.ts                # Pinia, persisted to localStorage
│   └── types/api.ts                  # the API contract, typed by hand
├── test/                             # Vitest
├── Dockerfile                        # node build stage -> nginx-unprivileged runtime stage
├── nginx.conf.template               # SPA fallback, cache rules, CSP (envsubst at container start)
├── scripts/deploy.sh                 # docker build -> ECR push -> roll the ECS service
├── nuxt.config.ts
└── README.md
```

`bin/ecommerce.ts` contains no environment values: it resolves the environment, loads its
configuration and hands it to the stacks. No stack contains environment values either — everything
arrives through `EnvironmentConfig`, which is why the same stack code produces dev, uat and prod.

---

## Stacks and deployment order

| Stack | Name | Creates |
| ----- | ---- | ------- |
| Network | `ecommerce-network-<env>` | VPC, public/private/isolated subnets, gateways, route tables, tier security groups, flow logs |
| Registry | `ecommerce-ecr-<env>` | ECR repository |
| Database | `ecommerce-database-<env>` | RDS PostgreSQL instance, subnet group, Secrets Manager credentials |
| DNS | `ecommerce-dns-<env>` | Route 53 hosted zone, ACM certificate |
| Cognito | `ecommerce-cognito-<env>` | Cognito user pool, prefix domain, confidential app client, client-secret secret, baseline alarm |
| Application | `ecommerce-application-<env>` | ECS cluster, task definition, ECS service, ALB, target group, listeners, alias record, log group, IAM roles |
| Frontend | `ecommerce-frontend-<env>` | nginx ECS service + target group, host rule on the application stack's HTTPS listener, apex alias records, IAM roles, log group |

The registry is a **separate stack from the compute** on purpose. An ECS service cannot start until
an image exists, and an image can only be pushed once the repository exists, so the repository has
to be creatable — and an image pushable — before the application stack is deployed. Keeping the
registry separate also means recreating the compute never touches the images, and in uat/prod the
registry can be retained while everything else is disposable.

The database is a **separate stack from the compute** for the opposite reason: their lifecycles are
unrelated. The application is replaced on every deployment and can be recreated at will; the
database holds the only state in the platform and outlives many deployments of the code that reads
it. Keeping them apart means a `cdk deploy ecommerce-application-dev` never touches the instance,
and the instance's removal policy and deletion protection are decided in one small stack.

The DNS stack is a **separate stack from the compute** because a certificate is long-lived and
replaceable: the application can be torn down and recreated at will without re-validating TLS, and
the zone can be delegated and left in place while the compute is redeployed. It depends on no other
stack — the hosted zone is created, never looked up — so it can be deployed in parallel with the
network, registry and database.

The Cognito stack is a **separate stack from the compute** because a user pool holds users: it is
stateful, it outlives the code that reads it, and its removal policy has to be decided
independently. It sits after DNS and before the application, because the app client's
callback URIs are exact HTTPS URLs on `api.<env-domain>` — the API's fully qualified name is derived
from `config.dns`, never imported as a string — and because the application consumes the pool, the
app client and the client secret by reference. (The logout URI points at the frontend, which needs
no DNS from this stack.)

The frontend stack is **separate from the compute** even though it shares the load balancer: the SPA
is deployed on its own cadence (a content change is not an API change) and the two services scale
independently. It consumes the ECS cluster, the HTTPS listener, the load balancer, the application
security group, the frontend repository and the hosted zone **by reference**, so it is deployed after
the application and can be redeployed alone. See
[Core concepts: frontend hosting](#core-concepts-frontend-hosting).

Deployment order is therefore: **network → registry → database → dns → cognito → application →
frontend**. The DNS stack sits between the database and the application because the application
consumes its zone and certificate; the Cognito stack sits between DNS and the application because the
application consumes the pool and the client secret; the frontend sits last because it consumes the
load balancer the application creates. Nothing consumes the frontend, so there is no path back and the
graph stays acyclic. One manual step sits inside that order: the zone must be delegated at the
registrar (see [Core concepts: DNS and TLS](#core-concepts-dns-and-tls)) before the certificate
finishes issuing.

The application stack consumes the network stack's VPC and security groups, the registry stack's
repository, the database stack's endpoint and credentials secret, the DNS stack's zone and
certificate, and the Cognito stack's user pool, app client and client secret **by reference** (CDK
cross-stack references); the frontend stacks consume the zone and the certificate the same way. The
CDK CLI orders the stacks automatically and there is exactly one definition of each resource. No ARN
is ever plumbed between stacks as a string.

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

Accepts connections on a port and acts on them. There are two listeners once a certificate is
configured:

| Listener | Port | Protocol | Default action |
| -------- | ---- | -------- | -------------- |
| `HttpsListener` | 443 | HTTPS | **forward** to the target group |
| `HttpListener` | 80 | HTTP | **redirect** (HTTP 301) to `https://<fqdn>` |

The redirect is a listener *action*, not a target group: a plaintext request is answered by the load
balancer itself and never reaches the application. TLS terminates at the load balancer with the ACM
certificate and the request continues to the task over plain HTTP inside the private subnets — the
hop that crosses the internet is the one that must be encrypted, and the target group is not
reachable from outside the VPC. The listener pins `SslPolicy.RECOMMENDED_TLS`
(`ELBSecurityPolicy-TLS13-1-2-2021-06`), which sets TLS 1.2 as the floor; the older `RECOMMENDED`
policy still negotiates TLS 1.0/1.1 and is deliberately not used.

The 443 listener also carries the **HSTS** response header
(`routing.http.response.strict_transport_security.header_value = max-age=31536000; includeSubDomains`),
so a browser that has seen the API once will not retry it over plaintext. Setting it at the load
balancer rather than only in the application means the redirect from port 80 carries it too.

`LoadBalancedApi` still supports being built without a certificate — the single port 80 listener
forwards to the target group exactly as it did in Phase 2 — but no environment takes that path any
more: from Phase 4 authentication needs an HTTPS origin, so `dns` is required everywhere.

### CloudWatch Logs

The container's `stdout`/`stderr` are shipped to the log group `/ecs/ecommerce-<env>-api` by the
`awslogs` driver. This is where you look when a task starts and immediately stops. Retention follows
the environment, and the execution role is granted write access to exactly this log group.

---

## Core concepts: the data tier

### RDS for PostgreSQL

**Amazon Relational Database Service (RDS)** runs a managed PostgreSQL server: AWS handles the
operating system, the engine patching, the backups and (in Multi-AZ) the failover, and hands back a
DNS endpoint. The alternative — PostgreSQL on an EC2 instance — means owning all of that yourself,
which is exactly the kind of undifferentiated work a managed service should absorb.

PostgreSQL is the engine because the application needs transactions, foreign keys and a real
relational model, and because it is the default choice in this stack: Spring Data JPA, Flyway and
the PostgreSQL JDBC driver all treat it as first class.

The engine version is pinned to a **major** version (`16`). RDS then runs the current minor release
of that major and applies minor upgrades during the maintenance window, while a major upgrade — the
kind that can break compatibility — stays an explicit, reviewed change.

### Isolated database subnets

Phase 3 added a third subnet group to the VPC:

| Subnet group | CDK type | Route off the VPC | Hosts |
| ------------ | -------- | ----------------- | ----- |
| `public` | `SubnetType.PUBLIC` | Internet Gateway | ALB, NAT Gateway |
| `private` | `SubnetType.PRIVATE_WITH_EGRESS` | NAT Gateway | ECS tasks |
| `database` | `SubnetType.PRIVATE_ISOLATED` | **none** | RDS |

The database subnets have route tables with **no routes at all**. There is no path to the internet
gateway and none to a NAT gateway, so an instance placed there cannot initiate a connection
anywhere, full stop — which is what you want for the one component that holds the data. It is also
why the ECS tasks stay in the `private` subnets rather than moving here: they do need outbound
access for image pulls.

Adding a subnet group is the smallest change that gives the database its own network. The Phase 1
public and private subnets are untouched, so nothing deployed earlier moved.

### DB subnet group

RDS refuses to create an instance without a **DB subnet group**: a named list of at least two
subnets in different Availability Zones. CDK builds one from the isolated subnets automatically, and
RDS uses it to decide where the instance (and, in Multi-AZ, its standby) lives.

### Encryption at rest

`storageEncrypted: true` encrypts the instance's storage, its automated backups and its snapshots
with the RDS managed KMS key (`aws/rds`). This is **not** configurable per environment: an
unencrypted database is a finding, not a cost saving, and encryption at rest cannot be added
retroactively without a rebuild.

### Automated backups

`backupRetentionDays` sets the recovery window: RDS takes a daily snapshot and keeps the
transaction logs needed to restore to any point inside that window. Retention is 1 day in dev, 7 in
uat and 30 in prod, and the configuration validator refuses 0 — running a managed database without
backups throws away the main reason for paying for it. `deleteAutomatedBackups` follows the removal
policy so `cdk destroy` in dev leaves nothing billing behind, while uat/prod keep their recovery
window.

### Multi-AZ

`multiAz: true` runs a synchronously replicated standby in a second Availability Zone and fails over
to it automatically if the primary is lost. It doubles the instance cost and it is enabled in
production only. This is not read replication: no read traffic is served from the standby, and no
replica configuration is involved.

### Deletion protection and removal policy

Two different guards, often confused:

- **`deletionProtection`** refuses a `DeleteDBInstance` call until it is switched off. It stops a
  person or a pipeline from deleting the instance, and it is `false` in dev, `true` in uat/prod.
- **`removalPolicy`** decides what CloudFormation does when the *stack* is deleted: `DESTROY`
  deletes the instance, `RETAIN` leaves it (and its data) behind. It is `DESTROY` in dev and
  `RETAIN` in uat/prod.

The configuration validator rejects the combination `deletionProtection: true` with
`removalPolicy: DESTROY`, because a stack that can never be deleted is a trap rather than a
safeguard.

### Secrets Manager

**AWS Secrets Manager** stores the master credentials. The database stack creates a secret whose
value is generated by CloudFormation at deploy time:

```json
{ "username": "ecommerce", "password": "<generated, 30 characters, no punctuation>" }
```

The generated value never appears in the template, in source control or in a terminal — CloudFormation
resolves `GenerateSecretString` server-side and the instance's `MasterUserPassword` is a
`{{resolve:secretsmanager:...}}` dynamic reference. The secret is created without an explicit name,
so destroying and recreating an environment never collides with a secret that is still inside its
recovery window; it is found by its tags and by the exported ARN.

### Secret injection into the container

The application never receives the password as a value that a human or a log line can see. ECS
supports **secret injection**: the task definition references the secret and the JSON field to read,
and the ECS agent fetches it while starting the container, exporting it as an environment variable:

```
Secrets Manager ──(execution role: GetSecretValue)──▶ ECS agent ──▶ container env (DB_USERNAME, DB_PASSWORD)
```

This is why the secret read permission belongs on the **execution** role and not the task role: the
value is fetched before the application starts, and the running application never holds a
credential it could leak.

The connection *details* — host, port, database name — are not secrets, so they travel as ordinary
environment variables set from the database stack's outputs.

---

## Core concepts: DNS and TLS

Phase 3.5 gives the API a name and a certificate. Both are created in `ecommerce-dns-<env>`, ahead of
the compute that uses them.

```
   registrar (example.com)
        │  NS records for the subdomain, added by hand once
        ▼
   Route 53 hosted zone (dev.example.com)          ← ecommerce-dns-dev
        │  ACM writes and renews the validation CNAME itself
        ▼
   ACM certificate (api.dev.example.com)           ← ecommerce-dns-dev
        │  attached to the HTTPS listener
        ▼
   ALB :443  ──8080──▶  ECS task                  ← ecommerce-application-dev
        ▲
        │  A alias record api.dev.example.com -> ALB   ← ecommerce-application-dev
```

### Route 53 hosted zone

A hosted zone is the DNS container for a domain: Route 53 answers queries for it from the records it
holds. The stack creates a **public** zone for the configured subdomain (`dev.example.com`) — not a
private zone, because the API is reached from the internet.

### The delegation model

The platform owns a *subdomain*, not the apex domain, because a registrar can only delegate a whole
zone. The domain's registrar keeps NS records for `dev.example.com` that point at the four name
servers of this zone; everything underneath is then answered by Route 53. This is why
`HostedZoneNameServers` is exported: it is the one value a human has to copy into the registrar (see
[Delegating the subdomain](#delegating-the-subdomain)).

### ACM certificate and DNS validation

**AWS Certificate Manager (ACM)** issues the certificate covering exactly `api.<zoneName>`. It is
validated **by DNS**, and the validation CNAME is created inside the hosted zone by ACM itself:

```ts
validation: CertificateValidation.fromDns(zone)
```

That is the whole reason to hand ACM the zone. Compared with email validation there is no approval
link to click, no record to add by hand and no renewal to remember: ACM creates the CNAME, waits for
it to resolve, issues the certificate, and renews it automatically.

Managed renewal has one condition worth knowing: ACM only renews a certificate that is **in use by an
integrated service** (or exported). Until the application stack attaches it to the load balancer
listener, the certificate reports `RenewalEligibility: INELIGIBLE` — that is expected, not a fault,
and it flips to `ELIGIBLE` once the listener references it. The scope is deliberately minimal — the
API name plus the apex the SPA is served from, no wildcard, and no CAA records (a deferred hardening
item).

The certificate is also **created, never looked up**: there is no `fromLookup` anywhere in this app,
so `cdk synth` runs with zero AWS credentials and no context lookups.

### Region

This certificate lives in the deployment region (`ap-southeast-1`) because an ALB certificate must.
A CloudFront distribution (Phase 6) would need its **own** certificate in `us-east-1`, because
CloudFront only reads certificates from there — a separate certificate in a separate stack, noted here
so it is not discovered at deploy time. Nothing in this phase needs us-east-1.

---

## Core concepts: authentication and authorisation

Phase 4 adds a Cognito user pool and makes the Spring Boot API the OAuth client. The decision below
is deliberate and recorded here so it is not relitigated: **Backend for Frontend (BFF), with
bearer-token support explicitly deferred.**

### Why the BFF pattern

The browser holds only an `httpOnly` session cookie. It never receives an OAuth token and never
talks to Cognito directly; the Spring Boot app performs the whole authorization code flow server
side and holds the tokens itself.

- The IETF browser-based apps BCP recommends BFF for browser clients, and OAuth 2.0 Security BCP
  (RFC 9700) forbids placing tokens where a script can reach them. With the BFF, an XSS bug yields a
  session cookie — which the server can revoke — not a refresh token an attacker can exfiltrate and
  replay for days.
- The app client is **confidential** (it has a secret), so the token endpoint is not open to anyone
  who can read a client id out of a browser. A public client would have to rely on PKCE alone to
  protect the code exchange.
- Logout and revocation become real server-side operations: the BFF ends its own session and then
  asks Cognito to end the Cognito session, and the app client has token revocation enabled, so the
  refresh token is invalidated too.
- There is no browser-side token lifetime, audience or `token_use` handling to get wrong, because
  there are no browser-side tokens.

**Explicitly rejected:**

- **Implicit flow** — it exposes tokens in the URL fragment, where scripts and browser history can
  reach them.
- **Resource Owner Password Credentials grant** — RFC 9700 deprecates it, so `ALLOW_USER_PASSWORD_AUTH`
  never appears and there is no scriptable password login.
- **Tokens in `localStorage`/`sessionStorage`** — readable by any script on the page, which is the
  exact class of bug the BFF removes.
- **ALB `authenticate-oidc`** — it answers `302`, not `401`/`403`, and cannot express per-route
  claims, so it cannot enforce "reads are public, writes need `admin`" or give a `fetch` a status it
  can act on.

**Deferred on purpose:** bearer-token / resource-server support for future mobile or service clients.
`spring-boot-starter-oauth2-resource-server` is deliberately **not** on the classpath this phase. The
`/api/**` authorization rules live in one place (`SecurityConfig`), so adding a bearer-token entry
point later is additive rather than a rewrite.

### The user pool and the app client

`ecommerce-cognito-<env>` creates:

| Resource | Purpose |
| -------- | ------- |
| `cognito.UserPool` `ecommerce-<env>-users` | The users. Password policy, MFA mode and self sign-up come from `config.auth`; the removal policy comes from `config.removalPolicy`. Email is a required, auto-verified attribute. The plan is pinned to **Essentials**, which managed login requires. Deletion protection is deliberately not enabled. |
| `cognito.UserPoolDomain` | A Cognito **prefix** domain serving **managed login (version 2)** rather than the classic hosted UI Cognito uses by default. A custom domain would need its own `us-east-1` certificate and DNS record — branding, not security, and a non-goal this phase. |
| `cognito.ManagedLoginBranding` | Seeds a Cognito-provided branding style for the app client. Managed login version 2 does not render for a client that has none — the console creates one automatically, CloudFormation does not. |
| `cognito.UserPoolClient` `ecommerce-<env>-api-client` | The confidential app client: `generateSecret: true`, authorization code grant only, `openid email profile` scopes. |
| `secretsmanager.Secret` | Holds the generated client secret under the `clientSecret` key. ECS injects it into the container exactly like the database password. |

The login pages are Cognito's **managed login** (`ManagedLoginVersion` 2), not the classic hosted UI a
domain defaults to. Managed login is the modern sign-in experience and the only version with the
no-code branding designer (logo, background, colours, custom CSS); the visual editor and CSS
customisation are Essentials-tier features, which is why the plan is pinned. Version 2 will not
render for an app client that has no branding style, so a `ManagedLoginBranding` resource seeds
Cognito's defaults for the API client; the style can be re-branded later in the console. A fully
custom login page in the SPA was rejected: it would make the browser an OAuth client holding tokens
(or require the password grant), undoing the BFF. The domain version is a domain setting, so it
applies to every app client hosted there, and Cognito updates it in place.

Email is a **required, auto-verified** attribute (`autoVerify: { email: true }` plus a required
`email` schema attribute). Cognito only sends a confirmation code for an attribute it is told to
auto-verify, and only to an attribute the user actually supplied; without both, a self-signed-up user
stays `UNCONFIRMED` and every sign-in fails with `User is not confirmed`. Requiring email makes the
managed login sign-up page collect it, and auto-verifying makes Cognito email the code the user
enters to confirm the account before the first sign-in. The same verification is what lets the pool's
`verified_email` account-recovery mechanism work. Sign-in stays by **username**. Dev and uat use
Cognito's built-in email sender (50 messages/day); production should move to SES when notifications
land in Phase 7.

A user pool's attribute schema is **create-only**: `UpdateUserPool` has no `Schema` parameter, so
CloudFormation **replaces** the pool when the schema changes. Applying the required-email change to
an existing pool therefore recreates it — in dev, destroy the Cognito stack first
(`cdk destroy ecommerce-cognito-dev -c environment=dev`) so the replacement and the old pool do not
contend for the same prefix domain, then deploy and re-register.

Only the **authorization code grant** is enabled. Every other flow is explicitly `false` in
`oAuth.flows`, so a future edit cannot quietly re-enable one. The client's explicit auth flow is
pinned to `ALLOW_USER_SRP_AUTH` alone (via the documented escape hatch): there is no
`ALLOW_USER_PASSWORD_AUTH`, no admin password flow and no custom-auth flow.

`ALLOW_REFRESH_TOKEN_AUTH` is deliberately **absent**, and Cognito enforces that — it rejects the
combination with refresh-token rotation ("ALLOW_REFRESH_TOKEN_AUTH is not a permitted
ExplicitAuthFlow when refresh token rotation is enabled"). Refresh still works: with rotation on the
refresh token is single-use and the refresh flow is implicit. Callback URIs are **exact**, never
wildcards, and the logout URI is the **frontend**:

```
callback:  https://api.<env-domain>/login/oauth2/code/cognito
           http://localhost:8080/login/oauth2/code/cognito
logout:    <auth.frontendUrl>            e.g. https://<env-domain>  (dev: http://localhost:5173)
```

The `localhost` callback is the Spring Boot app running on a developer machine — the only non-HTTPS
origin Cognito allows. The logout URI is the SPA because that is where a signed-out user should land,
and the same URL is the OAuth2 login-success landing; the API has no landing pages of its own. There
is deliberately **no identity pool**: nothing in this platform exchanges a user token for AWS
credentials, so creating one would only widen the blast radius.

MFA offers time-based one-time passwords only (`EnabledMfas: [SOFTWARE_TOKEN_MFA]`); SMS MFA would
need a verified phone number and an SNS role for no security gain over TOTP.

### The exact flow (authorization code + PKCE)

1. The browser navigates to a protected path (`GET /me`). With no session, the BFF answers `302` to
   `/oauth2/authorization/cognito`.
2. Spring Security generates `state`, `nonce` and a PKCE `code_verifier`, sends the browser to the
   Cognito hosted UI with the `S256` code challenge, and stores the authorization request in the
   session. `state` and `nonce` are on by default and are **not** disabled.
3. The user signs in (and, in production, satisfies MFA). Cognito redirects back to
   `/login/oauth2/code/cognito` with an authorization code.
4. The BFF exchanges the code at the token endpoint, authenticating as the confidential client with
   the secret from Secrets Manager and proving possession of the `code_verifier`. It receives an ID
   token, an access token and a rotating refresh token — none of which leave the server.
5. The BFF creates a server-side session and returns `Set-Cookie: __Host-SESSION` (`httpOnly`,
   `Secure`, `SameSite=Lax`). The browser now holds only that cookie.
6. On logout (`POST /logout`, CSRF-protected), the BFF ends the session and redirects to Cognito's
   own logout endpoint with `client_id` and `logout_uri` (Cognito does not implement RP-Initiated
   Logout); Cognito ends its session, revokes the refresh token, and returns the browser to the SPA
   (`auth.frontendUrl`, a registered sign-out URL).

`server.forward-headers-strategy=framework` is what makes step 4 correct behind the load balancer:
the request arrives over plain HTTP with `X-Forwarded-Proto: https`, and without it the redirect URI
would be built as `http://…` and would not match the registered HTTPS callback.

### Groups and the enforce-by-claim mechanism

Cognito puts the user's groups in the `cognito:groups` claim of the ID token. `CognitoAuthoritiesMapper`
turns each group into an authority named `ROLE_<group>`, so the `admin` group becomes `ROLE_admin`.
`SecurityConfig` then expresses the whole API policy in one place:

```java
.requestMatchers("/actuator/health").permitAll()
.requestMatchers(HttpMethod.GET, "/api/**").permitAll()
.requestMatchers("/api/**").hasRole("admin")
.anyRequest().authenticated()
```

Reads are anonymous, writes require `ROLE_admin`, and anything unmatched is authenticated — deny by
default. Authorization is enforced server side by claim, never by hiding a button in the UI. A later
write endpoint (`POST /api/orders`, Phase 5) inherits the same rule without touching the filter chain.

### CSRF and CORS: what the frontend must do

CSRF is on, using Spring Security's single-page-application handling (`csrf.spa()`). The token is
delivered in a cookie the SPA reads and echoes back in a header:

- The SPA reads the `XSRF-TOKEN` cookie and sends its value in the `X-XSRF-TOKEN` header on every
  unsafe request (`POST`, `PUT`, `PATCH`, `DELETE`). A missing or stale token is rejected.
- The SPA must send credentials (`fetch(..., { credentials: 'include' })`) so the session cookie is
  attached.
- CORS allows only the exact origins in `auth.allowedOrigins`, with `allowCredentials: true`. A
  wildcard origin with credentials is both invalid and dangerous, so it is rejected at synth.

Cross-site cookies are increasingly blocked by browsers, so the frontend is expected to be
**same-site** with the API (both under the same registrable domain, e.g. `https://<env-domain>` for
the SPA and `https://api.<env-domain>` for the API) or to use a development proxy that makes the
requests same-origin. The `http://localhost:5173` origin in dev/uat is for exactly that: the Vite dev
server proxying to the API.

### Known constraint: sessions are in memory

The BFF's sessions live in the application's memory for this phase. Two consequences, both enforced
rather than documented-and-forgotten:

- **The service must run as a single task.** `assertValidEnvironmentConfig` rejects
  `application.desiredCount > 1` with a message naming the in-memory session store. Auto scaling
  would give each task its own session store and silently sign users out under load. Phase 6 moves
  sessions to Redis/ElastiCache; only then is the guard removed.
- **A redeployment signs users out**, because the new task starts with an empty store. That is
  acceptable for this phase and is the price of not running a cache yet.

### Threat model, briefly

The BFF is chosen precisely to remove the token-theft class (OWASP A04). The remaining assets and
what protects them:

| Asset | Where it lives | Protection |
| ----- | -------------- | ---------- |
| User password | Cognito (never the app) | Cognito password policy; never leaves Cognito |
| ID / access token | BFF server memory | Never sent to the browser; short lifetimes (15 min in prod) |
| Refresh token | BFF server memory | Rotated on use, revoked on logout, 12 h window in prod |
| Client secret | Secrets Manager → ECS injection | Never in config, image, template or browser; execution role reads it |
| Session cookie | Browser | `httpOnly`, `Secure`, `SameSite=Lax`; server-side session can be revoked |
| CSRF token | `XSRF-TOKEN` cookie | Double-submit; sent back in `X-XSRF-TOKEN` on writes |

OWASP A09: the application logs authentication outcomes without tokens or PII, and the Cognito stack
ships one baseline alarm (`SignInThrottles`) — every new component lands with at least one alarm;
Phase 7 is the deep dive.

### Verifying it against a deployed environment

```bash
# Public read: no credentials at all.
curl https://<api-fqdn>/api/products
# []

# Anonymous write: 401, not a redirect to the hosted UI.
curl -i -X POST https://<api-fqdn>/api/products \
  -H 'Content-Type: application/json' -d '{"name":"X","price":1.00}'
# HTTP/2 401

# The load balancer health check stays anonymous.
curl https://<api-fqdn>/actuator/health
# {"status":"UP"}

# HSTS is on every response served over 443.
curl -sI https://<api-fqdn>/actuator/health | grep -i strict-transport-security
# strict-transport-security: max-age=31536000; includeSubDomains
```

The browser flow has to be done by hand (there is no automated browser test this phase):

1. Open `https://<api-fqdn>/me` in a browser. It redirects to the Cognito hosted UI.
2. Sign in (dev: any user; prod: a user in the `admin` group for the write test).
3. The browser returns to `/login/oauth2/code/cognito`, the BFF creates the session, and `/me` shows
   the user's name and authorities — including `ROLE_admin` for an admin.
4. From the SPA (or a console), read the `XSRF-TOKEN` cookie, then `POST /api/products` with
   `credentials: 'include'` and `X-XSRF-TOKEN`. A non-admin gets `403`; an admin gets `201`.
5. `POST /logout` (with the CSRF header) ends the session and the Cognito session, and returns the
   browser to the SPA (`auth.frontendUrl`).

---

## Core concepts: frontend hosting

Phase 4.5 serves the Nuxt storefront (`frontend/`) as static assets, from **nginx running as a second
Fargate service behind the load balancer that already exists**.

```
   browser ──HTTPS──▶ ALB :443 ──host: <env-domain>────▶ frontend TG ──8080──▶ nginx (SPA)
                        │
                        └────────host: api.<env-domain>▶ api TG ──8080──▶ Spring Boot
```

| Resource | Why |
| -------- | --- |
| `ecr.Repository` | Holds the frontend image. Separate from the API's, because the two images have different lifecycles. |
| ECS service + task | nginx serving the built SPA, in the private subnets on the application security group. |
| Target group | Forwards to container port 8080 and health checks `/healthz`, which nginx answers itself - so a broken bundle cannot make the task look unhealthy. |
| **Listener rule** (host header) | Sends `<env-domain>` to the frontend target group. Every other host, including `api.<env-domain>` and the load balancer's own name, falls through to the listener's default action, which is the API. |
| Route 53 alias (A + AAAA) | Points the apex at the load balancer. An alias, not a CNAME, because a CNAME is not valid at the apex. |
| The DNS stack's certificate | Gains the apex as a subject alternative name, so **one** certificate covers both public names - no wildcard. |

No new security group rule is added: the load balancer already reaches the application security group
on the container port, so the frontend simply joins that group.

The service is **stateless** - nginx holds nothing between requests - so unlike the API tier it may
run more than one task. Production runs two; the single-task guard exists only to protect the API's
in-memory sessions.

### Why not CloudFront (yet)

A CloudFront distribution over a private S3 bucket is the usual way to serve a static SPA, and it is
what Phase 6 wants. It is not used here because **this account cannot create CloudFront resources
until AWS Support verifies it**:

> Your account must be verified before you can add new CloudFront resources.

Serving the files from the load balancer that already exists needs no new service, no new
certificate region and no CDN account gate. When the account is verified, CloudFront becomes a CDN
**in front of this same service** - cache behaviours for the static assets, everything else forwarded
to the load balancer - which needs no change to the application and is a better shape than a second
origin. The us-east-1 certificate and the S3 distribution were removed rather than left in place as
dead, undeployable code.

### SPA routing

A client-side route such as `/cart` has no file on disk, so nginx falls back to the app shell and
lets the Nuxt router take over (`try_files $uri /index.html`). `$uri/` is deliberately absent: the
static build contains a directory per prerendered route, so testing for one would make nginx answer
`/cart` with a `301` to `/cart/`.

Hashed assets are immutable and cached for a year; `index.html` is `no-cache`, so a deploy is picked
up immediately.

### Security headers

nginx adds them to every response (`frontend/nginx.conf.template`): `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and a tight
**Content-Security-Policy** whose only outbound connection is the API:

```
default-src 'self'; connect-src 'self' https://api.<env-domain>; img-src 'self' data:;
font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

The `connect-src` value is rendered by `envsubst` at container start from the `API_ORIGIN` the task
definition passes. HSTS is set on the load balancer listener, which also covers the port 80 redirect
this service never sees.

`script-src` is `'self'` plus the **sha256 hash of each inline script** in the app shell, never
`'unsafe-inline'`. Nuxt emits three of them (the import map, the colour-mode bootstrap and the runtime
config) and two change on every build, so the build computes the hashes
(`frontend/scripts/csp-hashes.mjs`) and nginx includes them - a nonce would have been the alternative,
but it requires the response to be uncached, which a CDN in front of this service would break.

### Same-site, not same-origin

The SPA answers at the **apex** (`https://<env-domain>`) and the API at `https://api.<env-domain>`.
They are different origins but the same registrable domain, which is what lets the BFF's
`SameSite=Lax` session cookie be sent on the SPA's API calls. The CORS allowlist (Phase 4) covers the
cross-origin part. In dev the SPA runs on `http://localhost:5173` and the API on
`http://localhost:8080` - again same-site, again cross-origin, so local behaviour matches production.

### Building and deploying it

The image is built in two stages: a `node` stage runs `nuxt generate`, and the result is copied into
an `nginx-unprivileged` runtime stage. The API base URL is baked in at build time (there is no server
to read runtime configuration from), so it is a build argument. `frontend/scripts/deploy.sh` does the
whole thing:

```bash
ECOMMERCE_DEV_DOMAIN=dev.example.com ./scripts/deploy.sh dev
#   docker build  ->  docker push  ->  aws ecs update-service --force-new-deployment
```

The runtime stage runs as a non-root user on port 8080, and renders its nginx configuration from a
template at start, so the image itself is environment-agnostic. See `frontend/README.md` for the app
itself.

---

## The Spring Boot application

`application/` is a Spring Boot API. It uses **Java 21** (the current LTS) and **Spring Boot 4.1.1**,
with Spring Web, Spring Data JPA, Jakarta Bean Validation, Flyway, Actuator, the OAuth2 **client**
starter and Testcontainers. It is deliberately **not** a resource server (see
[Core concepts: authentication and authorisation](#core-concepts-authentication-and-authorisation)).

Structure:

```
HTTP → controller → service → repository → PostgreSQL
         │              ▲
         │          entity / dto
         └─ SecurityConfig / CognitoAuthoritiesMapper   (the session and claim layer)
```

| Layer | Class | Responsibility |
| ----- | ----- | -------------- |
| Security | `SecurityConfig` | The filter chain: authorize rules, OIDC login, CSRF, CORS, 401 entry point, logout |
| Security | `CognitoAuthoritiesMapper` | Turns the `cognito:groups` claim into `ROLE_<group>` authorities |
| Controller | `ProductController` | Maps HTTP to the service; holds no state and no database logic |
| Controller | `SessionController` | `/me`, the protected endpoint that starts the login flow |
| Service | `ProductService` | Business operations and transaction boundaries |
| Repository | `ProductRepository` | Spring Data JPA; CRUD only, no custom queries yet |
| Entity | `Product` | JPA mapping of the `products` table |
| DTO | `ProductRequest` | The validated create payload |

The controller never touches the repository and the repository never makes a business decision:
each layer has one job. The request type is separate from the entity so a client cannot choose an
id or a timestamp, and so the validation rules describe the API rather than the table.

The service is a **single concrete class**, not an interface plus an implementation. There is
exactly one implementation and no second one is planned, so an interface would be indirection with
nothing on the other side of it — the controller depends on the class directly and Spring injects
it. It becomes an interface on the day a second implementation (a cached one, say) actually exists,
and not before.

### Endpoints

| Method | Path | Access | Behaviour |
| ------ | ---- | ------ | --------- |
| `GET` | `/api/products` | public | Returns all products, ordered by id |
| `GET` | `/api/products/{id}` | public | Returns one product, or `404` |
| `POST` | `/api/products` | `admin` | Validates and creates a product, returns `201` with the assigned id |
| `GET` | `/me` | authenticated | The signed-in user's name and authorities (starts the login flow) |
| `POST` | `/logout` | authenticated | Ends the session and the Cognito session, then returns the browser to the SPA |
| `GET` | `/actuator/health` | public | Returns `{"status":"UP"}` — the ALB health check target |

Example (the table starts empty — the data is no longer seeded). `<api-fqdn>` is `api.<env-domain>`;
a request to the load balancer's plaintext name is answered with a `301` to the same path over HTTPS.
A write needs an `admin` session **and** a CSRF token, so the `curl` below is expected to fail with
`401` — the browser flow is in
[Core concepts: authentication and authorisation](#core-concepts-authentication-and-authorisation):

```bash
curl https://<api-fqdn>/api/products
# []

# Anonymous write: 401. An admin session + X-XSRF-TOKEN header would return 201.
curl -i -X POST https://<api-fqdn>/api/products \
     -H 'Content-Type: application/json' \
     -d '{"name":"Tablet","description":"10 inch","price":450.00,"quantity":12}'
# HTTP/2 401

curl https://<api-fqdn>/api/products/1
# {"id":1,"name":"Tablet",...}

curl https://<api-fqdn>/actuator/health
# {"status":"UP"}
```

Ids come from a database identity column, so they are unique across restarts and never reused.

### Validation

`ProductRequest` is annotated and the controller marks it `@Valid`, so Bean Validation runs before
the method body and a violation becomes a `400` with no database round trip:

| Field | Rule |
| ----- | ---- |
| `name` | required, not blank, at most 255 characters |
| `description` | optional, at most 1000 characters |
| `price` | required, greater than zero, at most 2 decimal places |
| `quantity` | optional, zero or greater; defaults to 0 |

`price` is a `BigDecimal` throughout — request, entity and column (`NUMERIC(12,2)`). A `double`
cannot represent `0.10` exactly, so money would drift by fractions of a cent on every round trip.

`createdAt` and `updatedAt` are `java.time.Instant` values in `timestamptz` columns: an absolute
point in time with no zone to get wrong. They are stamped by the entity itself (`@PrePersist` /
`@PreUpdate`), never sent by the client, and come back as ISO-8601 UTC (`...Z`).

### Schema and migrations

The schema is owned by **Flyway**, not by Hibernate. `db/migration/V1__create_products_table.sql`
creates `products` and is applied once, in order, with a checksum recorded in
`flyway_schema_history`. Hibernate is configured with `ddl-auto=validate`, so if the entity and the
migrated table ever disagree the application **refuses to start** instead of failing on the first
query at runtime.

Rules that follow from that:

- A schema change is a new `V2__...sql` file, never an edit to `V1`. Flyway checksums applied
  migrations and rejects a changed one.
- `ddl-auto` is never `update`. The application must not alter tables it does not own.
- The tests run the same migrations against a real PostgreSQL (see [Testing](#testing)), so a broken
  migration fails the build rather than a deployment.

### Transactions

`ProductService` is where transactions live. Reads are `@Transactional(readOnly = true)` so
Hibernate skips dirty checking, and `create` runs in a transaction that either commits as a whole or
rolls back as a whole. `spring.jpa.open-in-view=false` keeps a connection from being held open for
the whole request.

### Port and health

The application listens on **8080** (`server.port`), which is also the container port in the task
definition and the target group port — the ECS task passes `SERVER_PORT` so all three stay in sync.
Actuator exposes **only** the `health` endpoint over HTTP, with details suppressed, because that
endpoint is publicly reachable through the load balancer. The health indicator includes the
database: if PostgreSQL is unreachable the endpoint reports `DOWN`, the ALB marks the task unhealthy
and ECS replaces it, rather than serving errors from a task that cannot reach its data.

### Authentication configuration

Every authentication value arrives from the environment, with **no default**, exactly like the
database credentials — a missing value fails the container at start rather than falling back to
something insecure:

| Environment variable | Property | Purpose |
| -------------------- | -------- | ------- |
| `COGNITO_ISSUER_URI` | `spring.security.oauth2.client.provider.cognito.issuer-uri` | OIDC discovery and ID-token signature validation |
| `COGNITO_CLIENT_ID` | `…registration.cognito.client-id` | Public id of the confidential app client |
| `COGNITO_CLIENT_SECRET` | `…registration.cognito.client-secret` | Injected by ECS from Secrets Manager |
| `FRONTEND_URL` | `app.auth.frontend-url` | The SPA's URL: the OAuth2 login-success and post-logout landing (a registered logout URI) |
| `CORS_ALLOWED_ORIGINS` | `app.cors.allowed-origins` | Exact frontend origins, comma separated |
| `SESSION_TIMEOUT` | `server.servlet.session.timeout` | BFF session lifetime (ISO-8601, e.g. `PT30M`) |

The provider is configured by issuer URI, so the JWK set is discovered and the ID token signature is
**always** verified against Cognito's keys — the algorithm is never taken from the token itself.
`server.forward-headers-strategy=framework` makes the redirect URI and the session cookie correct
behind the TLS-terminating load balancer.

The session cookie is `__Host-SESSION`: `httpOnly`, `Secure`, `SameSite=Lax`, host-only, `Path=/`.
The `__Host-` prefix is the strongest scope the platform offers — it stops a sibling subdomain from
setting a cookie this service would accept. `SameSite=Lax` rather than `Strict` is deliberate:
`Strict` would drop the cookie on the top-level navigation back from Cognito and break login.

CSRF uses a double-submit cookie plus Spring's BREACH-protected request handler. The SPA cannot read
that cookie across origins, so `GET /csrf` hands it the token, the header name and the form field
name; one value serves both a `fetch` write and the logout form.

HSTS is set on the **load balancer** listener (`routing.http.response.strict_transport_security.header_value`),
so every response served over 443 — including the port 80 redirect — carries
`max-age=31536000; includeSubDomains`. See the load-balanced-api construct.

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
- **No secrets.** No credential is baked into the image. The database credentials are injected by
  ECS from Secrets Manager when the container starts (see
  [Database credentials and Secrets Manager](#database-credentials-and-secrets-manager)), and no
  `.env` file, keystore or password ever crosses the stage boundary.
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

ecr: pull the image                    Phase 3: nothing
logs: create the stream, write logs
secrets: read the DB credentials
```

| | Execution role | Task role |
| --- | --- | --- |
| Assumed by | The ECS container agent | The application process |
| When | Before the container starts | While the container runs |
| Used for | Pulling the image, writing logs, fetching injected secrets | Calling AWS services the app uses |
| Phase 3 permissions | ECR pull + CloudWatch log write + read one secret | **none** |

**Execution role.** ECS assumes it to perform the infrastructure actions it needs before the
container runs. The permissions are granted with scoped CDK `grant` calls rather than the broad
`AmazonECSTaskExecutionRolePolicy` managed policy:

- `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` — scoped to the
  one repository.
- `ecr:GetAuthorizationToken` — an account-level action that cannot be scoped to a repository, so it
  is the only statement with a `*` resource.
- `logs:CreateLogStream`, `logs:PutLogEvents` — scoped to the one log group.
- `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret` — scoped to the database secret
  **and** the Phase 4 Cognito client secret (two resources, no wildcard). No `kms:*` statement is
  needed because both secrets are encrypted with the AWS managed key, so there is nothing extra to
  grant. The client secret is the one new grant Phase 4 adds; nothing else in IAM changes, and no
  security group rule changes either.

**Task role.** Assumed by the application itself. The API talks to PostgreSQL over JDBC and to no AWS
API at all, so the role carries **no permissions whatsoever** — a compromised container has no AWS
credentials worth using. This is deliberate: the database password reaches the container through the
*execution* role, which never runs application code, so nothing the application can be tricked into
doing also gives it the ability to read secrets.

`test/application-stack.test.ts` asserts that the execution role has no wildcard action and no `kms:`
action, that its only `*` resource is `ecr:GetAuthorizationToken`, and that the task role has no
attached policy at all.

---

## Database credentials and Secrets Manager

The credential flow, end to end:

```
CloudFormation ──generates password──▶ Secrets Manager (username + password)
                                             │
                            execution role   │ secretsmanager:GetSecretValue
                                             ▼
                                        ECS agent (container start)
                                             │
                                             ▼
                       container env: DB_USERNAME, DB_PASSWORD
                                             │
                       container env: DB_HOST, DB_PORT, DB_NAME   (from the DB stack outputs)
                                             ▼
                                    Spring Boot (spring.datasource.*)
```

Rules the implementation follows, and where they are enforced:

| Rule | Where |
| ---- | ----- |
| The password is generated, never written down | `GenerateSecretString` in the database stack; `test/database-stack.test.ts` asserts no literal `password` appears in the template |
| The instance reads it as a dynamic reference | `MasterUserPassword: {{resolve:secretsmanager:...}}`; asserted in the same test |
| The container receives it as an injected secret, not a value | `secrets:` in the task definition; asserted in `test/application-stack.test.ts` |
| No credential is in Java, `application.properties`, the CDK source, the Dockerfile or the README | `application.properties` reads `${DB_USERNAME}`/`${DB_PASSWORD}` with **no default**, so a missing value fails the container instead of falling back to an empty password |
| Only the role that needs it can read it | `secret.grantRead(executionRole)`; the task role stays permissionless |

The secret is created **without an explicit name**. CloudFormation generates one, which means a
`cdk destroy` followed by a `cdk deploy` in dev never collides with a secret that is still inside its
recovery window. Find it by its `Project`/`Environment` tags or by the exported
`ecommerce-<env>-db-secret-arn`.

Reading it by hand (an operator action, not something the application does):

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(aws cloudformation list-exports \
      --query "Exports[?Name=='ecommerce-dev-db-secret-arn'].Value" --output text)" \
  --query SecretString --output text
# {"username":"ecommerce","password":"...","engine":"postgres","host":"...","port":5432,"dbname":"ecommerce"}
```

> The secret carries the connection details as well as the password, because RDS attaches it to the
> instance as a `SecretTargetAttachment`. The application does not rely on that: it reads the host,
> port and database name from the database stack's outputs, so the connection contract does not
> depend on the attachment.

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
  resource carrying the application security group, which in practice is the ECS task. The Phase 3
  database stack *attaches* this group to the RDS instance and adds no rule of its own, so every
  rule in the platform still lives in exactly one place.
- **The database tier has no egress rule either**, and it sits in subnets with no route off the VPC:
  an RDS instance has no reason to start a connection, so it cannot.
- **The application tier has no inbound rule from the internet**, and its outbound internet access is
  limited to TLS (443).
- **Only the load balancer accepts traffic from `0.0.0.0/0`.** Phase 1 opened 443; Phase 2 adds 80 for
  the HTTP listener. Port 80 is added by the *application* stack, not the network stack: the load
  balancer security group is re-imported there so the Phase 2 rule is owned by the Phase 2 stack.
  Phase 3.5 needs no new rule at all — 443 was already open, and 80 is still where the redirect to
  HTTPS answers, so the application stack adds no duplicate ingress rule.
- **The application and database stacks create no security group of their own** — they reference the
  Phase 1 groups, so there is exactly one definition of each.
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
| Database engine | PostgreSQL 16 | PostgreSQL 16 | PostgreSQL 16 |
| Database instance | `db.t4g.micro` | `db.t4g.micro` | `db.t4g.small` |
| Database storage | 20 GiB gp3, encrypted | 20 GiB gp3, encrypted | 50 GiB gp3, encrypted |
| Database backups | 1 day | 7 days | 30 days |
| Database Multi-AZ | off | off | on |
| Database deletion protection | off | on | on |
| Database removal policy | `DESTROY` | `RETAIN` | `RETAIN` |
| Image tag | `v0.1.0` | `v0.1.0` | `v0.1.0` |
| Public DNS subdomain | `ECOMMERCE_DEV_DOMAIN` (**required**) | `ECOMMERCE_UAT_DOMAIN` (**required**) | `ECOMMERCE_PROD_DOMAIN` (**required**) |
| API endpoint | `https://api.<dev-domain>` | `https://api.<uat-domain>` | `https://api.<prod-domain>` |
| Password minimum length | 8 | 10 | 14 |
| Password character classes | lower + digit | upper + lower + digit | all four |
| MFA | off | optional | **required** |
| Self sign-up | on | on | **off** |
| Access / ID token lifetime | 1 h | 30 min | 15 min |
| Refresh token lifetime | 30 d | 7 d | 12 h |
| BFF session timeout | 8 h | 4 h | 30 min |
| CORS allowed origins | `http://localhost:5173` | localhost + `https://<uat-domain>` | `https://<prod-domain>` |
| Post-logout target (SPA) | `http://localhost:5173` | `https://<uat-domain>` | `https://<prod-domain>` |
| Cognito user pool removal policy | `DESTROY` | `RETAIN` | `RETAIN` |
| Removal policy | `DESTROY` | `RETAIN` | `RETAIN` |

> From Phase 4 **every** environment needs a delegated domain, not just production: the BFF's session
> cookie is `Secure`, so an authentication-enabled environment must answer over HTTPS. Dev and uat
> therefore need `ECOMMERCE_DEV_DOMAIN` / `ECOMMERCE_UAT_DOMAIN` set too, and a configuration with
> `auth` but no `dns` fails synth with that reason.

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
pair ECS would refuse, an out-of-range port, a health check path that is not absolute, a `latest`
image tag, a database or user name that is not a valid PostgreSQL identifier, a user name RDS
reserves (`postgres`, `admin`, `rdsadmin`, ...), storage below the gp3 minimum, a backup retention
outside 1–35 days, deletion protection combined with `RemovalPolicy.DESTROY`, a `dns.zoneName` that
is not a valid DNS host name, an `apiSubdomain` that is not a single DNS label, a **production
environment with no `dns` block at all**, and the Phase 4 authentication limits:

- a password minimum length outside Cognito's 6–99 range, or a token lifetime outside the range
  Cognito accepts (access/ID 5 min–1 day, refresh 60 min–10 years);
- a session timeout longer than the refresh token it depends on, or an empty / wildcard / relative
  CORS origin (the API answers with credentials, so `*` is never valid);
- a frontend URL that is not an absolute origin (it is the login landing and a registered logout URI);
- **`auth` with no `dns`** — an authentication-enabled environment needs an HTTPS origin for its
  `Secure` session cookie, so this fails at synth with that reason in every environment;
- **`application.desiredCount > 1`** — the BFF holds sessions in memory, so more than one task would
  split the session store and silently sign users out. The message names the store and Phase 6, and
  the guard is removed when sessions move to Redis/ElastiCache.

A missing `ECOMMERCE_<ENV>_DOMAIN` therefore fails the synth before anything is deployed.

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

The public subdomain is read the same way — `ECOMMERCE_DEV_DOMAIN`, `ECOMMERCE_UAT_DOMAIN`,
`ECOMMERCE_PROD_DOMAIN` — so the domain stays out of source control too. From Phase 4 it is required
in **every** environment (auth needs an HTTPS origin), so it must be set before `cdk synth` or
`cdk deploy` in dev and uat as well as prod.

```powershell
$env:ECOMMERCE_DEV_DOMAIN = "dev.example.com"; npx cdk deploy ecommerce-cognito-dev -c environment=dev
```

```bash
ECOMMERCE_PROD_DOMAIN=prod.example.com npx cdk deploy ecommerce-cognito-prod -c environment=prod
```

The frontend's origins are read the same way where an environment needs one that is not derived from
the domain: `ECOMMERCE_<ENV>_FRONTEND_ORIGIN` is optional and, when set, replaces the default CORS
allowlist for that environment (see `lib/config/<env>.ts`).

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
| Network | `PrivateSubnetIds` | `ecommerce-dev-private-subnet-ids` | ECS tasks |
| Network | `DatabaseSubnetIds` | `ecommerce-dev-database-subnet-ids` | RDS DB subnet group |
| Network | `AlbSecurityGroupId` | `ecommerce-dev-alb-security-group-id` | Phase 2 load balancer |
| Network | `ApplicationSecurityGroupId` | `ecommerce-dev-application-security-group-id` | Phase 2 ECS service |
| Network | `DatabaseSecurityGroupId` | `ecommerce-dev-database-security-group-id` | Phase 3 RDS |
| Registry | `RepositoryUri` | `ecommerce-dev-ecr-repository-uri` | image push |
| Registry | `RepositoryName` | `ecommerce-dev-ecr-repository-name` | image push |
| Database | `DatabaseEndpoint` | `ecommerce-dev-db-endpoint` | ECS task env `DB_HOST` |
| Database | `DatabasePort` | `ecommerce-dev-db-port` | ECS task env `DB_PORT` |
| Database | `DatabaseName` | `ecommerce-dev-db-name` | ECS task env `DB_NAME` |
| Database | `CredentialsSecretArn` | `ecommerce-dev-db-secret-arn` | ECS secret injection, operators |
| DNS | `HostedZoneNameServers` | `ecommerce-dev-hosted-zone-name-servers` | registrar delegation (by hand, once) |
| DNS | `CertificateArn` | `ecommerce-dev-certificate-arn` | the application stack's HTTPS listener |
| DNS | `ApiDomainName` | `ecommerce-dev-api-domain-name` | the application stack's alias record and `ApiUrl` |
| Cognito | `UserPoolId` | `ecommerce-dev-user-pool-id` | operators, Cognito CLI |
| Cognito | `UserPoolClientId` | `ecommerce-dev-user-pool-client-id` | the application stack's `COGNITO_CLIENT_ID` |
| Cognito | `IssuerUrl` | `ecommerce-dev-cognito-issuer-url` | the application stack's `COGNITO_ISSUER_URI` |
| Cognito | `ClientSecretArn` | `ecommerce-dev-client-secret-arn` | the execution role's secret read, operators |
| Application | `ClusterName` | `ecommerce-dev-ecs-cluster-name` | operations |
| Application | `ServiceName` | `ecommerce-dev-ecs-service-name` | operations |
| Application | `LoadBalancerDnsName` | `ecommerce-dev-alb-dns-name` | the load balancer's own name |
| Application | `ApiUrl` | `ecommerce-dev-api-url` | the API endpoint (`https://<fqdn>` when configured) |
| Application | `HttpApiUrl` | `ecommerce-dev-api-http-url` | the plaintext endpoint, for the redirect check (only when DNS is configured) |
| Application | `TargetGroupArn` | `ecommerce-dev-target-group-arn` | operations |
| Frontend | `SiteUrl` | `ecommerce-dev-frontend-url` | the SPA's public URL |
| Frontend | `ServiceName` | `ecommerce-dev-frontend-service-name` | rolling the service after a push |
| Frontend | `TargetGroupArn` | `ecommerce-dev-frontend-target-group-arn` | operations |

---

## Removal policies and resource protection

`RemovalPolicy.DESTROY` is not applied blindly — it follows the environment's `removalPolicy`
(`DESTROY` in dev, `RETAIN` in uat and prod):

- The **flow log group** and the **container log group** are retained in uat/prod.
- The **ECR repository** is emptied on delete in dev and retained in uat/prod, so images survive a
  `cdk destroy`.
- The **ALB** has deletion protection enabled where the removal policy is `RETAIN`.
- The **RDS instance** has its own `deletionProtection` and `removalPolicy` in `DatabaseConfig`,
  plus `deleteAutomatedBackups` following the removal policy: dev really does remove everything,
  uat/prod keep the instance and its recovery window.
- The **database credentials secret** follows the same removal policy, so dev leaves no secret
  behind and uat/prod keep the credential that matches the retained instance.
- The **Route 53 hosted zone** follows the removal policy: dev deletes it with the stack, uat and
  prod retain it. It is the one resource whose removal is not finished by `cdk destroy` alone — the
  registrar's NS records still have to be removed by hand (see the destroy caveat below). The ACM
  certificate is not given a removal policy: it is stateless, re-issued automatically, and deleting
  it with the stack leaves nothing behind to pay for or clean up.
- The **Cognito user pool** is stateful — it holds users — so it follows the removal policy (dev
  destroys it, uat/prod retain it). Deletion protection is deliberately **not** enabled, so the pool
  can always be torn down with its stack. Its client secret follows the removal policy too, so
  uat/prod keep the credential that matches the retained pool. The L2 `UserPool` supports a removal
  policy directly, so no escape hatch is needed here.
- The **frontend tier** has nothing to retain: the ECS service, target group, listener rule and log
  group are all stateless. The image lives in ECR, which follows the removal policy like the API's
  repository, so uat/prod keep the deployed build and dev discards it.

Everything else is either ephemeral by nature (subnets, route tables, security groups) or replaced
rather than deleted.

Two deliberate Phase 3 choices worth knowing:

- **`removalPolicy: RETAIN`, not `SNAPSHOT`, for the database.** `RETAIN` leaves the instance in
  place when the stack is deleted — it keeps running and keeps billing, which is a loud, obvious
  state to be in. `SNAPSHOT` takes a final snapshot and deletes the instance, which is quieter but
  also easy to miss. Either is defensible; this phase chooses the one that cannot silently lose the
  instance's backups.
- **Deletion protection and `DESTROY` are mutually exclusive.** The validator rejects the
  combination, because a stack that can never be deleted is a trap rather than a safeguard.

Stateful resources that are still ahead of this phase, and what they will need:

| Resource | Required protection |
| -------- | ------------------- |
| ElastiCache | Automatic backups, and a final snapshot before replacement |
| S3 (assets, uploads) | `RemovalPolicy.RETAIN`, versioning, and lifecycle rules |
| KMS keys (customer managed) | `RemovalPolicy.RETAIN` — deleting a key is irreversible |

The database currently uses the AWS managed KMS keys for both storage encryption and the secret. A
customer managed key would add key policies, rotation and a per-key charge; it belongs in the same
hardening pass as those resources.

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
mvn test                    # run the Spring Boot tests (starts a PostgreSQL test container)
mvn package                 # build the executable jar (target/ecommerce-api-0.1.0.jar)
docker build -t ecommerce-api:v0.1.0 .
```

`mvn test` needs a running Docker daemon: the tests start a throwaway PostgreSQL container rather
than substituting an in-memory database, so they exercise the real engine, dialect and migrations.
The first run pulls `postgres:16-alpine` if it is not already local.

To run the API locally against a PostgreSQL of your own:

```bash
docker run -d --name ecommerce-pg -p 5432:5432 \
  -e POSTGRES_USER=ecommerce -e POSTGRES_PASSWORD=<your password> -e POSTGRES_DB=ecommerce \
  postgres:16-alpine

DB_HOST=localhost DB_PORT=5432 DB_NAME=ecommerce \
DB_USERNAME=ecommerce DB_PASSWORD=<your password> \
COGNITO_ISSUER_URI=https://cognito-idp.ap-southeast-1.amazonaws.com/<pool-id> \
COGNITO_CLIENT_ID=<client-id> COGNITO_CLIENT_SECRET=<client-secret> \
FRONTEND_URL=http://localhost:5173 \
CORS_ALLOWED_ORIGINS=http://localhost:5173 SESSION_TIMEOUT=PT30M \
SESSION_COOKIE_NAME=SESSION SESSION_COOKIE_SECURE=false \
  java -jar target/ecommerce-api-0.1.0.jar
```

The connection details and the auth configuration are environment variables in every environment,
local or deployed, so nothing about the application changes between the two. The two
`SESSION_COOKIE_*` overrides are the only local-only concessions: the deployed session cookie is
`__Host-SESSION`, which browsers accept only over HTTPS, so a run on plain `http://localhost:8080`
drops both the prefix and `Secure`. Deployed environments leave them at their defaults.

### First deployment

Bootstrap the account and region once before anything can be deployed:

```bash
npx cdk bootstrap aws://<account>/ap-southeast-1
```

Then deploy one environment at a time, in dependency order:

```bash
# 1. Network foundation (VPC, subnets, security groups)
npx cdk deploy ecommerce-network-dev -c environment=dev

# 2. Registry (must exist before an image can be pushed)
npx cdk deploy ecommerce-ecr-dev -c environment=dev

# 3. Database (instance + generated credentials secret)
npx cdk deploy ecommerce-database-dev -c environment=dev

# 4. DNS and TLS (hosted zone + ACM certificate). The domain is required from Phase 4 on.
export ECOMMERCE_DEV_DOMAIN=dev.example.com
npx cdk deploy ecommerce-dns-dev -c environment=dev
#    Then delegate the zone at the registrar (see "Delegating the subdomain") and wait for the
#    certificates to finish issuing before the next steps.

# 5. Cognito (user pool + confidential app client + client-secret secret)
npx cdk deploy ecommerce-cognito-dev -c environment=dev

# 6. Build and push the image (see "ECR: how an image is tagged and pushed")
#    ...

# 7. Compute (the service finds the image, the secrets, the database endpoint and the certificate)
npx cdk deploy ecommerce-application-dev -c environment=dev

# 8. Frontend hosting (nginx service + target group + host rule + apex records)
npx cdk deploy ecommerce-frontend-dev -c environment=dev

# 9. Build and push the storefront image (the service starts once one exists)
cd ../frontend && ECOMMERCE_DEV_DOMAIN=dev.example.com ./scripts/deploy.sh dev
```

`npx cdk deploy --all -c environment=dev` deploys every stack in the correct order in one go, but
only after an image has been pushed for the first time; otherwise the ECS service starts with no
image to run. The stacks will wait on certificates that are still validating until the zone is
delegated.

Things that are easy to get wrong:

- **`-c environment=...` selects the configuration; the stack name selects what is deployed.** Always
  pass both.
- **The CDK CLI silently ignores unknown options.** A mistyped flag does not fail the command — it
  deploys the `cdk.json` default. Read the stack name in the output.
- **Set the domain in every environment.** From Phase 4 an auth-enabled environment needs HTTPS, so a
  missing `ECOMMERCE_<ENV>_DOMAIN` fails synth even in dev.
- **Push the image before deploying the compute.** The service cannot start without it.
- **Deploy the database and Cognito before the compute.** The application stack imports the database
  endpoint and secret, and the pool, client id and client secret.
- **Delegate the zone before expecting HTTPS.** The ACM certificate stays `PENDING_VALIDATION` until
  the registrar's NS records for the subdomain resolve; until then the HTTPS listener has nothing to
  serve, and the Cognito callback URL will not resolve, even though the stacks deploy successfully.
- **Pin the account per environment** before deploying anything other than dev.
- **Deploy from a dedicated IAM principal or Identity Center role, not the account root user.**
- **Deploying is not free:** NAT Gateways, an ALB, a running Fargate task and an RDS instance all
  bill hourly.

Deployment is **not** performed automatically by this repository: nothing in the build or test path
runs `cdk deploy`.

---

## Deployment and verification procedure

An end-to-end check of Phase 3 in dev, from nothing to a row that survives a task replacement.
Everything below is a manual operator action; nothing in this repository deploys.

### 1. Deploy the foundation, registry and database

```bash
export ECOMMERCE_DEV_ACCOUNT=<account>       # PowerShell: $env:ECOMMERCE_DEV_ACCOUNT = "<account>"

npx cdk deploy ecommerce-network-dev    -c environment=dev
npx cdk deploy ecommerce-ecr-dev        -c environment=dev
npx cdk deploy ecommerce-database-dev   -c environment=dev
```

Watch for `CREATE_COMPLETE` on the database stack — RDS takes several minutes to create the
instance.

### 2. Confirm the database is private

```bash
aws rds describe-db-instances --db-instance-identifier ecommerce-dev-db \
  --query "DBInstances[0].{Public:PubliclyAccessible,MultiAZ:MultiAZ,Encrypted:StorageEncrypted,BackupDays:BackupRetentionPeriod}"
# {"Public": false, "MultiAZ": false, "Encrypted": true, "BackupDays": 1}

aws rds describe-db-instances --db-instance-identifier ecommerce-dev-db \
  --query "DBInstances[0].DBSubnetGroup.Subnets[].SubnetAvailabilityZone.Name"
# two different Availability Zones
```

There should be no route from the database subnets to the internet or to a NAT gateway:

```bash
aws ec2 describe-route-tables \
  --filters "Name=association.subnet-id,Values=$(aws cloudformation list-exports \
      --query "Exports[?Name=='ecommerce-dev-database-subnet-ids'].Value" --output text)" \
  --query "RouteTables[].Routes"
# each route table has only the implicit local route
```

### 3. Confirm the security group chain

```bash
aws ec2 describe-security-groups \
  --group-ids "$(aws cloudformation list-exports \
      --query "Exports[?Name=='ecommerce-dev-database-security-group-id'].Value" --output text)" \
  --query "SecurityGroups[0].IpPermissions"
# exactly one rule: TCP 5432, SourceSecurityGroupId = the application security group, no CidrIp
```

There must be **no** `0.0.0.0/0` rule on the database security group.

### 4. Push the image and deploy the compute

```bash
docker build -t ecommerce-api:v0.1.0 application
docker tag ecommerce-api:v0.1.0 <account>.dkr.ecr.ap-southeast-1.amazonaws.com/ecommerce-dev-api:v0.1.0
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-southeast-1.amazonaws.com
docker push <account>.dkr.ecr.ap-southeast-1.amazonaws.com/ecommerce-dev-api:v0.1.0

npx cdk deploy ecommerce-application-dev -c environment=dev
```

### 5. Confirm the migration ran and the API reads and writes PostgreSQL

```bash
API=$(aws cloudformation list-exports \
  --query "Exports[?Name=='ecommerce-dev-api-url'].Value" --output text)

curl "$API/api/products"
# []

curl -X POST "$API/api/products" -H 'Content-Type: application/json' \
     -d '{"name":"Tablet","description":"10 inch","price":450.00,"quantity":12}'
# {"id":1,...,"createdAt":"...","updatedAt":"..."}

curl "$API/api/products/1"
# {"id":1,"name":"Tablet",...}

curl "$API/actuator/health"
# {"status":"UP"}
```

The Flyway migration is recorded in the container log at startup:

```bash
aws logs tail /ecs/ecommerce-dev-api --since 10m | grep -i flyway
# Successfully applied 1 migration to schema "public", now at version v1
```

### 6. Confirm the data is really in the database

The task cannot reach the internet, so the simplest check is to force a task replacement and see the
row survive — the data is in RDS, not in the container:

```bash
aws ecs update-service --cluster ecommerce-dev-cluster --service ecommerce-dev-api --force-new-deployment
aws ecs wait services-stable --cluster ecommerce-dev-cluster --services ecommerce-dev-api

curl "$API/api/products/1"
# {"id":1,"name":"Tablet",...}   <- still there, from a different task
```

### 7. Confirm no credential is exposed

```bash
aws ecs describe-task-definition --task-definition ecommerce-dev-api-task \
  --query "taskDefinition.containerDefinitions[0].{env:environment,secrets:secrets}"
# environment: DB_HOST / DB_PORT / DB_NAME only
# secrets:     DB_USERNAME / DB_PASSWORD, each a valueFrom reference into Secrets Manager
```

No password appears anywhere in that output, in the task definition, in the image or in this
repository.

### 8. Tear down (dev only)

```bash
npx cdk destroy ecommerce-application-dev -c environment=dev
npx cdk destroy ecommerce-dns-dev         -c environment=dev   # only when a domain was configured
npx cdk destroy ecommerce-database-dev    -c environment=dev   # deletes the instance and the secret
npx cdk destroy ecommerce-ecr-dev         -c environment=dev
npx cdk destroy ecommerce-network-dev     -c environment=dev
```

Dev has `deletionProtection: false` and `RemovalPolicy.DESTROY` precisely so this works. In uat/prod
the destroy is refused until deletion protection is switched off — which is the point. The hosted
zone needs one extra manual step; see [Destroy caveat](#10-destroy-caveat-dns-and-the-registrar).

### 9. Phase 3.5: delegate the subdomain and verify TLS

With `ECOMMERCE_DEV_DOMAIN` set, the DNS stack creates the hosted zone and the certificate and the
application stack attaches them. The certificate cannot finish issuing until the zone is delegated,
so the order is: deploy the DNS stack, delegate, wait, then deploy the compute.

```bash
export ECOMMERCE_DEV_DOMAIN=dev.example.com   # PowerShell: $env:ECOMMERCE_DEV_DOMAIN = "dev.example.com"

# 1. Create the hosted zone and start the certificate request.
npx cdk deploy ecommerce-dns-dev -c environment=dev

# 2. Copy the four name servers the zone exported.
aws cloudformation list-exports \
  --query "Exports[?Name=='ecommerce-dev-hosted-zone-name-servers'].Value" --output text
# ns-123.awsdns-45.com,ns-678.awsdns-90.net,ns-234.awsdns-12.co.uk,ns-567.awsdns-34.org

# 3. Add them as the NS record for dev.example.com at the registrar (one record, four values).
#    This is the only manual DNS step; ACM writes and renews the validation CNAME itself.

# 4. Wait for the certificate to issue (minutes to an hour, depending on the registrar).
aws acm list-certificates --query "CertificateSummaryList[?DomainName=='api.dev.example.com']"
# Status: ISSUED

# 5. Deploy the compute; it now has a certificate and a zone to create the alias record in.
npx cdk deploy ecommerce-application-dev -c environment=dev
```

Verification:

```bash
# The plaintext endpoint answers a permanent redirect, not a response from the application.
curl -I "http://api.dev.example.com/api/products"
# HTTP/1.1 301 Moved Permanently
# Location: https://api.dev.example.com:443/api/products

# The HTTPS endpoint serves the API over TLS.
curl "https://api.dev.example.com/actuator/health"
# {"status":"UP"}

curl "https://api.dev.example.com/api/products"
# []
```

A `301` whose `Location` is the HTTPS URL proves the redirect; `{"status":"UP"}` over `https://`
proves the certificate, the listener and the alias record are all working. `curl -v` shows the
certificate chain and the negotiated protocol if you want to confirm TLS 1.2 is the floor.

The redirect preserves the host you requested rather than hardcoding the API domain — a request to
`http://<alb-dns-name>/...` is answered with `Location: https://<alb-dns-name>:443/...`. That is the
right behaviour (it never sends a client to a name it did not ask for), and it is why the redirect is
verified against the custom domain rather than the load balancer's own name.

### 10. Phase 4: verify authentication and authorisation

Deploy the Cognito stack before the application (see [First deployment](#first-deployment)), then
check the access-control contract from outside the VPC. These are the same checks
`test/SecurityTest.java` makes in-process:

```bash
# Public read: no credentials.
curl "https://api.dev.example.com/api/products"
# []

# Anonymous write: 401, not a 302 to the hosted UI.
curl -i -X POST "https://api.dev.example.com/api/products" \
  -H 'Content-Type: application/json' -d '{"name":"X","price":1.00}'
# HTTP/2 401

# Health stays anonymous, and HSTS is present on the TLS response.
curl -sI "https://api.dev.example.com/actuator/health" | grep -i strict-transport-security
# strict-transport-security: max-age=31536000; includeSubDomains
```

Then the browser flow, by hand (there is no automated browser test this phase):

1. Create an admin user and add it to the `admin` group (dev has self sign-up on, so a user can
   register through the hosted UI; group membership is still an operator action). A self-registered
   user must confirm the account first: the sign-up page collects an email and Cognito emails a code,
   which the hosted UI asks for before the first sign-in. An already-`UNCONFIRMED` user can be
   confirmed directly with `aws cognito-idp admin-confirm-sign-up`:
   ```bash
   aws cognito-idp admin-create-user --user-pool-id "$(aws cloudformation list-exports \
     --query "Exports[?Name=='ecommerce-dev-user-pool-id'].Value" --output text)" \
     --username tester --user-attributes Name=email,Value=tester@example.com
   aws cognito-idp admin-add-user-to-group --user-pool-id <pool-id> --username tester --group-name admin
   ```
2. Open `https://api.dev.example.com/me`. It redirects to the Cognito hosted UI; sign in. You land
   back on the BFF, which creates the session, and `/me` shows `ROLE_admin` among the authorities.
3. From the SPA (or the browser console), read the `XSRF-TOKEN` cookie and `POST /api/products` with
   `credentials: 'include'` and `X-XSRF-TOKEN`. Expect `201`. Remove the group and repeat for `403`;
   clear the cookie and repeat for `401`.
4. `POST /logout` with the CSRF header. The BFF ends the session, redirects through Cognito's
   end-session endpoint, and returns the browser to the SPA (`auth.frontendUrl`).

### 11. Destroy caveat: DNS and the registrar

`cdk destroy` removes the hosted zone in dev, but it cannot remove the NS records you added at the
registrar — those live in the registrar's zone, not in Route 53. Tearing an environment down
completely is therefore a few commands plus one manual step:

```bash
npx cdk destroy ecommerce-application-dev -c environment=dev
npx cdk destroy ecommerce-cognito-dev     -c environment=dev
npx cdk destroy ecommerce-dns-dev         -c environment=dev
# then: delete the NS records for dev.example.com at the registrar by hand
```

In uat and prod the hosted zone is retained (its removal policy follows the environment), so
`cdk destroy` leaves the zone — and the delegation — in place. That is deliberate: the zone is the
platform's public identity, and recreating it means a fresh set of name servers and another manual
registrar change.

---

## Testing

`npm test` in `ecommerce-infrastructure/` runs **205 Jest tests** over the synthesised CloudFormation
templates and the configuration modules — 33 for the network stack, 18 for the database stack, 41 for
the application stack, 12 for the DNS stack, 26 for the Cognito stack, 17 for the frontend stack, 7
for the registry stack and 51 for the configuration. `mvn test` in `application/` runs **28 Spring
Boot tests** — 9 product end-to-end HTTP tests against a real PostgreSQL, 13 access-control tests, 2
logout-handler tests, and 4 service unit tests — and needs a Docker daemon. `npm test` in `frontend/`
runs **13 Vitest tests** over the cart store, the formatting/error helpers and the post-login
redirect guard, with no Nuxt runtime needed.

`test/setup-env.ts` sets `ECOMMERCE_DEV_DOMAIN`, `ECOMMERCE_UAT_DOMAIN` and `ECOMMERCE_PROD_DOMAIN`
before `lib/config` is first imported, because from Phase 4 every environment requires a domain and
the module reads its environment once, at import. The suites that prove the missing-domain failure
build their own configuration instead of relying on it.

Network (Phase 1, Phase 3):

- the VPC exists, with the configured CIDR and DNS support, and a different CIDR per environment
- two Availability Zones in dev and uat, three in prod, with one public, one private and one isolated
  subnet each
- public subnets do not auto-assign public IPs
- an Internet Gateway exists and both public route tables send `0.0.0.0/0` to it
- exactly one NAT Gateway in dev, one per AZ in prod, each in a public subnet with an Elastic IP
- both private route tables send `0.0.0.0/0` to a NAT Gateway and never to the Internet Gateway
- the isolated database subnets have route tables with **no routes at all**, so there is no path to
  the internet gateway or to a NAT gateway
- the three tier security groups exist; only the ALB accepts `0.0.0.0/0` inbound
- the application and database tiers are reachable only by security group reference
- the project, environment and management tags are present on every resource
- the VPC, public, private and database subnet outputs exist, with one subnet id per Availability Zone
- flow logs are off in dev and capture all traffic in prod, with a scoped delivery policy

Registry (Phase 2):

- the repository is named per environment and scans images on push
- untagged images expire; the repository is emptied on delete in dev and retained in prod
- the repository is tagged and its push URI is exported

Database (Phase 3):

- one PostgreSQL instance per environment, with the engine version, class, storage and database name
  from the configuration
- the instance is never publicly accessible, and its DB subnet group contains the two isolated
  database subnets and no application or public subnet
- the instance carries the Phase 1 database security group; the database stack creates **no** security
  group, **no** ingress rule and no `0.0.0.0/0` anywhere
- storage is encrypted with gp3; automated backups are on with 1/7/30 day retention
- deletion protection is off in dev and on in uat/prod; the removal policy is `DESTROY` in dev and
  `RETAIN` in uat/prod, and `deleteAutomatedBackups` follows it
- Multi-AZ is off in dev/uat and on in prod
- the password is generated by Secrets Manager (no literal password appears in the template), the
  instance reads it as a dynamic reference, and the secret is destroyed with dev but retained with
  uat/prod
- no administrator, power-user or AWS-managed policy appears anywhere
- the instance and the secret carry the project, environment and management tags
- the endpoint, port, database name and secret ARN are exported

DNS and TLS (Phase 3.5):

- a public hosted zone is created for the configured subdomain, with no lookup and no parameter
  other than CDK's bootstrap version — so `cdk synth` needs no credentials
- the certificate covers `api.<zoneName>` and only that name: no wildcard, no extra subject
  alternative names
- the certificate is DNS validated against the zone it created (`DomainValidationOptions` points at
  the hosted zone), so ACM manages the validation record
- the hosted zone is destroyed with dev and retained in uat/prod
- the zone and the certificate carry the project, environment and management tags
- the name servers, certificate ARN and API domain name are exported

Cognito (Phase 4):

- the user pool is named per environment, with the password policy, MFA mode and self sign-up from
  `config.auth` (dev off/permissive, prod `REQUIRED`/strict), and only TOTP as a second factor
- the removal policy follows the environment (dev `DESTROY`, uat/prod `RETAIN`), and deletion
  protection is not set, so the pool can always be torn down
- the app client has a generated secret and **only** the authorization code grant flow enabled — the
  implicit and client credentials flows are never on, and the explicit auth flow is SRP alone, so
  `ALLOW_USER_PASSWORD_AUTH` (the resource owner password grant) does not exist and
  `ALLOW_REFRESH_TOKEN_AUTH` is absent (Cognito forbids it alongside refresh rotation)
- the callback URIs are exact (no wildcard) and the logout URI is the frontend, and the scopes are
  `openid email profile` only
- the token lifetimes come from configuration, in minutes (dev longer, prod shorter)
- refresh token rotation and revocation are enabled
- the client secret is stored in Secrets Manager (its value never appears in the template) under the
  `clientSecret` key
- a Cognito prefix domain hosts the managed login pages
- **no identity pool** is created
- one baseline CloudWatch alarm exists (`SignInThrottles`)
- the pool and the secret carry the project, environment and management tags
- the pool id, client id, issuer URL and client secret ARN are exported

Frontend hosting (Phase 4.5):

- the task runs nginx on Fargate with the configured size, in the private subnets, on the application
  security group, with no public IP - and the stack adds no security group rule
- the container port, health check path (`/healthz`) and target group follow configuration, and the
  health check is answered by nginx rather than by the built bundle
- the execution role can pull the one frontend image and write to the one log group, and nothing
  else; the task role has no permissions at all
- the host rule matches the apex only, forwards to the frontend target group, and is owned by this
  stack (the listener is re-imported); every other host falls through to the API
- the stack creates no listener, no security group and no repository of its own
- IPv4 and IPv6 alias records point the apex at the load balancer
- the service rolls back a failed deployment, and runs two tasks in prod but one in dev/uat
- the resources are tagged, and the site URL, service name and target group ARN are exported

Application (Phase 2, Phase 3, Phase 3.5, Phase 4):

- the cluster, task definition and service exist; the task is Fargate with `awsvpc` networking
- the task is sized 512/1024 in dev and 1024/2048 in prod, and never references a `latest` image
- the container exposes port 8080 and logs to the dedicated log group
- the container receives `DB_HOST`, `DB_PORT` and `DB_NAME` as plain environment variables, and
  `DB_USERNAME`/`DB_PASSWORD` as **secret references**, not values
- the container receives `COGNITO_ISSUER_URI`, `COGNITO_CLIENT_ID`, `FRONTEND_URL`,
  `CORS_ALLOWED_ORIGINS` and `SESSION_TIMEOUT` as plain environment variables, all resolved from the
  Cognito stack / configuration, and `COGNITO_CLIENT_SECRET` as a **secret reference**
- the application stack defines no database instance, no secret and no Cognito resource of its own
- the execution role has only scoped ECR pull, log write and secret read permissions, with no wildcard
  action and no `kms:` action; its only `*` resource is `ecr:GetAuthorizationToken`. Phase 4 adds
  exactly one scoped grant (the Cognito client secret) and no new security group rule
- the task role has no permissions at all; no administrator or power-user policy appears anywhere
- the service runs exactly one task, in the private subnets, without a public IP, in the application
  security group, with the circuit breaker enabled
- the load balancer is internet-facing in the public subnets and opens only port 80 to the internet
  (the application stack adds no duplicate rule for 443, which Phase 1 already opened)
- a stack built without `dns` still supports the certificate-less forwarding listener — the construct
  capability is kept even though every environment now configures a domain
- the port 443 listener terminates TLS (`ELBSecurityPolicy-TLS13-1-2-2021-06`), carries the HSTS
  response header, and forwards to the target group; the port 80 listener is a permanent redirect to
  HTTPS; an alias `A` record points at the load balancer (never an IP); and `ApiUrl` is
  `https://<fqdn>` with the plaintext URL kept as `HttpApiUrl` for the redirect check
- the application stack defines neither the hosted zone nor the certificate, only references them
- the target group health checks `/actuator/health` on 8080
- the project, environment and management tags are present on every resource

Configuration:

- valid per environment, non-overlapping CIDRs, no hardcoded account ids, no secrets
- unknown environment names are rejected
- invalid Fargate cpu/memory pairs, ports, health check paths and `latest` image tags are rejected
- invalid PostgreSQL identifiers, reserved master user names, too-small storage, a backup retention
  outside 1–35 days, and deletion protection combined with `DESTROY` are all rejected
- an invalid DNS zone name and an API subdomain that is not a single label are rejected
- **every** environment now requires a `dns` block (auth needs an HTTPS origin), and `auth` without
  `dns` is rejected with that reason
- a password length outside 6–99, a token lifetime outside Cognito's range, a session longer than the
  refresh token, an empty / wildcard / relative CORS origin, and a non-absolute frontend URL are
  all rejected
- `application.desiredCount > 1` is rejected while sessions are in memory
- the database configuration never contains a password, and the auth configuration never contains a
  secret
- the image tag is resolved from CDK context, then `IMAGE_TAG`, then configuration

Spring Boot (Phase 3, Phase 4):

- the tests run against a real PostgreSQL 16 container, migrated by the same Flyway migration the
  deployment uses, so the engine, the dialect and the schema are the ones that matter
- `GET /api/products` and `/actuator/health` succeed unauthenticated
- an anonymous `POST /api/products` is rejected with `401` (not a redirect), and nothing is written
- an authenticated non-admin `POST` is rejected with `403`; an admin `POST` returns `201` and the row
  is persisted — the same rule a later write endpoint inherits
- a page request to a protected path (`/me`) redirects to the Cognito authorization endpoint
- the authorization request carries a PKCE `code_challenge` with `code_challenge_method=S256`, plus
  `state` and `nonce`
- CORS allows the configured origin with credentials and refuses any other origin
- `GET /csrf` returns the token, the header name and the form field name; a write carrying that token
  in the returned header is accepted — the cross-origin flow the SPA actually uses
- the logout handler builds Cognito's `logout_uri` URL (and never the OIDC
  `post_logout_redirect_uri`/`id_token_hint` that Cognito does not understand), and falls back to the
  frontend when there is no OIDC session to end
- an empty table returns `[]`, and an unknown id returns `404`
- creating a product returns `201` with a database-assigned id and populated timestamps, and the row
  is then readable through `GET` — proving the data went to PostgreSQL, not to a field
- products come back ordered by id
- an omitted `quantity` defaults to zero
- a missing or blank name, a price of zero or less, a missing price and a negative quantity are all
  rejected with `400`, and nothing is written
- the service maps a request onto an entity, defaults an omitted quantity and sorts by id
- `/actuator/health` reports `UP`, which includes a successful database check

Frontend (Phase 4.5), `npm test` in `frontend/`:

- the cart merges a repeated add, computes count and subtotal across lines, removes a line at
  quantity zero, ignores an unknown line and clears
- money formatting and the API error mapper (401/403/400/404) are covered, and the mapper never
  echoes the response body

The storefront's OAuth round trip (sign in, add to cart, admin create, sign out) is a **manual**
check this phase, documented in `frontend/README.md`; browser automation belongs with Phase 8.

---

## Cost expectations

Phase 1 is mostly free; the cost is NAT Gateways and (in uat/prod) flow logs. Phase 2 adds the
always-on compute. Phase 3 adds the database, which is the one component that keeps costing while
nothing is running. Phase 4 adds Cognito, which is priced by monthly active users and is free at the
scale this learning platform runs at.

| Item | Rough cost driver |
| ---- | ----------------- |
| VPC, subnets, route tables, Internet Gateway, security groups | no charge |
| NAT Gateway | hourly charge per gateway + per GB processed |
| Elastic IPs attached to NAT Gateways | no charge while attached |
| VPC Flow Logs | CloudWatch Logs ingestion per GB, plus storage |
| **Application Load Balancer** | hourly charge + LCU (connections, bandwidth, rules) |
| **Fargate task** | per vCPU-hour and per GB-hour while the task runs |
| **RDS instance** | per instance-hour while it exists, whether or not it is queried |
| **RDS Multi-AZ** | doubles the instance charge (prod only) |
| **RDS storage and backups** | per GB-month of gp3 storage, plus backup storage beyond the free amount |
| **Secrets Manager** | per secret-month, plus a small charge per 10,000 API calls |
| **CloudWatch Logs** | ingestion per GB, plus storage per retention period |
| ECR storage | per GB-month, plus a small charge for scanning |
| **Route 53 hosted zone** | per hosted zone-month, plus a small charge per million DNS queries |
| **ACM certificate** | no charge for a public certificate attached to an AWS service; it renews automatically |
| **Cognito user pool** | free up to the monthly active user free tier, then per MAU; a learning platform stays inside it. Advanced security features and SMS MFA would add cost — neither is used |
| **Frontend Fargate task** | a second always-on task: 0.25 vCPU / 512 MiB in dev, 2 × 0.5 vCPU in prod. The cheapest part of the always-on bill, and the price of not having a CDN |
| **Frontend ECR repository** | image storage, pennies per GB-month |
| The default-SG cleanup Lambda | one invocation per stack create/update |
| The Cognito client-secret reader Lambda | one invocation per stack create/update |

The `dev` configuration is deliberately the cheapest (one NAT Gateway, no flow logs, the smallest
sensible Fargate task, a single small RDS instance with one day of backups) while remaining
topologically identical to prod, so a change tested in dev behaves the same way in prod.

The two biggest ongoing costs are the RDS instance and the Fargate task, both billed by the hour
whether or not they are used, followed by the load balancer. `npx cdk destroy` stops all three;
there is no scale-to-zero for a database, which is exactly why dev is configured to be destroyable
and why prod is configured not to be destroyed by accident.

---

## Phase 5 and beyond

The platform is designed so the next phase attaches resources without redesigning what exists:

```
                 Phase 5
                    │
                    ▼
            SNS / SQS order pipeline    ← the first async flow
                    │
            Object storage, customer managed KMS keys
                    │
            ElastiCache (Redis) + ECS auto scaling
                    │
            CloudFront (+ a us-east-1 certificate), WAF, CI/CD
```

Phase 4 delivered authentication and authorisation: the BFF holds the session, reads the pool and
client secret by reference, and enforces `admin` by claim. Phase 4.5 delivered the storefront, served
by nginx behind the existing load balancer, so the platform now has a browser client that exercises
that flow end to end. What is still ahead:

- **Messaging** (Phase 5): the order pipeline — `POST /api/orders` writes RDS and publishes to SNS,
  SQS consumes with a DLQ, a worker updates order status. Orders inherit the Phase 4 authorization
  rule rather than re-deciding it.
- **A cache** (ElastiCache) in the same private subnets, behind the same database security group
  pattern.
- **ECS auto scaling**, which is what actually makes production resilient to losing a task. The
  deliberate remaining limitation is `desiredCount = 1` everywhere, and it is **now enforced** by the
  configuration validator because the BFF holds sessions in memory. Externalising sessions to Redis
  is the change that lifts the guard; until then, auto scaling must not be enabled.
- **Object storage and queues/topics**, plus customer managed KMS keys for the database, the secrets
  and those resources.
- **CloudFront** (Phase 6) as a CDN **in front of the frontend service** that already exists — cache
  behaviours for the hashed assets, everything else forwarded to the load balancer. It needs its own
  certificate in `us-east-1`, and it needs the account verified for CloudFront, which is why the
  storefront is served directly from the load balancer today. No application change is required.
- **Bearer-token / resource-server support** for future mobile or service clients. Deliberately
  deferred this phase: `spring-boot-starter-oauth2-resource-server` is not on the classpath, and the
  `/api/**` rules live in one place, so adding a second authentication entry point is additive.
- **WAF and CI/CD** in the phases after that.

TLS and DNS landed in Phase 3.5: the API now answers at `https://api.<env-domain>`, HTTP redirects to
it, and the certificate renews itself for as long as the hosted zone exists. DNSSEC signing and CAA
records are deliberately deferred hardening items, as is Cognito advanced security (threat
protection) and a custom Cognito domain.

Nothing built so far needs to change for those to land. The network already separates public,
private and isolated subnets; the security groups already model the tiers by reference; the outputs,
tags and IAM split are in place; and the task definition takes its database and auth connection from
the environment, so pointing it at a different pool or database is a stack parameter rather than a
code change. The application's own schema is versioned by Flyway, so a later phase can add tables
without touching the ones already deployed.
