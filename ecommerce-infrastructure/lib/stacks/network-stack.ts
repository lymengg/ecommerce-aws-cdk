import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { IpAddresses, ISubnet, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { TierSecurityGroups } from '../constructs/tier-security-groups';
import { VpcFlowLogs } from '../constructs/vpc-flow-logs';
import { applyPlatformTags } from '../tags';

/** CIDR mask for every subnet. /24 leaves 254 usable addresses per subnet. */
const SUBNET_CIDR_MASK = 24;

/**
 * Availability Zone tokens for the first `count` zones of the deployment region.
 *
 * `maxAzs` is deliberately not used. When a stack's environment is not fully resolved - and it is not
 * by default here, because account ids are never pinned in source - CDK falls back to exactly two
 * Availability Zones (`firstTwoAgnosticAzs()` in `aws-cdk-lib/core/lib/stack.js`). A production
 * `maxAzs: 3` therefore silently produced a two zone VPC with two NAT Gateways instead of three, and
 * the difference only showed up in the deployed infrastructure.
 *
 * Passing the zones explicitly - the same `Fn::Select(i, Fn::GetAZs)` construction CDK uses for that
 * fallback - makes the configured zone count the deployed zone count, with or without credentials,
 * and leaves CloudFormation to resolve the real zone names at deploy time. It also keeps the template
 * region independent, so a region change is a one line configuration change.
 */
function availabilityZoneTokens(count: number): string[] {
  return Array.from({ length: count }, (_, index) => Fn.select(index, Fn.getAzs()));
}

/** Props of the network stack. */
export interface NetworkStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Phase 1 network foundation for the e-commerce platform.
 *
 * Creates the VPC, public and private subnets spread over the configured Availability Zones, the
 * internet and NAT gateways with the route tables that connect them, and the three tier security
 * groups that later phases attach their resources to. It deliberately creates no compute, database
 * or load balancer resources: those are Phase 2 and will be added as separate stacks that consume
 * this stack's outputs.
 */
export class NetworkStack extends Stack {
  /** The VPC every later stack places its resources in. */
  public readonly vpc: Vpc;

  /** Security groups for the ALB, application and database tiers. */
  public readonly securityGroups: TierSecurityGroups;

  /** Public subnets, one per Availability Zone. Host internet facing resources (ALB, NAT). */
  public readonly publicSubnets: ISubnet[];

  /** Private subnets, one per Availability Zone. Host application and data resources. */
  public readonly privateSubnets: ISubnet[];

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vpc = new Vpc(this, 'Vpc', {
      vpcName: `ecommerce-${config.environment}`,
      ipAddresses: IpAddresses.cidr(config.vpcCidr),
      // `availabilityZones` instead of `maxAzs`: CDK accepts one or the other, never both, and only
      // the explicit list guarantees the configured zone count. See availabilityZoneTokens().
      availabilityZones: availabilityZoneTokens(config.maxAzs),
      natGateways: config.natGateways,
      // DNS resolution and hostnames are required for RDS endpoints, interface VPC endpoints and
      // ECS service discovery in later phases, so they are enabled from the start.
      enableDnsSupport: true,
      enableDnsHostnames: true,
      // The VPC default security group is never used by our resources; keep it rule free so
      // anything that accidentally lands in it has no connectivity at all.
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: SUBNET_CIDR_MASK,
          // Load balancers and NAT Gateways do not need a public IP on their network interface.
          // Leaving this off means an instance launched here by mistake is not reachable from the
          // internet, and no elastic IP is consumed implicitly.
          mapPublicIpOnLaunch: false,
        },
        {
          // PRIVATE_WITH_EGRESS: no inbound route from the internet, outbound via a NAT Gateway.
          name: 'private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: SUBNET_CIDR_MASK,
        },
      ],
    });

    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;

    this.securityGroups = new TierSecurityGroups(this, 'SecurityGroups', { vpc: this.vpc });

    if (config.flowLogs.enabled) {
      new VpcFlowLogs(this, 'FlowLogs', {
        vpc: this.vpc,
        retention: config.flowLogs.retention,
        removalPolicy: config.removalPolicy,
      });
    }

    this.applyTags(config);
    this.createOutputs(config);
  }

  /**
   * Applies the shared tag contract at stack level, so the network stack and the later application
   * stacks tag their resources identically. See lib/tags.ts.
   */
  private applyTags(config: EnvironmentConfig): void {
    applyPlatformTags(this, config);
  }

  /**
   * Publishes the contract later stacks consume. Export names are environment specific so that a
   * dev, uat and prod stack can coexist in one account without clashing.
   */
  private createOutputs(config: EnvironmentConfig): void {
    const exportPrefix = `ecommerce-${config.environment}`;

    new CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'Id of the VPC',
      exportName: `${exportPrefix}-vpc-id`,
    });

    new CfnOutput(this, 'PublicSubnetIds', {
      value: Fn.join(',', this.publicSubnets.map((subnet) => subnet.subnetId)),
      description: 'Comma separated ids of the public subnets, one per Availability Zone',
      exportName: `${exportPrefix}-public-subnet-ids`,
    });

    new CfnOutput(this, 'PrivateSubnetIds', {
      value: Fn.join(',', this.privateSubnets.map((subnet) => subnet.subnetId)),
      description: 'Comma separated ids of the private subnets, one per Availability Zone',
      exportName: `${exportPrefix}-private-subnet-ids`,
    });

    new CfnOutput(this, 'AlbSecurityGroupId', {
      value: this.securityGroups.alb.securityGroupId,
      description: 'Security group for the Application Load Balancer tier',
      exportName: `${exportPrefix}-alb-security-group-id`,
    });

    new CfnOutput(this, 'ApplicationSecurityGroupId', {
      value: this.securityGroups.application.securityGroupId,
      description: 'Security group for the application tier (ECS tasks)',
      exportName: `${exportPrefix}-application-security-group-id`,
    });

    new CfnOutput(this, 'DatabaseSecurityGroupId', {
      value: this.securityGroups.database.securityGroupId,
      description: 'Security group for the database tier (RDS, ElastiCache)',
      exportName: `${exportPrefix}-database-security-group-id`,
    });
  }
}
