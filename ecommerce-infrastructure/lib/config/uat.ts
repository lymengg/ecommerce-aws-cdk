import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { EnvironmentConfig } from './types';

/**
 * UAT environment: production-like topology at a smaller scale.
 *
 * - Two NAT Gateways, one per Availability Zone, so an AZ failure does not take out outbound
 *   connectivity for the private subnets.
 * - Flow Logs enabled so traffic can be audited before the production rollout.
 * - Resources that support retention are retained on stack deletion; UAT data is not disposable
 *   by accident.
 */
export const uatConfig: EnvironmentConfig = {
  environment: 'uat',
  account: process.env.ECOMMERCE_UAT_ACCOUNT,
  region: 'ap-southeast-1',
  vpcCidr: '10.1.0.0/16',
  maxAzs: 2,
  natGateways: 2,
  removalPolicy: RemovalPolicy.RETAIN,
  flowLogs: {
    enabled: true,
    retention: RetentionDays.ONE_MONTH,
  },
  // Same single-task footprint as dev; UAT validates behaviour, not capacity. Logs are kept longer
  // so a failed acceptance test can still be investigated after the fact.
  application: {
    desiredCount: 1,
    cpu: 512,
    memoryLimitMiB: 1024,
    containerPort: 8080,
    healthCheckPath: '/actuator/health',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.ONE_MONTH,
  },
};
