import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  IApplicationListener,
  IApplicationLoadBalancer,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { TierSecurityGroups } from '../constructs/tier-security-groups';
import { DNS_EXPORTS, foundationExportName, INGRESS_EXPORTS, NETWORK_EXPORTS } from '../foundation-exports';
import { applyPlatformTags } from '../tags';
import { availabilityZoneTokens } from './network-stack';

export interface EcommerceSecurityStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Everything the service borrows from the platform foundation, and the security groups it owns.
 *
 * This is the attachment point of the service stage: it is the ONLY stack that imports the
 * `acme-<env>-*` exports - the shared VPC (with its subnet lists), the shared hosted zone, and the
 * shared ingress load balancer - because imported constructs must live in a stack scope and
 * keeping every import in one place makes the platform dependency explicit instead of scattered
 * across consumers.
 *
 * Security groups are created here rather than in the platform on purpose: a security group is the
 * service's own rulebook, and sharing the tier groups would let every service in the environment
 * reach every other service's database. The service creates its own `application` / `database`
 * groups in the shared VPC and owns the rules between them - including the rule that admits the
 * *platform's* ingress group, the one shared dependency on the service's perimeter.
 */
export class EcommerceSecurityStack extends Stack {
  /** The shared environment VPC, imported by CloudFormation export. */
  public readonly vpc: IVpc;

  /** The service's own tier security groups inside the shared VPC. */
  public readonly securityGroups: TierSecurityGroups;

  /** The shared public hosted zone, imported by CloudFormation export. */
  public readonly zone: IHostedZone;

  /** The shared ingress load balancer, imported for alias records. */
  public readonly sharedLoadBalancer: IApplicationLoadBalancer;

  /** The shared HTTPS listener every service rule attaches to. */
  public readonly httpsListener: IApplicationListener;

  /** The security group the shared ALB carries; the application group accepts traffic from it. */
  public readonly sharedAlbSecurityGroup: ISecurityGroup;

  /** Fully qualified domain name the API answers on, for example `api.dev.example.com`. */
  public readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: EcommerceSecurityStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { environment, dns } = config;

    if (dns === undefined) {
      throw new Error(`EcommerceSecurityStack requires config.dns for environment "${environment}".`);
    }

    const importValue = (key: string) => Fn.importValue(foundationExportName(environment, key));

    // The subnet lists are exported comma-joined, so each id is selected by index - the list must
    // be `maxAzs` long at synth time or `fromVpcAttributes` cannot pair each subnet with its zone.
    // The count must match the platform's subnet count or the imported mapping is wrong.
    const subnetIds = (exportName: string) => {
      const joined = Fn.split(',', importValue(exportName));
      return Array.from({ length: config.maxAzs }, (_, index) => Fn.select(index, joined));
    };

    this.vpc = Vpc.fromVpcAttributes(this, 'SharedVpc', {
      vpcId: importValue(NETWORK_EXPORTS.vpcId),
      availabilityZones: availabilityZoneTokens(config.maxAzs),
      publicSubnetIds: subnetIds(NETWORK_EXPORTS.publicSubnetIds),
      privateSubnetIds: subnetIds(NETWORK_EXPORTS.privateSubnetIds),
      isolatedSubnetIds: subnetIds(NETWORK_EXPORTS.databaseSubnetIds),
    });

    // The shared ingress: chassis owned by the platform, imported here so the service's own rules
    // (accepting its traffic, hanging rules on its listener, aliasing records to it) land in this
    // stage's templates and not in the platform's.
    this.sharedAlbSecurityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      'SharedAlbSecurityGroup',
      importValue(INGRESS_EXPORTS.securityGroupId),
    );
    this.sharedLoadBalancer = ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, 'SharedLoadBalancer', {
      loadBalancerArn: importValue(INGRESS_EXPORTS.loadBalancerArn),
      securityGroupId: this.sharedAlbSecurityGroup.securityGroupId,
      loadBalancerDnsName: importValue(INGRESS_EXPORTS.loadBalancerDnsName),
      loadBalancerCanonicalHostedZoneId: importValue(INGRESS_EXPORTS.loadBalancerCanonicalHostedZoneId),
    });
    this.httpsListener = ApplicationListener.fromApplicationListenerAttributes(this, 'SharedHttpsListener', {
      listenerArn: importValue(INGRESS_EXPORTS.httpsListenerArn),
      securityGroup: this.sharedAlbSecurityGroup,
    });

    this.securityGroups = new TierSecurityGroups(this, 'SecurityGroups', {
      vpc: this.vpc,
      albSecurityGroup: this.sharedAlbSecurityGroup,
    });

    // zoneName comes from configuration, not an export: it is a known value (dev.example.com),
    // only the zone id is a deploy-time fact.
    this.zone = HostedZone.fromHostedZoneAttributes(this, 'SharedZone', {
      hostedZoneId: importValue(DNS_EXPORTS.hostedZoneId),
      zoneName: dns.zoneName,
    });
    this.apiDomainName = `${dns.apiSubdomain}.${dns.zoneName}`;

    applyPlatformTags(this, config);
  }
}
