# Pause & resume the dev environment

How to stop paying for idle dev resources without tearing the platform down — and how to bring it
back in about five minutes.

The dev environment is paused by **scaling to zero**, not by destroying stacks. Everything slow or
fragile to recreate — the hosted zone, both ACM certificates, the Cognito user pool, the
`auth.<zone>` custom domain (a Cognito-managed CloudFront distribution that can take up to an hour
to provision), and the container images — stays deployed. Only the three things that bill per hour
are stopped: the database, the Fargate tasks, and the NAT gateway.

## What stays vs. what stops

| Resource | Paused state | ~Cost paused | ~Cost running |
| -------- | ------------ | ------------ | ------------- |
| ECS services (`ecommerce-dev-api`, `ecommerce-dev-frontend`) | scaled to 0 | $0 | ~$34/mo |
| RDS `ecommerce-dev-db` | stopped (kept) | $2.76/mo (storage) | ~$21/mo |
| NAT gateway + Elastic IP | deleted via `ECOMMERCE_DEV_NAT_GATEWAYS=0` | $0 | ~$43/mo |
| ALB + target groups + DNS records | kept | ~$18/mo | ~$18/mo |
| Route 53 zone, Secrets Manager, ACM certs, Cognito pool + custom domain, ECR | kept | ~$1.30/mo | ~$1.30/mo |
| **Total** | | **~$22/mo** | **~$117/mo** |

All eight stacks remain deployed while paused. The site answers (the ALB and the managed login page
stay up) but returns 503/empty responses — that is expected, not a bug.

> **RDS auto-restarts after 7 days** — an AWS limit on stopped instances, not a bug. If the
> environment stays paused longer, either stop it again each week or accept ~$18/mo of compute
> billing once it comes back.

## Pause

```bash
cd ecommerce-infrastructure

# 1. Stop the database (async — takes a few minutes, no action needed)
aws rds stop-db-instance --db-instance-identifier ecommerce-dev-db

# 2. Drain both services. Do this BEFORE removing the NAT gateway: the ECS
#    agent needs outbound connectivity to receive the stop command.
aws ecs update-service --cluster ecommerce-dev-cluster --service ecommerce-dev-api      --desired-count 0
aws ecs update-service --cluster ecommerce-dev-cluster --service ecommerce-dev-frontend --desired-count 0

# 3. Remove the NAT gateway and its Elastic IP (~2 min)
ECOMMERCE_DEV_NAT_GATEWAYS=0 \
ECOMMERCE_DEV_DOMAIN=ouklymeng.qzz.io \
ECOMMERCE_DEV_ACCOUNT=572396340039 \
npx cdk deploy ecommerce-network-dev -c environment=dev
```

On PowerShell set the variables differently:

```powershell
$env:ECOMMERCE_DEV_NAT_GATEWAYS = "0"
$env:ECOMMERCE_DEV_DOMAIN       = "ouklymeng.qzz.io"
$env:ECOMMERCE_DEV_ACCOUNT      = "572396340039"
npx cdk deploy ecommerce-network-dev -c environment=dev
```

## Resume

```bash
cd ecommerce-infrastructure

# 1. Start the database (~2-3 min, runs while the next step deploys)
aws rds start-db-instance --db-instance-identifier ecommerce-dev-db

# 2. Restore the NAT gateway — the ECS tasks need it to pull images and reach
#    Cognito/Secrets Manager. Simply omit the zero-override (~2 min).
ECOMMERCE_DEV_DOMAIN=ouklymeng.qzz.io \
ECOMMERCE_DEV_ACCOUNT=572396340039 \
npx cdk deploy ecommerce-network-dev -c environment=dev

# 3. Scale the services back up (~1-2 min to healthy)
aws ecs update-service --cluster ecommerce-dev-cluster --service ecommerce-dev-api      --desired-count 1
aws ecs update-service --cluster ecommerce-dev-cluster --service ecommerce-dev-frontend --desired-count 1
```

## Verify it is back

```bash
# RDS must be "available" before the API task can stay up (it connects at boot)
aws rds describe-db-instances --db-instance-identifier ecommerce-dev-db \
  --query "DBInstances[0].DBInstanceStatus" --output text

# Both services back to 1/1
aws ecs describe-services --cluster ecommerce-dev-cluster \
  --services ecommerce-dev-api ecommerce-dev-frontend \
  --query "services[].{svc:serviceName,desired:desiredCount,running:runningCount}" --output table

curl -s -o /dev/null -w "%{http_code}\n" https://api.ouklymeng.qzz.io/actuator/health   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://ouklymeng.qzz.io                      # 200
curl -s -o /dev/null -w "%{http_code}\n" https://auth.ouklymeng.qzz.io/login           # 200
```

If an ECS service flaps on resume, it is almost always because RDS is not `available` yet — wait and
the service stabilises on its own, or check
`aws ecs describe-services --query "services[].events[:5]"`.

## Why the ALB is kept

The Application Load Balancer (~$18/mo) is the deliberate cost of a fast resume. Destroying the
application/frontend stacks would save it, but then a resume means recreating the load balancer,
listeners, target groups and DNS records — several minutes of CloudFormation each way — and the apex
A record would disappear, which the Cognito custom domain relies on existing if the auth-domain
stack is ever redeployed. For a long shutdown where $18/mo matters more than restart speed, use the
full teardown in the next section instead.

## Full teardown (alternative, ~$4/mo, slow resume)

If the environment will be down for weeks, destroy the compute instead of scaling it. Resume then
takes ~10 minutes and recreates the ALB and its DNS records.

```bash
# Pause: destroy compute, remove NAT, stop the database
npx cdk destroy ecommerce-frontend-dev ecommerce-application-dev -c environment=dev
ECOMMERCE_DEV_NAT_GATEWAYS=0 npx cdk deploy ecommerce-network-dev -c environment=dev
aws rds stop-db-instance --db-instance-identifier ecommerce-dev-db

# Resume: NAT first, database in parallel, then compute
ECOMMERCE_DEV_DOMAIN=ouklymeng.qzz.io ECOMMERCE_DEV_ACCOUNT=572396340039 \
  npx cdk deploy ecommerce-network-dev -c environment=dev
aws rds start-db-instance --db-instance-identifier ecommerce-dev-db
ECOMMERCE_DEV_DOMAIN=ouklymeng.qzz.io ECOMMERCE_DEV_ACCOUNT=572396340039 \
  npx cdk deploy ecommerce-application-dev ecommerce-frontend-dev -c environment=dev
```

Never `cdk destroy` `ecommerce-dns-dev`, `ecommerce-database-dev`, `ecommerce-auth-cert-dev`,
`ecommerce-auth-domain-dev` or `ecommerce-cognito-dev` as a way to save money: they are nearly free
to keep, and destroying them means re-delegating DNS at the registrar, recreating the user pool and
waiting for the custom domain's CloudFront distribution again.
