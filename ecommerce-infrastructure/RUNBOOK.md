# Runbooks

Operational procedures for the known failure modes, in the order they are most likely to be met.
Each entry is: **symptoms → diagnosis → fix → follow-up**. Commands assume
`REGION=ap-southeast-1` and an environment name (`dev`, `uat`, `prod`) unless stated otherwise.

For deliberately taking dev down and bringing it back, see `PAUSE-RESUME.md` — this document is
for when the platform misbehaves, not for planned cost pauses.

---

## 1. ECS task will not start (service stuck in "provisioning")

**Symptoms:** `SmokeTests` fails on `/actuator/health` or the apex; ECS console shows tasks cycling
`PENDING → STOPPED`; `aws ecs describe-services` shows `desiredCount` never reached.

**Diagnosis, in order:**

```bash
# 1. Stopped-task reason - the single most useful output.
aws ecs describe-tasks --region $REGION --cluster ecommerce-<env>-cluster \
  --tasks $(aws ecs list-tasks --region $REGION --cluster ecommerce-<env>-cluster \
    --service-name ecommerce-<env>-api --desired-status STOPPED --query 'taskArns[0]' --output text) \
  --query 'tasks[0].{reason:stoppedReason,code:stopCode,containers:containers[].reason}'

# 2. Container logs - app failure or a missing env var looks like a crash loop.
aws logs tail /ecs/ecommerce-<env>-api --region $REGION --since 30m
```

| `stoppedReason` | Cause | Fix |
|---|---|---|
| `CannotPullContainerError` | Image tag does not exist in the shared registry, or the execution role cannot pull cross-account | Verify the tag: `aws ecr describe-images --repository-name ecommerce-api --image-ids imageTag=<tag>`; for cross-account, check the repository resource policy lists the environment's account (see §7) |
| `ResourceInitializationError` + secrets | Secrets Manager read failed (execution role) | Task execution role must read `CredentialsSecretArn` + `ClientSecretArn` — both are `grantRead`ed by the stacks; a manual role edit is the usual culprit |
| `OutOfMemoryError` / OOM | Task too small | Raise `application.memoryLimitMiB` in the env config |
| No tasks start at all | Desired count 0 (paused) | `PAUSE-RESUME.md` — resume, don't debug |

**Follow-up:** if the task now starts but health checks fail, the target group health check path is
`/actuator/health` — curl it via the API alias before blaming the service.

## 2. Smoke tests fail in the pipeline but dev "looks up"

**Symptoms:** `SmokeTests-<env>` step fails; the site itself loads in a browser.

**Diagnosis:** the smoke step runs five curl checks — health, public read, anonymous write (401),
apex, managed login. The failing URL is printed in the CodeBuild log (`FAIL: <url> did not
answer <status>`). Most often it is `/api/products` returning 401→expected-200 confusion, or the
`auth.<domain>` check timing out because the managed-login CloudFront takes minutes to provision
after the `auth-domain` stack deploys.

**Fix:** re-run the failed action from the pipeline console after a few minutes for DNS/CDN
propagation; only then suspect a real regression. A persistent `/me`-as-200 (anonymous) failure
means auth is broken — check the `COGNITO_ISSUER_URI` env on the task against the pool.

## 3. RDS failover / database unreachable (procedure — testing deferred)

**Symptoms:** API logs `connection refused`/`timeout`; `actuator/health` returns 503; ALB 5xx.

**Diagnosis:**

```bash
aws rds describe-db-instances --region $REGION \
  --db-instance-identifier <instance-id> --query 'DBInstances[0].DBInstanceStatus'
aws rds describe-events --region $REGION --duration 60  # last hour of RDS events
```

- `available` + app timeouts → networking: the DB security group must allow 5432 from the
  application SG only. `aws ec2 describe-security-groups --group-ids <db-sg>`.
- `backing-up`/`modifying`/`maintenance` → wait; RDS events name the operation.
- Multi-AZ failover in progress (prod) → the endpoint DNS flips to the standby automatically;
  the app recovers on its own within ~60s. Do not restart the service — connection pools retry.

**Recovery (Multi-AZ, prod):** a failover is *initiated*, not repaired — after a verified failover,
the failed AZ's instance is rebuilt as the standby by AWS. Manually force one for a drill:
`aws rds reboot-db-instance --db-instance-identifier <id> --force-failover` — destructive-ish (a
~60s write outage), which is why the drill is a documented procedure, not an automated step.

## 4. Certificate near expiry / HTTPS warnings

**Symptoms:** browser `NET::ERR_CERT_DATE_INVALID`; ACM console shows `Issued` with an expiry < 30
days, or `Pending validation`.

**Diagnosis/fix:** ACM certificates from this project are DNS-validated *inside the hosted zone
they protect*, so renewal is automatic **as long as the validation CNAME still resolves**. Check
the record exists: `aws acm describe-certificate --certificate-arn <arn>` → `DomainValidationOptions`
→ the `_acm-challenge` name must resolve. If someone deleted the zone's validation record, put it
back; the cert re-validates within minutes. The `us-east-1` Cognito cert follows the same rule.

## 5. Pipeline does not run / self-mutation failed

**Symptoms:** push to `main` produces no execution; `UpdatePipeline`/`SelfMutate` step fails.

**Checks, in order:**

1. **Source connection** — `aws codeconnections list-connections`; status must be `Available`.
   `Pending` means the OAuth handshake was never finished in the console.
2. **Self-mutation failure** — read the `SelfMutate` CodeBuild log. The common cause is a
   synthesized template that fails `--strict` — run the exact synth command locally (README §CI/CD)
   and fix the warning it complains about; never "fix" by removing `--strict`.
3. **Deploy action failed** — the failed action's link opens the CloudFormation stack events in
   the *target account/region* (for uat/prod you must be signed into that account — or the pipeline
   account can't show you the failure).
4. **`ecommerce-ecr` (registry) deploy failed** → the build step's `envFromCfnOutputs` vars are
   unresolved and `BuildImages` fails on a literal `#{...}` token — re-run after the registry is
   healthy.

**Recovery:** fix the cause, push (self-mutation re-runs the whole pipeline), or for a pure
transient: console → the failed stage → *Retry*.

## 6. Budget or anomaly alert fires

**Symptoms:** email from `ecommerce-<env>-alerts`: "Budget Alert" or "Cost Anomaly".

**Diagnosis:**

```bash
# What changed, per service, this month vs last:
aws ce get-cost-and-usage --region us-east-1 \
  --time-period Start=$(date +%Y-%m-01),End=$(date -d "$(date +%Y-%m-01) +1 month" +%F) \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

(Cost Explorer lives in `us-east-1` regardless of the workload region.) Then drill to the
environment: Cost Explorer → group by **Cost Category: Environment** — the `EnvironmentCostCategory`
created by the cost stack makes this a first-class breakdown rather than tag archaeology.

**Most likely causes, ranked:**

1. NAT gateway left running on a paused dev (see PAUSE-RESUME) — ~$32/mo.
2. A resource created outside CDK and forgotten (manually launched instance, leftover ALB).
3. `desiredCount` or instance size raised for a test and never reverted.
4. Legitimate growth — raise `cost.monthlyBudgetUsd` in the env config; the budget is a ceiling
   you chose, not a law.

## 7. Cross-account image pull fails (uat/prod)

**Symptoms:** tasks in uat/prod fail `CannotPullContainerError` even though the image exists in the
shared registry.

**Diagnosis — both sides of the authorization must exist:**

1. **Registry side** — the repository policy on `ecommerce-api`/`ecommerce-frontend` must list the
   environment's account (`pullAccountIds` → `configuredAccountIds()` → `ECOMMERCE_<ENV>_ACCOUNT`
   set at synth). `aws ecr get-repository-policy --repository-name ecommerce-api`.
2. **Environment side** — the task execution role must allow `ecr:BatchGetImage` etc. on the
   repository ARN in the *registry* account; the platform stacks grant it automatically, so a
   failure here means the role was edited outside CDK.

**Fix:** redeploy `ecommerce-ecr` with the missing account in `pullAccountIds` (set the env var
before synth — the pull policy is generated from whichever `ECOMMERCE_*_ACCOUNT` variables exist
at synth time); then redeploy the platform stage.

## 8. "The site is down but nothing above explains it"

Order of elimination (each takes < 2 min):

1. `aws elbv2 describe-target-health` on both target groups — if healthy, it's the app, not infra.
2. Route 53: `dig api.<domain>` — NXDOMAIN means the zone/record is gone, not the service.
3. ALB listener: still forwarding to the expected target groups (a manual console edit sticks).
4. Cognito: the managed-login page loading ≠ auth working; `/me` as the logged-in user is the real
   check (200 + JSON, not a redirect to login).

If all four pass, the failure is in the application itself — `aws logs tail` on both log groups,
and the fix is a code deploy, not an infrastructure action.
