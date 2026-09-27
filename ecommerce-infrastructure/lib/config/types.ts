import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Environments this application can be deployed to. The name selects which configuration
 * file in `lib/config` is used and is applied to every resource as a tag.
 */
export type EnvironmentName = 'dev' | 'uat' | 'prod';

export const ENVIRONMENT_NAMES: readonly EnvironmentName[] = ['dev', 'uat', 'prod'];

export function isEnvironmentName(value: string): value is EnvironmentName {
  return (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/**
 * VPC Flow Logs are optional because they are billed per GB ingested. They are enabled in the
 * environments where an audit trail of network traffic is worth that cost.
 */
export interface FlowLogsConfig {
  readonly enabled: boolean;
  /** How long flow log events are kept in CloudWatch Logs. */
  readonly retention: RetentionDays;
}

/**
 * Runtime configuration of the containerised application tier (Phase 2).
 *
 * Everything the ECS service, the Fargate task definition and the load balancer need is expressed
 * here, so that no stack contains an environment specific value and the task sizing is a reviewable
 * configuration decision rather than a magic number buried in a construct.
 */
export interface ApplicationConfig {
  /**
   * Number of Fargate tasks the ECS service keeps running. Phase 2 fixes this at 1 everywhere;
   * auto scaling, which varies it at runtime, is a later phase.
   */
  readonly desiredCount: number;

  /** Fargate task CPU units (1024 units = 1 vCPU). Must form a valid Fargate cpu/memory pair. */
  readonly cpu: number;

  /** Fargate task memory in MiB. Must form a valid Fargate cpu/memory pair. */
  readonly memoryLimitMiB: number;

  /** Port the Spring Boot API listens on inside the container. */
  readonly containerPort: number;

  /** Target group health check path, served by Spring Boot Actuator. */
  readonly healthCheckPath: string;

  /**
   * Container image tag the ECS task definition deploys.
   *
   * Only immutable tags belong here: the tag is baked into the task definition, and a mutable tag
   * such as `latest` would make a task replacement deploy a different image than the one reviewed.
   * `resolveImageTag()` rejects `latest` outright. The value can be overridden at deploy time with
   * `-c imageTag=<tag>` or the `IMAGE_TAG` environment variable.
   */
  readonly imageTag: string;

  /** How long ECS container logs are kept in CloudWatch Logs. */
  readonly logRetention: RetentionDays;
}

/**
 * Everything a stack needs to know about the environment it is deployed to.
 *
 * Values are supplied per environment (see `dev.ts`, `uat.ts`, `prod.ts`) so that no stack ever
 * contains environment specific values. This interface must never carry secrets: account ids and
 * regions are identifiers, not credentials, and credentials are resolved by the CDK CLI from the
 * active profile/role at deploy time.
 */
export interface EnvironmentConfig {
  /** Short environment identifier, used for tags, resource names and stack names. */
  readonly environment: EnvironmentName;

  /**
   * Target AWS account, read from the `ECOMMERCE_<ENV>_ACCOUNT` environment variable (see the
   * README for how to set it on PowerShell and bash).
   *
   * Left undefined by default, which makes the stack environment-agnostic: the CDK CLI then resolves
   * the account from the active credentials at deploy time, account ids never end up in source
   * control, and `cdk synth` works without credentials. Pin it per environment before deploying
   * anything other than dev, so `-c environment=prod` cannot target whichever account the current
   * credentials happen to resolve to.
   */
  readonly account?: string;

  /** Target AWS region. */
  readonly region: string;

  /** IPv4 CIDR block of the VPC. Must not overlap with the other environments. */
  readonly vpcCidr: string;

  /** Number of Availability Zones to spread the subnets over. */
  readonly maxAzs: number;

  /**
   * Number of NAT Gateways. 1 is cheap but not AZ redundant, one per Availability Zone is
   * resilient but costs more. 0 disables outbound internet access for private subnets.
   */
  readonly natGateways: number;

  /** Removal policy for resources that support one, such as the flow log group. */
  readonly removalPolicy: RemovalPolicy;

  /** VPC Flow Logs configuration. */
  readonly flowLogs: FlowLogsConfig;

  /** Containerised application tier configuration (Phase 2). */
  readonly application: ApplicationConfig;
}
