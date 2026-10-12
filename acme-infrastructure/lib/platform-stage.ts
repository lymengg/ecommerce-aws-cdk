import { Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { EnvironmentConfig } from './config';
import { DnsStack } from './stacks/dns-stack';
import { NetworkStack } from './stacks/network-stack';

export interface PlatformStageProps extends StageProps {
  /** Environment specific configuration. No environment value is hardcoded in this stage. */
  readonly config: EnvironmentConfig;
}

/**
 * The platform team's per-environment foundation: the shared VPC (subnets, NAT, tier security
 * groups) and the public DNS zone + certificate that every service in the environment attaches
 * to. Service stages never deploy these - they import the `acme-<env>-*` exports with
 * `Fn.importValue` and place their own resources inside.
 *
 * Deploy order: this stage must exist before any service stage in the same environment - the
 * imports resolve at deploy time, so a service deploy against a missing export fails fast. In the
 * pipeline the platform stage of an environment is added before its service stage; manually it is
 * `bin/platform.ts` first, `bin/ecommerce.ts` second.
 *
 * Deploy-order contract for DNS: the zone must be delegated before its certificate can finish
 * issuing. After this stack is deployed, copy the HostedZoneNameServers output into NS records at
 * the registrar; ACM then completes the DNS validation on its own.
 */
export class PlatformStage extends Stage {
  public readonly network: NetworkStack;
  public readonly dns: DnsStack;

  constructor(scope: Construct, id: string, props: PlatformStageProps) {
    super(scope, id, props);

    const { config } = props;
    const { environment } = config;
    const env = { account: config.account, region: config.region };

    if (config.dns === undefined) {
      throw new Error(`PlatformStage requires a delegated domain for environment "${environment}".`);
    }

    this.network = new NetworkStack(this, `acme-network-${environment}`, {
      env,
      stackName: `acme-network-${environment}`,
      config,
      description: `Shared environment network foundation (${environment})`,
    });

    // The auth-certificate stack reads the hosted zone id from `us-east-1`; cross-region
    // references hand it over via SSM instead of a CloudFormation export, which cannot cross
    // regions.
    this.dns = new DnsStack(this, `acme-dns-${environment}`, {
      env,
      crossRegionReferences: true,
      stackName: `acme-dns-${environment}`,
      config,
      description: `Shared environment public DNS and TLS certificate (${environment})`,
    });
  }
}
