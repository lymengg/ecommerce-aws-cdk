import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { EnvironmentConfig } from './types';

/**
 * Development environment: the cheapest footprint that still mirrors the production topology.
 *
 * - A single NAT Gateway, so an Availability Zone failure breaks outbound traffic. This is a
 *   deliberate cost decision for dev only; uat and prod are redundant.
 * - Flow Logs disabled to keep CloudWatch ingestion cost at zero.
 * - Resources are destroyable so `cdk destroy` leaves nothing behind.
 */
export const devConfig: EnvironmentConfig = {
  environment: 'dev',
  account: process.env.ECOMMERCE_DEV_ACCOUNT,
  region: 'ap-southeast-1',
  vpcCidr: '10.0.0.0/16',
  maxAzs: 2,
  natGateways: 1,
  removalPolicy: RemovalPolicy.DESTROY,
  flowLogs: {
    enabled: false,
    retention: RetentionDays.ONE_WEEK,
  },
  // One task, the smallest Fargate size that comfortably runs a JVM: 0.5 vCPU and 1 GiB. A single
  // task means a deployment or an AZ failure briefly removes the only instance; that is acceptable
  // for dev and is why production does not share this value.
  application: {
    desiredCount: 1,
    cpu: 512,
    memoryLimitMiB: 1024,
    containerPort: 8080,
    healthCheckPath: '/actuator/health',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.ONE_WEEK,
  },
};
